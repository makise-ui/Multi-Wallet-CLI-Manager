import fs from 'fs';
import path from 'path';
import os from 'os';
import { ethers } from 'ethers';
import { triggerBackup } from './drive.js';

const CONFIG_DIR = path.join(os.homedir(), '.my-cli-wallet');
const WALLETS_FILE = path.join(CONFIG_DIR, 'my_wallets.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

// --- Constants ---
export const NETWORKS = {
    "ethereum": { name: "Ethereum Mainnet", rpc: "https://eth.llamarpc.com", chainId: 1, currency: "ETH", coingeckoId: "ethereum" },
    "bsc": { name: "Binance Smart Chain", rpc: "https://bsc-dataseed.binance.org", chainId: 56, currency: "BNB", coingeckoId: "binancecoin" },
    "polygon": { name: "Polygon (Matic)", rpc: "https://polygon-rpc.com", chainId: 137, currency: "POL", coingeckoId: "matic-network" },
    "celo": { name: "Celo Mainnet", rpc: "https://forno.celo.org", chainId: 42220, currency: "CELO", coingeckoId: "celo" }
};

export const PREDEFINED_TOKENS = {
    "ethereum": [
        { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6, coingeckoId: "tether" }
    ],
    "bsc": [
        { symbol: "JMPT", address: "0x88d7e9b65dc24cf54f5edef929225fc3e1580c25", decimals: 18, coingeckoId: "jumptoken" },
        { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, coingeckoId: "tether" }
    ],
    "polygon": [
        { symbol: "JMPT", address: "0x88d7e9b65dc24cf54f5edef929225fc3e1580c25", decimals: 18, coingeckoId: "jumptoken" },
        { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, coingeckoId: "tether" }
    ],
    "celo": [
        { symbol: "JMPT", address: "0x88d7e9b65dc24cf54f5edef929225fc3e1580c25", decimals: 18, coingeckoId: "jumptoken" }
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
        const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        if (!loaded.savedTokens) loaded.savedTokens = [];
        USER_SETTINGS = { ...USER_SETTINGS, ...loaded };
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
    const data = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    return data.length > 0;
}

export async function unlockWallets(password) {
    if (!fs.existsSync(WALLETS_FILE)) return [];
    const rawWallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    
    DECRYPTED_WALLETS = [];
    for (const w of rawWallets) {
        if (w.privateKey) {
            // Migration needed, but for core we assume encrypted or we fail?
            // Let's support loading plain if generic, but usually we want to enforce encryption
            // For TUI, we assume encrypted.
            throw new Error("Legacy plain-text wallets found. Please run CLI to migrate.");
        }
        const wallet = await ethers.Wallet.fromEncryptedJson(w.data, password);
        DECRYPTED_WALLETS.push({ name: w.name, wallet: wallet });
    }
    return DECRYPTED_WALLETS;
}

export async function getPrice(coingeckoId) {
    if (!coingeckoId) return 0;
    try {
        const currency = USER_SETTINGS.currency.toLowerCase();
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=${currency}`);
        const data = await res.json();
        return data[coingeckoId] ? data[coingeckoId][currency] : 0;
    } catch (e) {
        return 0;
    }
}

export async function getNativeBalance(walletAddress, networkKey) {
    const net = NETWORKS[networkKey];
    if (!net) return "0.0";
    const provider = new ethers.JsonRpcProvider(net.rpc);
    const balWei = await provider.getBalance(walletAddress);
    return ethers.formatEther(balWei);
}
