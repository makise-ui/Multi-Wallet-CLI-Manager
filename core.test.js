import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ethers } from 'ethers';
import * as core from './core.js';
import * as drive from './drive.js';

vi.mock('fs');
vi.mock('./drive.js', () => ({
    triggerBackup: vi.fn()
}));
vi.mock('ethers', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        ethers: {
            ...actual.ethers,
            Wallet: {
                fromEncryptedJson: vi.fn()
            },
            JsonRpcProvider: vi.fn(function () {
                return {
                    getBalance: vi.fn()
                };
            }),
            formatEther: vi.fn()
        }
    };
});

describe('core.js', () => {
    const CONFIG_DIR = path.join(os.homedir(), '.my-cli-wallet');
    const WALLETS_FILE = path.join(CONFIG_DIR, 'my_wallets.json');
    const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset state
        core.USER_SETTINGS.currency = 'USD';
        core.USER_SETTINGS.defaultNetwork = 'ethereum';
        core.USER_SETTINGS.gasLimitBuffer = '0';
        core.USER_SETTINGS.backupMethod = null;
        core.USER_SETTINGS.rcloneRemote = null;
        core.USER_SETTINGS.savedTokens = [];
        core.DECRYPTED_WALLETS.length = 0;
    });

    describe('loadSettings', () => {
        it('should load settings from file if it exists', () => {
            const mockSettings = { currency: 'EUR', savedTokens: [] };
            fs.existsSync.mockReturnValueOnce(true);
            fs.readFileSync.mockReturnValueOnce(JSON.stringify(mockSettings));

            const settings = core.loadSettings();

            expect(fs.existsSync).toHaveBeenCalledWith(SETTINGS_FILE);
            expect(fs.readFileSync).toHaveBeenCalledWith(SETTINGS_FILE, 'utf8');
            expect(settings.currency).toBe('EUR');
        });

        it('should ensure savedTokens is an array if missing in file', () => {
            const mockSettings = { currency: 'GBP' }; // No savedTokens
            fs.existsSync.mockReturnValueOnce(true);
            fs.readFileSync.mockReturnValueOnce(JSON.stringify(mockSettings));

            const settings = core.loadSettings();

            expect(settings.savedTokens).toEqual([]);
        });

        it('should return default settings if file does not exist', () => {
            fs.existsSync.mockReturnValueOnce(false);

            const settings = core.loadSettings();

            expect(fs.existsSync).toHaveBeenCalledWith(SETTINGS_FILE);
            expect(settings.currency).toBe('USD'); // Default
        });
    });

    describe('saveSettings', () => {
        it('should save settings to file and trigger backup', () => {
            const newSettings = { currency: 'JPY' };

            core.saveSettings(newSettings);

            expect(fs.writeFileSync).toHaveBeenCalledWith(SETTINGS_FILE, expect.any(String));
            expect(drive.triggerBackup).toHaveBeenCalledWith(expect.objectContaining({ currency: 'JPY' }));
            expect(core.USER_SETTINGS.currency).toBe('JPY');
        });
    });

    describe('hasEncryptedWallets', () => {
        it('should return false if wallets file does not exist', () => {
            fs.existsSync.mockReturnValueOnce(false);
            expect(core.hasEncryptedWallets()).toBe(false);
        });

        it('should return true if wallets file exists and has items', () => {
            fs.existsSync.mockReturnValueOnce(true);
            fs.readFileSync.mockReturnValueOnce(JSON.stringify([{ data: 'enc' }]));
            expect(core.hasEncryptedWallets()).toBe(true);
        });

        it('should return false if wallets file exists but is empty', () => {
            fs.existsSync.mockReturnValueOnce(true);
            fs.readFileSync.mockReturnValueOnce(JSON.stringify([]));
            expect(core.hasEncryptedWallets()).toBe(false);
        });
    });

    describe('unlockWallets', () => {
        it('should return empty array if wallets file does not exist', async () => {
            fs.existsSync.mockReturnValueOnce(false);
            const wallets = await core.unlockWallets('password');
            expect(wallets).toEqual([]);
        });

        it('should throw error if legacy wallets are found', async () => {
            fs.existsSync.mockReturnValueOnce(true);
            fs.readFileSync.mockReturnValueOnce(JSON.stringify([{ privateKey: '0x123' }]));

            await expect(core.unlockWallets('password')).rejects.toThrow("Legacy plain-text wallets found. Please run CLI to migrate.");
        });

        it('should decrypt wallets successfully', async () => {
            fs.existsSync.mockReturnValueOnce(true);
            fs.readFileSync.mockReturnValueOnce(JSON.stringify([{ name: 'Test', data: 'encrypted-data' }]));

            const mockWallet = { address: '0xabc' };
            ethers.Wallet.fromEncryptedJson.mockResolvedValueOnce(mockWallet);

            const wallets = await core.unlockWallets('password');

            expect(ethers.Wallet.fromEncryptedJson).toHaveBeenCalledWith('encrypted-data', 'password');
            expect(wallets).toHaveLength(1);
            expect(wallets[0].name).toBe('Test');
            expect(wallets[0].wallet).toBe(mockWallet);
            expect(core.DECRYPTED_WALLETS).toEqual(wallets);
        });
    });

    describe('getPrice', () => {
        let originalFetch;

        beforeEach(() => {
            originalFetch = global.fetch;
            global.fetch = vi.fn();
        });

        afterEach(() => {
            global.fetch = originalFetch;
        });

        it('should return 0 if coingeckoId is not provided', async () => {
            const price = await core.getPrice(null);
            expect(price).toBe(0);
        });

        it('should fetch and return price successfully', async () => {
            core.USER_SETTINGS.currency = 'usd';
            const mockResponse = { ethereum: { usd: 2000 } };
            global.fetch.mockResolvedValueOnce({
                json: vi.fn().mockResolvedValueOnce(mockResponse)
            });

            const price = await core.getPrice('ethereum');

            expect(global.fetch).toHaveBeenCalledWith('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
            expect(price).toBe(2000);
        });

        it('should return 0 on fetch error', async () => {
            global.fetch.mockRejectedValueOnce(new Error('Network error'));
            const price = await core.getPrice('ethereum');
            expect(price).toBe(0);
        });

        it('should return 0 if id is not in response', async () => {
            core.USER_SETTINGS.currency = 'usd';
            const mockResponse = { bitcoin: { usd: 30000 } };
            global.fetch.mockResolvedValueOnce({
                json: vi.fn().mockResolvedValueOnce(mockResponse)
            });

            const price = await core.getPrice('ethereum');
            expect(price).toBe(0);
        });
    });

    describe('getNativeBalance', () => {
        it('should return "0.0" if network is not found', async () => {
            const balance = await core.getNativeBalance('0x123', 'unknown');
            expect(balance).toBe('0.0');
        });

        it('should fetch and return formatted balance', async () => {
            const mockProvider = {
                getBalance: vi.fn().mockResolvedValueOnce('1000000000000000000') // 1 ETH in Wei
            };
            ethers.JsonRpcProvider.mockImplementationOnce(function() { return mockProvider; });
            ethers.formatEther.mockReturnValueOnce('1.0');

            const balance = await core.getNativeBalance('0x123', 'ethereum');

            expect(ethers.JsonRpcProvider).toHaveBeenCalledWith('https://eth.llamarpc.com');
            expect(mockProvider.getBalance).toHaveBeenCalledWith('0x123');
            expect(ethers.formatEther).toHaveBeenCalledWith('1000000000000000000');
            expect(balance).toBe('1.0');
        });
    });
});
