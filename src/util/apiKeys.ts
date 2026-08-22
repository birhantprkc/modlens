/** Parse the API-key setting shared by file and environment configuration. */
export function splitApiKeys(value: string | undefined | null): string[] {
    if (typeof value !== 'string') {
        return [];
    }
    return value
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key.length > 0);
}

export type QuotaCooldownKind = 'none' | 'default' | 'monthly';

/** An authentication, rate-limit, or quota failure tied to the selected key. */
export class ApiKeyFailureError extends Error {
    readonly quotaCooldown: QuotaCooldownKind;
    readonly resetAfterMs: number | null;
    constructor(
        message: string,
        opts?: { quotaCooldown?: QuotaCooldownKind; resetAfterMs?: number | null },
    ) {
        super(message);
        this.name = 'ApiKeyFailureError';
        this.quotaCooldown = opts?.quotaCooldown ?? 'none';
        this.resetAfterMs = opts?.resetAfterMs ?? null;
    }
}

export function isApiKeyFailure(error: unknown): error is ApiKeyFailureError {
    return error instanceof ApiKeyFailureError;
}

const QUOTA_FAILURE_PATTERNS = [
    /\bquota\b/i,
    /\bpayment required\b/i,
    /\b(?:out of|insufficient|not enough)\s+(?:account\s+)?(?:balance|credits?)\b/i,
    /\b(?:balance|credits?)\s+(?:is\s+)?(?:insufficient|exhausted|depleted|empty|too low|used up)\b/i,
    /\b(?:credit|usage)\s+(?:limit|cap)\s+(?:reached|exceeded)\b/i,
];

/** Whether foreign response text specifically describes an exhausted quota. */
export function isQuotaFailureMessage(message: string): boolean {
    return QUOTA_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Parse an agy-style "Resets in 94h19m9s" clause to milliseconds, or null. */
export function parseResetDuration(message: string): number | null {
    const match = /Resets? in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(message);
    if (!match || (!match[1] && !match[2] && !match[3])) {
        return null;
    }
    const hours = Number.parseInt(match[1] ?? '0', 10);
    const minutes = Number.parseInt(match[2] ?? '0', 10);
    const seconds = Number.parseInt(match[3] ?? '0', 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Classify an HTTP error after status and body are known. `detail` is the
 * full redacted body. `message` is display-only and may already be clipped.
 */
export function errorFromApiStatus(status: number, message: string, detail = ''): Error {
    const resetAfterMs = parseResetDuration(detail);
    if (status >= 500) {
        return new Error(message);
    }
    if (status === 432 || status === 433) {
        return new ApiKeyFailureError(message, { quotaCooldown: 'monthly', resetAfterMs });
    }
    if (status === 401 || status === 403 || status === 429 || isQuotaFailureMessage(detail)) {
        const quotaClass = isQuotaFailureMessage(detail) || resetAfterMs !== null;
        return new ApiKeyFailureError(message, {
            quotaCooldown: quotaClass ? 'default' : 'none',
            resetAfterMs,
        });
    }
    return new Error(message);
}
