// Node 24's AbortError is a DOMException whose `message` is getter-only.
// Assigning `error.message = ...` then throws TypeError, which used to crash
// failover and leave the original failure as an uncaught exception. Rewrite
// the property in place instead of wrapping a new Error, so instanceof checks
// (quota classification) still see the original object.

export function setErrorMessage(error: Error, message: string): void {
    try {
        error.message = message;
    } catch (caught) {
        if (!(caught instanceof TypeError)) {
            throw caught;
        }
        Object.defineProperty(error, 'message', {
            value: message,
            configurable: true,
            writable: true,
        });
    }
}
