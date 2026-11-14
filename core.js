import fs from 'fs';
import path from 'path';
import os from 'os';
import { ethers } from 'ethers';
import { triggerBackup } from './drive.js';
import { getAllChains, getChain, getProvider } from './chains.js';
import { COMMON_TOKENS_BY_CHAIN, NATIVE_COIN_PRICE_KEYS } from './portfolio.js';

const CONFIG_DIR = path.join(os.homedir(), '.my-cli-wallet');
const WALLETS_FILE = path.join(CONFIG_DIR, 'my_wallets.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// --- Dynamic 200+ Networks Registry ---
export const NETWORKS = {};

// Populate with all 260+ curated chains
const allChainsList = getAllChains();
for (const chain of allChainsList) {
    const netObj = {
        name: chain.name,
        rpc: chain.rpc,
        rpcList: chain.rpcList || [chain.rpc],
        chainId: chain.chainId,
        currency: chain.currency,
        decimals: chain.decimals || 18,
        coingeckoId: chain.coingeckoId,
        explorer: chain.explorer,
        hasSwapBridge: chain.hasSwapBridge
    };
    
    // Key by string chainId
    NETWORKS[String(chain.chainId)] = netObj;
    
    // Key by key slug (e.g. eth, bsc, pol, arb, etc.)
    if (chain.key) {
        NETWORKS[chain.key.toLowerCase()] = netObj;
    }
}

// Ensure standard legacy keys exist
if (!NETWORKS['ethereum'] && NETWORKS['1']) NETWORKS['ethereum'] = NETWORKS['1'];
if (!NETWORKS['bsc'] && NETWORKS['56']) NETWORKS['bsc'] = NETWORKS['56'];
if (!NETWORKS['polygon'] && NETWORKS['137']) NETWORKS['polygon'] = NETWORKS['137'];
if (!NETWORKS['celo'] && NETWORKS['42220']) NETWORKS['celo'] = NETWORKS['42220'];
if (!NETWORKS['arbitrum'] && NETWORKS['42161']) NETWORKS['arbitrum'] = NETWORKS['42161'];
if (!NETWORKS['base'] && NETWORKS['8453']) NETWORKS['base'] = NETWORKS['8453'];
if (!NETWORKS['optimism'] && NETWORKS['10']) NETWORKS['optimism'] = NETWORKS['10'];
if (!NETWORKS['avalanche'] && NETWORKS['43114']) NETWORKS['avalanche'] = NETWORKS['43114'];

export const PREDEFINED_TOKENS = {
    "ethereum": [
        { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, coingeckoId: "tether" },
        { symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6, coingeckoId: "usd-coin" },
        { symbol: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f", decimals: 18, coingeckoId: "dai" }
    ],
    "bsc": [
        { symbol: "JMPT", address: "0x88d7e9b65dc24cf54f5edef929225fc3e1580c25", decimals: 18, coingeckoId: "jumptoken" },
        { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, coingeckoId: "tether" },
        { symbol: "USDC", address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, coingeckoId: "usd-coin" }
    ],
    "polygon": [
        { symbol: "JMPT", address: "0x88d7e9b65dc24cf54f5edef929225fc3e1580c25", decimals: 18, coingeckoId: "jumptoken" },
        { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, coingeckoId: "tether" },
        { symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6, coingeckoId: "usd-coin" }
    ],
    "celo": [
        { symbol: "JMPT", address: "0x88d7e9b65dc24cf54f5edef929225fc3e1580c25", decimals: 18, coingeckoId: "jumptoken" },
        { symbol: "cUSD", address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", decimals: 18, coingeckoId: "celo-dollar" }
    ]
};

export const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function transfer(address to, uint amount) returns (bool)",
    "function approve(address spender, uint amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

// --- State ---
export let DECRYPTED_WALLETS = [];
export let USER_SETTINGS = { 
    currency: 'USD',
    defaultNetwork: 'ethereum',
    gasLimitBuffer: '0',
    backupMethod: null,
    rcloneRemote: null,
    savedTokens: [] 
};

// --- Methods ---

export function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
            if (!loaded.savedTokens) loaded.savedTokens = [];
            USER_SETTINGS = { ...USER_SETTINGS, ...loaded };
        } catch (e) {}
    }
    return USER_SETTINGS;
}

export function saveSettings(newSettings) {
    USER_SETTINGS = { ...USER_SETTINGS, ...newSettings };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(USER_SETTINGS, null, 2));
    triggerBackup(USER_SETTINGS);
}

export function hasEncryptedWallets() {
    if (!fs.existsSync(WALLETS_FILE)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
        return data.length > 0;
    } catch (e) {
        return false;
    }
}

/**
 * Extract public addresses and names from encrypted keystores without password
 */
export function getPublicWallets() {
    if (!fs.existsSync(WALLETS_FILE)) return [];
    try {
        const rawWallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
        return rawWallets.map(w => {
            if (w.privateKey) {
                const pk = w.privateKey.startsWith('0x') ? w.privateKey : '0x' + w.privateKey;
                try {
                    const temp = new ethers.Wallet(pk);
                    return {
                        name: w.name,
                        address: temp.address,
                        isUnlocked: true,
                        wallet: temp
                    };
                } catch (e) {}
            }
            let addr = '';
            try {
                const parsed = typeof w.data === 'string' ? JSON.parse(w.data) : w.data;
                if (parsed && parsed.address) {
                    addr = ethers.getAddress('0x' + parsed.address.replace(/^0x/, ''));
                }
            } catch (e) {}
            return {
                name: w.name,
                address: addr || 'Unknown',
                isUnlocked: false,
                wallet: { address: addr || 'Unknown' }
            };
        }).filter(w => w.address !== 'Unknown');
    } catch (e) {
        return [];
    }
}

/**
 * Load public wallets into memory without requiring password
 */
export function loadPublicWallets() {
    const list = getPublicWallets();
    DECRYPTED_WALLETS = list;
    return list;
}

export async function unlockWallets(password) {
    if (!fs.existsSync(WALLETS_FILE)) return [];
    const rawWallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    
    const unlocked = [];
    for (const w of rawWallets) {
        if (w.privateKey) {
            const pk = w.privateKey.startsWith('0x') ? w.privateKey : '0x' + w.privateKey;
            const wallet = new ethers.Wallet(pk);
            unlocked.push({ name: w.name, address: wallet.address, isUnlocked: true, wallet: wallet });
            continue;
        }
        const wallet = await ethers.Wallet.fromEncryptedJson(w.data, password);
        unlocked.push({ name: w.name, address: wallet.address, isUnlocked: true, wallet: wallet });
    }
    DECRYPTED_WALLETS = unlocked;
    return DECRYPTED_WALLETS;
}

let cachedRates = { USD: 1 };
let lastRateFetch = 0;

export async function getFiatRate(targetCurrency = 'USD') {
    const curr = (targetCurrency || 'USD').toUpperCase();
    if (curr === 'USD') return 1;

    if (Date.now() - lastRateFetch < 3600000 && cachedRates[curr]) {
        return cachedRates[curr];
    }

    try {
        const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const data = await res.json();
            if (data && data.rates) {
                cachedRates = data.rates;
                lastRateFetch = Date.now();
                return cachedRates[curr] || 1;
            }
        }
    } catch (e) {}

    const fallbacks = { INR: 86.5, EUR: 0.92, GBP: 0.78, JPY: 152.0 };
    return fallbacks[curr] || 1;
}

export async function getPrice(idOrSymbol, targetCurrency = null) {
    if (!idOrSymbol) return 0;
    const curr = (targetCurrency || USER_SETTINGS.currency || 'USD').toUpperCase();
    const cleanId = String(idOrSymbol).trim();
    
    // Check if symbol is in NATIVE_COIN_PRICE_KEYS or known alias
    let lookupKey = cleanId;
    if (NATIVE_COIN_PRICE_KEYS && NATIVE_COIN_PRICE_KEYS[cleanId.toUpperCase()]) {
        lookupKey = NATIVE_COIN_PRICE_KEYS[cleanId.toUpperCase()].replace('coingecko:', '');
    } else if (cleanId.toUpperCase() === 'POL' || cleanId.toUpperCase() === 'MATIC') {
        lookupKey = 'polygon-ecosystem-token';
    }

    let priceUSD = 0;
    try {
        // Try DefiLlama first (fast & reliable)
        const dlRes = await fetch(`https://coins.llama.fi/prices/current/coingecko:${lookupKey}`, { signal: AbortSignal.timeout(3000) });
        if (dlRes.ok) {
            const dlData = await dlRes.json();
            const coin = dlData.coins && dlData.coins[`coingecko:${lookupKey}`];
            if (coin && coin.price) priceUSD = coin.price;
        }

        if (priceUSD === 0) {
            // Fallback to CoinGecko
            const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${lookupKey}&vs_currencies=usd`, { signal: AbortSignal.timeout(3000) });
            const data = await res.json();
            if (data[lookupKey] && data[lookupKey].usd) {
                priceUSD = data[lookupKey].usd;
            }
        }
    } catch (e) {
        return 0;
    }

    if (priceUSD === 0) return 0;

    const rate = await getFiatRate(curr);
    return priceUSD * rate;
}

export async function getNativeBalance(walletAddress, networkKey) {
    const net = NETWORKS[networkKey] || getChain(networkKey);
    if (!net) return "0.0";
    try {
        const provider = getProvider(net.chainId || networkKey);
        const balWei = await provider.getBalance(walletAddress);
        return ethers.formatEther(balWei);
    } catch (e) {
        return "0.0";
    }
}
