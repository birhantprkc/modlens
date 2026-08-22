import { describe, expect, it } from 'vitest';
import { splitApiKeys } from './apiKeys.ts';

describe('splitApiKeys', () => {
    it('trims comma-separated keys, preserves order, and drops empty items', () => {
        expect(splitApiKeys(' first-key , , second-key,,third-key ')).toEqual([
            'first-key',
            'second-key',
            'third-key',
        ]);
        expect(splitApiKeys(', ,')).toEqual([]);
        expect(splitApiKeys(undefined)).toEqual([]);
    });

    it('returns an empty list for a non-string value', () => {
        expect(splitApiKeys(null)).toEqual([]);
        expect(splitApiKeys(42 as unknown as string)).toEqual([]);
    });
});
