import { jest } from '@jest/globals';
import fs from 'fs';
import { setupShamirRecovery } from './recovery.js';

// Mock writeFileSync on the actual fs module
jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

describe('setupShamirRecovery', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('throws an error if threshold is less than 2', () => {
        expect(() => setupShamirRecovery('mypassword', 1, 3)).toThrow('Threshold must be at least 2.');
        expect(() => setupShamirRecovery('mypassword', 0, 3)).toThrow('Threshold must be at least 2.');
        expect(() => setupShamirRecovery('mypassword', -1, 3)).toThrow('Threshold must be at least 2.');
    });

    it('throws an error if total shares is less than threshold', () => {
        expect(() => setupShamirRecovery('mypassword', 3, 2)).toThrow('Total shares must be >= threshold.');
        expect(() => setupShamirRecovery('mypassword', 5, 4)).toThrow('Total shares must be >= threshold.');
    });

    it('generates shares and writes metadata on success', () => {
        const password = 'mySecretPassword123!';
        const threshold = 3;
        const totalShares = 5;

        const result = setupShamirRecovery(password, threshold, totalShares);

        // Verify the shares structure
        expect(result).toHaveProperty('shares');
        expect(Array.isArray(result.shares)).toBe(true);
        expect(result.shares).toHaveLength(totalShares);

        // Ensure each share is a hex string
        result.shares.forEach(share => {
            expect(typeof share).toBe('string');
            expect(/^[0-9a-f]+$/i.test(share)).toBe(true);
        });

        // Verify that fs.writeFileSync was called with correct metadata
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);

        const [filePath, fileContent] = fs.writeFileSync.mock.calls[0];

        // Ensure the path is a string
        expect(typeof filePath).toBe('string');
        expect(filePath.length).toBeGreaterThan(0);

        const parsedContent = JSON.parse(fileContent);
        expect(parsedContent).toEqual({
            threshold,
            totalShares
        });

        // Explicitly check that the password isn't in the saved data
        expect(fileContent).not.toContain(password);
    });
});
