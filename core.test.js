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
    const MockWallet = vi.fn(function (privateKey) {
        return { privateKey, address: '0xlegacy' };
    });
    MockWallet.fromEncryptedJson = vi.fn();

    return {
        ...actual,
        ethers: {
            ...actual.ethers,
            Wallet: MockWallet,
            Contract: vi.fn(function () {
                return {
                    symbol: vi.fn(),
                    decimals: vi.fn(),
                    balanceOf: vi.fn(),
                    transfer: vi.fn(),
                    allowance: vi.fn(),
                    approve: vi.fn()
                };
            }),
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

        it('should load legacy plain-text wallets', async () => {
            fs.existsSync.mockReturnValueOnce(true);
            fs.readFileSync.mockReturnValueOnce(JSON.stringify([{ privateKey: '0x123' }]));

            const wallets = await core.unlockWallets('password');

            expect(ethers.Wallet).toHaveBeenCalledWith('0x123');
            expect(wallets).toEqual([{ name: undefined, wallet: { privateKey: '0x123', address: '0xlegacy' } }]);
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

    describe('token helpers', () => {
        let originalFetch;

        beforeEach(() => {
            originalFetch = global.fetch;
            global.fetch = vi.fn();
        });

        afterEach(() => {
            global.fetch = originalFetch;
        });

        it('should combine predefined and saved tokens for the selected network', () => {
            core.USER_SETTINGS.savedTokens = [
                { symbol: 'CAKE', address: '0x111', network: 'bsc', decimals: 18 },
                { symbol: 'QUICK', address: '0x222', network: 'polygon', decimals: 18 }
            ];

            const tokens = core.getTokensForNetwork('bsc');

            expect(tokens.map(t => t.symbol)).toEqual(['JMPT', 'USDT', 'CAKE']);
        });

        it('should update an existing saved token instead of duplicating it', () => {
            core.USER_SETTINGS.savedTokens = [
                { symbol: 'OLD', address: '0xAbC', network: 'bsc', decimals: 18 }
            ];

            const saved = core.saveTokenForNetwork({
                symbol: 'NEW',
                address: '0xabc',
                network: 'bsc',
                decimals: 9,
                coingeckoId: 'new-token'
            });

            expect(saved.symbol).toBe('NEW');
            expect(core.USER_SETTINGS.savedTokens).toEqual([
                { symbol: 'NEW', address: '0xabc', network: 'bsc', decimals: 9, coingeckoId: 'new-token' }
            ]);
            expect(drive.triggerBackup).toHaveBeenCalled();
        });

        it('should resolve a CoinGecko coin to a verified network token', async () => {
            const tokenAddress = '0x1234567890123456789012345678901234567890';
            global.fetch.mockResolvedValueOnce({
                json: vi.fn().mockResolvedValueOnce({
                    id: 'pepe',
                    platforms: { 'binance-smart-chain': tokenAddress }
                })
            });
            ethers.Contract.mockImplementationOnce(function () {
                return {
                    symbol: vi.fn().mockResolvedValueOnce('PEPE'),
                    decimals: vi.fn().mockResolvedValueOnce(18)
                };
            });

            const token = await core.resolveCoinGeckoToken('pepe', 'bsc');

            expect(global.fetch).toHaveBeenCalledWith('https://api.coingecko.com/api/v3/coins/pepe');
            expect(token).toEqual({
                symbol: 'PEPE',
                address: tokenAddress,
                network: 'bsc',
                decimals: 18,
                coingeckoId: 'pepe'
            });
        });

        it('should discover token contracts from wallet transfer logs', async () => {
            const wallet = '0x00000000000000000000000000000000000000aa';
            const tokenA = '0x00000000000000000000000000000000000000b1';
            const tokenB = '0x00000000000000000000000000000000000000b2';
            const provider = {
                getLogs: vi.fn()
                    .mockResolvedValueOnce([{ address: tokenA }, { address: tokenA }])
                    .mockResolvedValueOnce([{ address: tokenB }])
            };

            const tokens = await core.discoverTokenContractsByTransfers(wallet, 'ethereum', {
                provider,
                fromBlock: 10,
                toBlock: 20
            });

            expect(provider.getLogs).toHaveBeenCalledTimes(2);
            expect(tokens).toEqual([
                ethers.getAddress(tokenA),
                ethers.getAddress(tokenB)
            ]);
        });

        it('should return discovered tokens with positive wallet balances', async () => {
            const wallet = '0x00000000000000000000000000000000000000aa';
            const discoveredToken = '0x00000000000000000000000000000000000000b3';
            const provider = {
                getLogs: vi.fn()
                    .mockResolvedValueOnce([{ address: discoveredToken }])
                    .mockResolvedValueOnce([])
            };

            ethers.Contract.mockImplementation(function (address) {
                const normalized = ethers.getAddress(address);
                if (normalized === ethers.getAddress(discoveredToken)) {
                    return {
                        symbol: vi.fn().mockResolvedValue('AUTO'),
                        decimals: vi.fn().mockResolvedValue(6),
                        balanceOf: vi.fn().mockResolvedValue(123450000n)
                    };
                }

                return {
                    symbol: vi.fn().mockResolvedValue('ZERO'),
                    decimals: vi.fn().mockResolvedValue(18),
                    balanceOf: vi.fn().mockResolvedValue(0n)
                };
            });

            const balances = await core.getWalletTokenBalances(wallet, 'ethereum', {
                provider,
                fromBlock: 10,
                toBlock: 20
            });

            expect(balances).toEqual([expect.objectContaining({
                symbol: 'AUTO',
                address: ethers.getAddress(discoveredToken),
                network: 'ethereum',
                decimals: 6,
                balance: '123.45',
                balanceWei: 123450000n
            })]);
            expect(core.USER_SETTINGS.savedTokens).toEqual([{
                symbol: 'AUTO',
                address: ethers.getAddress(discoveredToken),
                network: 'ethereum',
                decimals: 6
            }]);
        });
    });
});
