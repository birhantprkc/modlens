import { describe, expect, it } from 'vitest';
import { setErrorMessage } from './error.ts';

// Skip the real DOMException case only if a future Node makes its message
// writable. The getter-only simulation below stays the portable regression
// for issue #85.
let abortAssignThrows = false;
try {
    const probe = new DOMException('The operation was aborted.', 'AbortError');
    // Typed as readonly on DOMException. The runtime assignment is the bug.
    (probe as Error).message = 'x';
} catch (caught) {
    abortAssignThrows = caught instanceof TypeError;
}

describe('setErrorMessage', () => {
    it('updates a writable Error message in place', () => {
        const error = new Error('old');
        expect(() => setErrorMessage(error, 'new')).not.toThrow();
        expect(error.message).toBe('new');
    });

    it('replaces a getter-only message on the same Error (issue #85)', () => {
        const error = new Error('placeholder');
        Object.defineProperty(error, 'message', {
            get: () => 'orig',
            configurable: true,
        });
        const sameRef = error;
        expect(() => setErrorMessage(error, 'updated')).not.toThrow();
        expect(error.message).toBe('updated');
        expect(error).toBe(sameRef);
    });

    it.skipIf(!abortAssignThrows)(
        'updates a real AbortError DOMException whose message is getter-only (issue #85)',
        () => {
            const error = new DOMException('The operation was aborted.', 'AbortError');
            expect(() => {
                (error as Error).message = 'x';
            }).toThrow(TypeError);
            const sameRef = error;
            expect(() => setErrorMessage(error, 'redacted abort')).not.toThrow();
            expect(error.message).toBe('redacted abort');
            expect(error).toBe(sameRef);
        },
    );
});
