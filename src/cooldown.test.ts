import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildCooldownController,
    classifyQuota,
    clearAllCooldowns,
    clearEngineCooldown,
    cooldownStateKey,
    coolingEntry,
    DEFAULT_COOLDOWN_MS,
    emptyCooldownState,
    isEngineCooling,
    loadCooldownState,
    MONTHLY_COOLDOWN_MS,
    parseResetDuration,
    recordQuotaCooldown,
} from './cooldown.ts';
import { ApiKeyFailureError } from './util/apiKeys.ts';

const tempDirs: string[] = [];
afterEach(() => {
    while (tempDirs.length > 0) {
        fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
});

function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function expectPosixMode(filePath: string, expected: number): void {
    if (process.platform === 'win32') {
        return;
    }
    expect(fs.statSync(filePath).mode & 0o777).toBe(expected);
}

const statePath = () => path.join(tempDir('modlens-state-'), 'state.json');
const at = (iso: string) => new Date(iso);

describe('cooldown state file', () => {
    it('reads a missing file as empty state, never throwing', () => {
        expect(loadCooldownState(statePath())).toEqual(emptyCooldownState());
    });

    it('treats a corrupt state file as empty, silently', () => {
        const p = statePath();
        fs.writeFileSync(p, '{not json at all');
        expect(loadCooldownState(p)).toEqual({ engineCooldowns: {} });
    });

    it('drops malformed entries but keeps well-formed ones', () => {
        const p = statePath();
        fs.writeFileSync(
            p,
            JSON.stringify({
                engineCooldowns: {
                    openai: {
                        until: '2999-01-01T00:00:00.000Z',
                        reason: 'spent',
                        observedAt: '2026-01-01T00:00:00.000Z',
                    },
                    broken: { reason: 'no until' },
                    alsoBroken: 42,
                },
            }),
        );
        const state = loadCooldownState(p);
        expect(Object.keys(state.engineCooldowns)).toEqual(['openai']);
    });

    it('folds a legacy provider alias (agy) onto its canonical name (antigravity-cli) on read', () => {
        const p = statePath();
        fs.writeFileSync(
            p,
            JSON.stringify({
                engineCooldowns: {
                    agy: {
                        until: '2999-01-01T00:00:00.000Z',
                        reason: 'x',
                        observedAt: '2026-01-01T00:00:00.000Z',
                    },
                    openai: {
                        until: '2999-01-01T00:00:00.000Z',
                        reason: 'y',
                        observedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            }),
        );
        const state = loadCooldownState(p);
        expect(Object.keys(state.engineCooldowns).sort()).toEqual(['antigravity-cli', 'openai']);
    });

    it('applies a legacy provider-level cooldown to every configured key without dropping it', () => {
        const p = statePath();
        fs.writeFileSync(
            p,
            JSON.stringify({
                engineCooldowns: {
                    'gemini-api': {
                        until: '2999-01-01T00:00:00.000Z',
                        reason: 'spent before per-key cooldowns existed',
                        observedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            }),
        );

        const state = loadCooldownState(p);
        const now = at('2026-08-06T00:00:00.000Z');
        expect(Object.keys(state.engineCooldowns)).toEqual(['gemini-api']);
        expect(coolingEntry(state, 'gemini-api', now, 0)).toBeDefined();
        expect(coolingEntry(state, 'gemini-api', now, 1)).toBeDefined();
    });

    it('normalizes the provider portion of a per-key cooldown without losing its key index', () => {
        const p = statePath();
        fs.writeFileSync(
            p,
            JSON.stringify({
                engineCooldowns: {
                    'agy::key:1': {
                        until: '2999-01-01T00:00:00.000Z',
                        reason: 'spent',
                        observedAt: '2026-01-01T00:00:00.000Z',
                    },
                },
            }),
        );

        const state = loadCooldownState(p);
        expect(Object.keys(state.engineCooldowns)).toEqual(['antigravity-cli::key:1']);
    });

    it('writes 0600 and round-trips through a record', () => {
        const p = statePath();
        const state = emptyCooldownState();
        recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            at('2026-08-06T00:00:00.000Z'),
            p,
        );
        expectPosixMode(p, 0o600);
        const reloaded = loadCooldownState(p);
        expect(reloaded.engineCooldowns['gemini-api'].reason).toContain('out of credits');
    });
});

describe('parseResetDuration', () => {
    it('parses the agy full h/m/s form', () => {
        expect(parseResetDuration('Resets in 94h19m9s')).toBe((94 * 3600 + 19 * 60 + 9) * 1000);
    });

    it('parses partial forms', () => {
        expect(parseResetDuration('Resets in 45m')).toBe(45 * 60 * 1000);
        expect(parseResetDuration('resets in 2h')).toBe(2 * 3600 * 1000);
    });

    it('returns null when there is no reset clause', () => {
        expect(parseResetDuration('out of credits')).toBeNull();
    });
});

describe('classifyQuota', () => {
    const now = at('2026-08-06T00:00:00.000Z');

    it('parses a precise reset from a Resets in clause', () => {
        const until = classifyQuota(
            new ApiKeyFailureError('quota. Resets in 94h19m9s', {
                quotaCooldown: 'default',
                resetAfterMs: (94 * 3600 + 19 * 60 + 9) * 1000,
            }),
            now,
        );
        expect(until).not.toBeNull();
        expect((until as Date).getTime() - now.getTime()).toBe((94 * 3600 + 19 * 60 + 9) * 1000);
    });

    it('falls back to a 45-minute TTL for a quota error with no reset time', () => {
        const until = classifyQuota(
            new ApiKeyFailureError('gemini-api is out of credits: insufficient balance', {
                quotaCooldown: 'default',
            }),
            now,
        );
        expect((until as Date).getTime() - now.getTime()).toBe(DEFAULT_COOLDOWN_MS);
    });

    it.each([432, 433])('holds a monthly-cap %i for 24 hours, not 45 minutes', (status) => {
        const until = classifyQuota(
            new ApiKeyFailureError(`provider is out of monthly quota (HTTP ${status}).`, {
                quotaCooldown: 'monthly',
            }),
            now,
        );
        expect((until as Date).getTime() - now.getTime()).toBe(MONTHLY_COOLDOWN_MS);
    });

    it('does not persist a per-second rate limit', () => {
        expect(
            classifyQuota(new Error('gemini-api returned 429 Too Many Requests: rate limit'), now),
        ).toBeNull();
    });

    it('ignores errors that are not about quota', () => {
        expect(classifyQuota(new Error('gemini-api rejected the API key (401)'), now)).toBeNull();
        expect(classifyQuota(new Error('request timed out after 1000 ms'), now)).toBeNull();
    });

    it('does not classify a plain Error even when the message says quota', () => {
        expect(classifyQuota(new Error('quota service temporarily unavailable'), now)).toBeNull();
    });

    it('holds a monthly 432 for 24 hours from the error class, not the letters HTTP', () => {
        const until = classifyQuota(
            new ApiKeyFailureError('API error 432', { quotaCooldown: 'monthly' }),
            now,
        );
        expect((until as Date).getTime() - now.getTime()).toBe(MONTHLY_COOLDOWN_MS);
    });

    it('does not persist an ApiKeyFailureError marked none', () => {
        expect(
            classifyQuota(
                new ApiKeyFailureError('quota exceeded (401)', { quotaCooldown: 'none' }),
                now,
            ),
        ).toBeNull();
    });
});

describe('cooling window', () => {
    it('is cooling while until is in the future and not once it passes', () => {
        const p = statePath();
        const state = emptyCooldownState();
        const now = at('2026-08-06T00:00:00.000Z');
        recordQuotaCooldown(
            state,
            'openai',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );

        expect(isEngineCooling(state, 'openai', at('2026-08-06T00:30:00.000Z'))).toBe(true);
        expect(isEngineCooling(state, 'openai', at('2026-08-06T01:00:00.001Z'))).toBe(false);
        expect(isEngineCooling(state, 'gemini-api', now)).toBe(false);
        expect(coolingEntry(state, 'openai', now)?.reason).toContain('out of credits');
    });
});

describe('recording and clearing', () => {
    const now = at('2026-08-06T00:00:00.000Z');

    it('redacts known shapeless keys into the persisted reason', () => {
        const p = statePath();
        const state = emptyCooldownState();
        recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('quota for second-key-bbbb', { quotaCooldown: 'default' }),
            now,
            p,
            undefined,
            0,
            ['first-key-aaaa', 'second-key-bbbb'],
        );
        const persisted = fs.readFileSync(p, 'utf-8');
        expect(persisted).not.toContain('second-key-bbbb');
        expect(persisted).not.toContain('first-key-aaaa');
        expect(persisted).toContain('[redacted]');
    });

    it('records only quota errors, returning the entry, and skips others', () => {
        const p = statePath();
        const state = emptyCooldownState();
        expect(recordQuotaCooldown(state, 'gemini-api', new Error('timed out'), now, p)).toBeNull();
        expect(fs.existsSync(p)).toBe(false);

        const entry = recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        expect(entry).not.toBeNull();
        expect(entry?.observedAt).toBe(now.toISOString());
        expect(fs.existsSync(p)).toBe(true);
    });

    it('clears one provider and reports whether anything changed', () => {
        const p = statePath();
        const state = emptyCooldownState();
        recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        expect(clearEngineCooldown(state, 'gemini-api', p)).toBe(true);
        expect(state.engineCooldowns['gemini-api']).toBeUndefined();
        expect(loadCooldownState(p).engineCooldowns['gemini-api']).toBeUndefined();
        expect(clearEngineCooldown(state, 'gemini-api', p)).toBe(false);
    });

    it('records and clears quota cooldowns independently by key index', () => {
        const p = statePath();
        const state = emptyCooldownState();
        recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
            undefined,
            0,
        );
        recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
            undefined,
            1,
        );

        const first = cooldownStateKey('gemini-api', 0);
        const second = cooldownStateKey('gemini-api', 1);
        expect(Object.keys(state.engineCooldowns).sort()).toEqual([first, second]);
        expect(coolingEntry(state, 'gemini-api', now, 0)).toBeDefined();
        expect(coolingEntry(state, 'gemini-api', now, 1)).toBeDefined();

        expect(clearEngineCooldown(state, 'gemini-api', p, undefined, 0)).toBe(true);
        expect(loadCooldownState(p).engineCooldowns[first]).toBeUndefined();
        expect(loadCooldownState(p).engineCooldowns[second]).toBeDefined();
    });

    it('wipes the whole state file', () => {
        const p = statePath();
        const state = emptyCooldownState();
        recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        clearAllCooldowns(p);
        expect(fs.existsSync(p)).toBe(false);
        expect(loadCooldownState(p)).toEqual(emptyCooldownState());
    });
});

describe('concurrent writes merge instead of clobbering', () => {
    const now = at('2026-08-06T00:00:00.000Z');

    it('keeps both providers when two processes record different ones', () => {
        const p = statePath();
        const procA = emptyCooldownState();
        const procB = emptyCooldownState();
        recordQuotaCooldown(
            procA,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        recordQuotaCooldown(
            procB,
            'openai',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        const disk = loadCooldownState(p);
        expect(Object.keys(disk.engineCooldowns).sort()).toEqual(['gemini-api', 'openai']);
    });

    it('keeps the later until when the same provider is recorded twice', () => {
        const p = statePath();
        recordQuotaCooldown(
            emptyCooldownState(),
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        const short = loadCooldownState(p).engineCooldowns['gemini-api'].until;
        recordQuotaCooldown(
            emptyCooldownState(),
            'gemini-api',
            new ApiKeyFailureError('quota. Resets in 94h19m9s', {
                quotaCooldown: 'default',
                resetAfterMs: (94 * 3600 + 19 * 60 + 9) * 1000,
            }),
            now,
            p,
        );
        const long = loadCooldownState(p).engineCooldowns['gemini-api'].until;
        expect(Date.parse(long)).toBeGreaterThan(Date.parse(short));
        recordQuotaCooldown(
            emptyCooldownState(),
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        expect(loadCooldownState(p).engineCooldowns['gemini-api'].until).toBe(long);
    });

    it("clearing one provider leaves another process's record intact", () => {
        const p = statePath();
        const procA = emptyCooldownState();
        const procB = emptyCooldownState();
        recordQuotaCooldown(
            procA,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        recordQuotaCooldown(
            procB,
            'openai',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            now,
            p,
        );
        expect(clearEngineCooldown(procA, 'gemini-api', p)).toBe(true);
        expect(Object.keys(loadCooldownState(p).engineCooldowns)).toEqual(['openai']);
    });
});

describe('buildCooldownController switch', () => {
    const now = at('2026-08-06T00:00:00.000Z');

    it('returns nothing and touches no file when the switch is off', () => {
        const p = statePath();
        const controller = buildCooldownController({ cooldown: 'off' }, { now, statePath: p });
        expect(controller).toBeUndefined();
        expect(fs.existsSync(p)).toBe(false);
    });

    it('builds a working controller when the switch is on (the default)', () => {
        const p = statePath();
        const controller = buildCooldownController({}, { now, statePath: p });
        expect(controller).toBeDefined();
        const entry = controller?.record(
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
        );
        expect(entry).not.toBeNull();
        expect(loadCooldownState(p).engineCooldowns['gemini-api']).toBeDefined();
        controller?.clear('gemini-api');
        expect(loadCooldownState(p).engineCooldowns['gemini-api']).toBeUndefined();
    });
});

describe('the cache never breaks the run, and clear always reaches the disk', () => {
    it('clears an on-disk cooldown this snapshot never saw (stale-snapshot clear)', () => {
        const p = statePath();
        const stale = loadCooldownState(p);
        recordQuotaCooldown(
            emptyCooldownState(),
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            at('2026-08-07T00:00:00Z'),
            p,
        );
        expect(loadCooldownState(p).engineCooldowns['gemini-api']).toBeDefined();
        clearEngineCooldown(stale, 'gemini-api', p);
        expect(loadCooldownState(p).engineCooldowns['gemini-api']).toBeUndefined();
    });

    it('keeps the cooldown in memory and reports, instead of throwing, when the state cannot be written', () => {
        const dir = tempDir('modlens-badstate-');
        const blocker = path.join(dir, 'blocker');
        fs.writeFileSync(blocker, 'a plain file');
        const p = path.join(blocker, 'nested', 'state.json');
        const state = emptyCooldownState();
        const persistErrors: unknown[] = [];
        const entry = recordQuotaCooldown(
            state,
            'gemini-api',
            new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
            at('2026-08-07T00:00:00Z'),
            p,
            (persistError) => persistErrors.push(persistError),
        );
        expect(entry).not.toBeNull();
        expect(state.engineCooldowns['gemini-api']).toBeDefined();
        expect(persistErrors).toHaveLength(1);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
        'clear survives an unwritable state dir: memory cleared, miss reported, no throw',
        () => {
            const dir = tempDir('modlens-rostate-');
            const p = path.join(dir, 'state.json');
            recordQuotaCooldown(
                emptyCooldownState(),
                'gemini-api',
                new ApiKeyFailureError('out of credits', { quotaCooldown: 'default' }),
                at('2026-08-07T00:00:00Z'),
                p,
            );
            const state = loadCooldownState(p);
            fs.chmodSync(dir, 0o500);
            try {
                const persistErrors: unknown[] = [];
                expect(() =>
                    clearEngineCooldown(state, 'gemini-api', p, (persistError) =>
                        persistErrors.push(persistError),
                    ),
                ).not.toThrow();
                expect(state.engineCooldowns['gemini-api']).toBeUndefined();
                expect(persistErrors).toHaveLength(1);
            } finally {
                fs.chmodSync(dir, 0o700);
            }
        },
    );

    it('state clear surfaces a delete that failed instead of pretending success', () => {
        const dir = tempDir('modlens-cleardir-');
        const p = path.join(dir, 'state-dir');
        fs.mkdirSync(path.join(p, 'child'), { recursive: true });
        expect(() => clearAllCooldowns(p)).toThrow();
    });

    it('skips the write when nothing changed, so a quiet clear touches no file', () => {
        const p = statePath();
        clearEngineCooldown(emptyCooldownState(), 'gemini-api', p);
        expect(fs.existsSync(p)).toBe(false);
    });
});
