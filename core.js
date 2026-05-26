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

export const COINGECKO_PLATFORM_KEYS = {
    ethereum: 'ethereum',
    bsc: 'binance-smart-chain',
    polygon: 'polygon-pos',
    celo: 'celo'
};

export const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function transfer(address to, uint amount) returns (bool)",
    "function approve(address spender, uint amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

export const ROUTERS = {
    "ethereum": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    "bsc": "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    "polygon": "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    "celo": "0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121"
};

export const ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external"
];

export const WNATIVE = {
    "ethereum": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    "bsc": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    "polygon": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    "celo": "0x471EcE3750Da237f93b8E339c536989b8978a438"
};

export const TRANSFER_EVENT_TOPIC = ethers.id("Transfer(address,address,uint256)");
export const TOKEN_DISCOVERY_DEFAULTS = {
    lookbackBlocks: 250000,
    chunkSize: 25000,
    maxContracts: 80
};

// --- State ---
export let DECRYPTED_WALLETS = [];
export let USER_SETTINGS = {
    currency: 'USD',
    defaultNetwork: 'ethereum',
    gasLimitBuffer: '0',
    backupMethod: null,
    rcloneRemote: null,
    savedTokens: [],
    customRpcs: {},
    tokenDiscoveryLookbackBlocks: TOKEN_DISCOVERY_DEFAULTS.lookbackBlocks
};

// --- Methods ---

export function loadSettings() {
    if (fs.existsSync(SETTINGS_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        if (!loaded.savedTokens) loaded.savedTokens = [];
        if (!loaded.customRpcs) loaded.customRpcs = {};
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
    if (rawWallets.length === 0) return [];

    DECRYPTED_WALLETS = [];
    if (rawWallets[0].privateKey) {
        for (const w of rawWallets) {
            DECRYPTED_WALLETS.push({ name: w.name, wallet: new ethers.Wallet(w.privateKey) });
        }
    } else {
        if (!password) throw new Error('Vault password required for encrypted wallets.');
        for (const w of rawWallets) {
            const wallet = await ethers.Wallet.fromEncryptedJson(w.data, password);
            DECRYPTED_WALLETS.push({ name: w.name, wallet });
        }
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
    const provider = getProvider(networkKey);
    const balWei = await provider.getBalance(walletAddress);
    return ethers.formatEther(balWei);
}

export function getTokensForNetwork(networkKey) {
    const predefined = PREDEFINED_TOKENS[networkKey] || [];
    const saved = (USER_SETTINGS.savedTokens || []).filter(t => t.network === networkKey);
    const seen = new Set();

    return [...predefined, ...saved].filter(token => {
        const key = `${networkKey}:${String(token.address).toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeAddress(address) {
    try {
        return ethers.getAddress(address);
    } catch (e) {
        return String(address).trim();
    }
}

function addressToTopic(address) {
    return ethers.zeroPadValue(normalizeAddress(address), 32);
}

function addTokenToMap(map, token) {
    if (!token?.address) return;
    map.set(`${token.network}:${normalizeAddress(token.address).toLowerCase()}`, {
        ...token,
        address: normalizeAddress(token.address)
    });
}

export function saveTokenForNetwork(tokenData) {
    if (!USER_SETTINGS.savedTokens) USER_SETTINGS.savedTokens = [];

    const token = {
        symbol: tokenData.symbol,
        address: normalizeAddress(tokenData.address),
        network: tokenData.network,
        decimals: Number(tokenData.decimals)
    };
    if (tokenData.coingeckoId) token.coingeckoId = tokenData.coingeckoId;

    const tokenKey = `${token.network}:${token.address.toLowerCase()}`;
    const existingIndex = USER_SETTINGS.savedTokens.findIndex(t =>
        `${t.network}:${String(t.address).toLowerCase()}` === tokenKey
    );

    if (existingIndex >= 0) {
        USER_SETTINGS.savedTokens[existingIndex] = token;
    } else {
        USER_SETTINGS.savedTokens.push(token);
    }

    saveSettings({ savedTokens: USER_SETTINGS.savedTokens });
    return token;
}

export async function discoverTokenContractsByTransfers(walletAddress, networkKey, options = {}) {
    const provider = options.provider || getProvider(networkKey);
    const toBlock = options.toBlock ?? await provider.getBlockNumber();
    const lookbackBlocks = Number(
        options.lookbackBlocks ??
        USER_SETTINGS.tokenDiscoveryLookbackBlocks ??
        TOKEN_DISCOVERY_DEFAULTS.lookbackBlocks
    );
    const fromBlock = options.fromBlock ?? Math.max(0, Number(toBlock) - lookbackBlocks);
    const chunkSize = Number(options.chunkSize ?? TOKEN_DISCOVERY_DEFAULTS.chunkSize);
    const maxContracts = Number(options.maxContracts ?? TOKEN_DISCOVERY_DEFAULTS.maxContracts);
    const walletTopic = addressToTopic(walletAddress);
    const addresses = new Map();

    const addLogs = logs => {
        for (const log of logs || []) {
            if (!log.address) continue;
            const address = normalizeAddress(log.address);
            addresses.set(address.toLowerCase(), address);
            if (addresses.size >= maxContracts) break;
        }
    };

    for (let start = Number(fromBlock); start <= Number(toBlock) && addresses.size < maxContracts; start += chunkSize) {
        const end = Math.min(Number(toBlock), start + chunkSize - 1);
        const base = { fromBlock: start, toBlock: end };
        const [incoming, outgoing] = await Promise.allSettled([
            provider.getLogs({ ...base, topics: [TRANSFER_EVENT_TOPIC, null, walletTopic] }),
            provider.getLogs({ ...base, topics: [TRANSFER_EVENT_TOPIC, walletTopic] })
        ]);

        if (incoming.status === 'fulfilled') addLogs(incoming.value);
        if (outgoing.status === 'fulfilled') addLogs(outgoing.value);
    }

    return [...addresses.values()];
}

export async function getWalletTokenBalances(walletAddress, networkKey, options = {}) {
    const provider = options.provider || getProvider(networkKey);
    const knownTokens = getTokensForNetwork(networkKey);
    const tokenMap = new Map();
    const discoveredKeys = new Set();

    for (const token of knownTokens) addTokenToMap(tokenMap, { ...token, network: networkKey });

    if (options.includeDiscovered !== false) {
        try {
            const discoveredAddresses = await discoverTokenContractsByTransfers(walletAddress, networkKey, { ...options, provider });
            for (const address of discoveredAddresses) {
                const key = `${networkKey}:${normalizeAddress(address).toLowerCase()}`;
                discoveredKeys.add(key);
                if (!tokenMap.has(key)) tokenMap.set(key, { address: normalizeAddress(address), network: networkKey });
            }
        } catch (e) {
            // Some public RPCs limit eth_getLogs. Known/saved tokens are still checked below.
        }
    }

    const balances = [];
    for (const token of tokenMap.values()) {
        try {
            const metadata = token.symbol && token.decimals !== undefined
                ? token
                : await readTokenMetadata(token.address, networkKey, provider);
            const contract = new ethers.Contract(metadata.address, ERC20_ABI, provider);
            const balanceWei = await contract.balanceOf(walletAddress);
            const balanceBigInt = BigInt(balanceWei.toString());
            if (balanceBigInt <= 0n) continue;

            const result = {
                ...metadata,
                address: normalizeAddress(metadata.address),
                network: networkKey,
                decimals: Number(metadata.decimals),
                balanceWei: balanceBigInt,
                balance: ethers.formatUnits(balanceBigInt, Number(metadata.decimals))
            };

            balances.push(result);

            const key = `${networkKey}:${result.address.toLowerCase()}`;
            if (options.saveDiscovered !== false && discoveredKeys.has(key)) {
                saveTokenForNetwork(result);
            }
        } catch (e) {
            // Skip contracts that are not ERC-20 compatible or fail on this RPC.
        }
    }

    return balances;
}

export async function searchCoinGeckoTokens(query) {
    const term = query.trim();
    if (!term) throw new Error('Token search query is required.');

    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(term)}`);
    if (res.ok === false) throw new Error(`CoinGecko search failed with status ${res.status}`);

    const data = await res.json();
    return (data.coins || []).slice(0, 10).map(c => ({
        id: c.id,
        name: c.name,
        symbol: c.symbol,
        marketCapRank: c.market_cap_rank || null
    }));
}

export async function readTokenMetadata(address, networkKey, provider = getProvider(networkKey)) {
    const contract = new ethers.Contract(address.trim(), ERC20_ABI, provider);
    const [symbol, decimals] = await Promise.all([
        contract.symbol(),
        contract.decimals()
    ]);

    return {
        symbol,
        address: address.trim(),
        network: networkKey,
        decimals: Number(decimals)
    };
}

export async function resolveCoinGeckoToken(coinId, networkKey) {
    const platformKey = COINGECKO_PLATFORM_KEYS[networkKey];
    if (!platformKey) throw new Error(`CoinGecko lookup is not configured for ${networkKey}.`);

    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}`);
    if (res.ok === false) throw new Error(`CoinGecko detail lookup failed with status ${res.status}`);

    const detail = await res.json();
    const address = detail.platforms?.[platformKey];
    if (!address) {
        const available = Object.keys(detail.platforms || {}).join(', ') || 'none';
        throw new Error(`${detail.name || coinId} has no contract on ${NETWORKS[networkKey].name}. Available platforms: ${available}`);
    }

    const token = await readTokenMetadata(address, networkKey);
    return { ...token, coingeckoId: detail.id || coinId };
}

export function getProvider(networkKey) {
    const net = NETWORKS[networkKey];
    if (!net) throw new Error(`Unknown network: ${networkKey}`);
    const rpc = USER_SETTINGS.customRpcs?.[networkKey] || net.rpc;
    return new ethers.JsonRpcProvider(rpc);
}

export async function sendNativeTransfer(connectedSigner, recipient, amountEther) {
    const amountWei = ethers.parseEther(amountEther);
    const txRequest = { to: recipient, value: amountWei };
    if (USER_SETTINGS.gasLimitBuffer && USER_SETTINGS.gasLimitBuffer !== '0') {
        const estimatedGas = await connectedSigner.estimateGas(txRequest);
        txRequest.gasLimit = estimatedGas + BigInt(USER_SETTINGS.gasLimitBuffer);
    }
    return await connectedSigner.sendTransaction(txRequest);
}

export async function sendTokenTransfer(connectedSigner, tokenAddress, recipient, amount, decimals) {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, connectedSigner);
    const amountWei = ethers.parseUnits(amount, decimals);
    return await contract.transfer(recipient, amountWei);
}

export async function checkAndApproveToken(signer, tokenAddress, spender, amountIn) {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allowance = await tokenContract.allowance(signer.address, spender);
    if (allowance < amountIn) {
        const txApprove = await tokenContract.approve(spender, ethers.MaxUint256);
        await txApprove.wait();
        return txApprove.hash;
    }
    return null;
}

export async function executeSwap(signer, networkKey, tokenData, amountIn) {
    const routerAddress = ROUTERS[networkKey];
    const wnative = WNATIVE[networkKey];
    if (!routerAddress || !wnative) {
        throw new Error('Swap not supported on this network.');
    }
    const path = [tokenData.address, wnative];
    const routerContract = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
    const amounts = await routerContract.getAmountsOut(amountIn, path);
    const amountOutMin = amounts[1] * 95n / 100n;
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
    const txSwap = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
        amountIn,
        amountOutMin,
        path,
        signer.address,
        deadline
    );
    return txSwap;
}
