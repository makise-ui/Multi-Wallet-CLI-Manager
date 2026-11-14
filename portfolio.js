import fs from 'fs';
import path from 'path';
import os from 'os';
import { ethers } from 'ethers';
import { getChain, getPopularChains, getAllChains, POPULAR_CHAIN_IDS, getWorkingProvider, getProvider } from './chains.js';
import { getTokensForChain } from './swapBridge.js';

const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';
const CACHE_FILE = path.join(os.homedir(), '.my-cli-wallet', 'portfolio_cache.json');

// Memory cache for prices (15-min TTL)
let inMemoryPriceCache = {
    timestamp: 0,
    prices: {}
};

/**
 * Load complete portfolio cache from disk
 */
export function loadPortfolioCache(address) {
    const normalized = (address || '').toLowerCase();
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            
            // 1. Active chains
            const activeChains = new Set();
            if (raw.activeChains && Array.isArray(raw.activeChains[normalized])) {
                raw.activeChains[normalized].forEach(id => activeChains.add(Number(id)));
            } else if (Array.isArray(raw[normalized])) {
                raw[normalized].forEach(id => activeChains.add(Number(id)));
            }

            // 2. Verified holdings
            const holdings = new Map();
            if (raw.verifiedHoldings && raw.verifiedHoldings[normalized]) {
                for (const [key, asset] of Object.entries(raw.verifiedHoldings[normalized])) {
                    holdings.set(key, asset);
                }
            }

            // 3. Price cache
            const prices = raw.prices || {};
            if (Object.keys(prices).length > 0 && Date.now() - (raw.pricesTimestamp || 0) < 900000) {
                inMemoryPriceCache = {
                    timestamp: raw.pricesTimestamp || Date.now(),
                    prices: prices
                };
            }

            return { activeChains, holdings, prices };
        }
    } catch (e) {}
    return { activeChains: new Set(), holdings: new Map(), prices: {} };
}

/**
 * Save complete portfolio cache to disk
 */
export function savePortfolioCache(address, activeChainIds, holdingsMap, priceMap) {
    const normalized = (address || '').toLowerCase();
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let raw = {};
        if (fs.existsSync(CACHE_FILE)) {
            try { raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) {}
        }

        if (!raw.activeChains) raw.activeChains = {};
        if (!raw.verifiedHoldings) raw.verifiedHoldings = {};

        // 1. Update active chains
        const existingChains = new Set(raw.activeChains[normalized] || raw[normalized] || []);
        activeChainIds.forEach(id => existingChains.add(Number(id)));
        const chainsArr = Array.from(existingChains);
        raw.activeChains[normalized] = chainsArr;
        raw[normalized] = chainsArr; // Backwards compatibility

        // 2. Update verified holdings
        if (!raw.verifiedHoldings[normalized]) raw.verifiedHoldings[normalized] = {};
        for (const [key, asset] of holdingsMap.entries()) {
            raw.verifiedHoldings[normalized][key] = {
                symbol: asset.symbol,
                name: asset.name,
                address: asset.address,
                decimals: asset.decimals,
                balance: asset.balance,
                balanceRaw: asset.balanceRaw,
                isNative: asset.isNative,
                chainId: asset.chainId,
                chainName: asset.chainName,
                priceUSD: asset.priceUSD || 0,
                updatedAt: Date.now()
            };
        }

        // 3. Update prices
        if (priceMap && Object.keys(priceMap).length > 0) {
            raw.prices = { ...(raw.prices || {}), ...priceMap };
            raw.pricesTimestamp = Date.now();
            inMemoryPriceCache = { timestamp: Date.now(), prices: raw.prices };
        }

        fs.writeFileSync(CACHE_FILE, JSON.stringify(raw, null, 2));
    } catch (e) {}
}

export function loadActiveChainsCache(address) {
    return loadPortfolioCache(address).activeChains;
}

export function saveActiveChainsCache(address, chainIds) {
    savePortfolioCache(address, chainIds, new Map(), {});
}

/**
 * Instantly load portfolio from local verified cache (0ms latency)
 */
export function loadCachedPortfolio(walletAddress) {
    const cache = loadPortfolioCache(walletAddress);
    if (!cache.holdings || cache.holdings.size === 0) return null;

    let grandTotalUSD = 0;
    const chainSummariesMap = new Map();
    const enrichedAssets = [];

    for (const asset of cache.holdings.values()) {
        const balNum = parseFloat(asset.balance);
        if (isNaN(balNum) || balNum <= 0.000001) continue;

        const symUpper = (asset.symbol || '').toUpperCase();
        let price = asset.priceUSD || 0;
        if (!price) {
            const key = NATIVE_COIN_PRICE_KEYS[symUpper];
            if (key && cache.prices[key]) {
                price = cache.prices[key];
            } else if (STABLECOIN_SYMBOLS.has(symUpper)) {
                price = 1.0;
            }
        }

        const valueUSD = balNum * price;
        grandTotalUSD += valueUSD;

        const cId = asset.chainId;
        if (!chainSummariesMap.has(cId)) {
            chainSummariesMap.set(cId, {
                chainId: cId,
                chainName: asset.chainName,
                totalUSD: 0,
                assetCount: 0
            });
        }
        const cSum = chainSummariesMap.get(cId);
        cSum.totalUSD += valueUSD;
        cSum.assetCount += 1;

        enrichedAssets.push({
            ...asset,
            priceUSD: price,
            valueUSD: valueUSD,
            valueFormatted: valueUSD.toFixed(2),
            isFromCache: true
        });
    }

    if (enrichedAssets.length === 0) return null;

    enrichedAssets.sort((a, b) => b.valueUSD - a.valueUSD);
    const chainSummaries = Array.from(chainSummariesMap.values()).map(c => ({
        ...c,
        totalUSDFormatted: c.totalUSD.toFixed(2),
        pctOfTotal: grandTotalUSD > 0 ? ((c.totalUSD / grandTotalUSD) * 100).toFixed(1) + '%' : '0%'
    })).sort((a, b) => b.totalUSD - a.totalUSD);

    return {
        walletAddress,
        grandTotalUSD: grandTotalUSD.toFixed(2),
        totalAssets: enrichedAssets.length,
        activeChainsCount: chainSummaries.length,
        chainSummaries,
        assets: enrichedAssets,
        isFromCache: true
    };
}

/**
 * Ultra-fast raw JSON-RPC eth_getBalance via HTTP fetch without heavy provider overhead
 */
async function getBalanceRaw(rpcUrl, address, timeoutMs = 2500) {
    const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [address, 'latest'], id: 1 }),
        signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'RPC Error');
    if (!data.result || data.result === '0x' || data.result === '0x0') return 0n;
    return BigInt(data.result);
}

const MULTICALL3_ABI = [
    'function getEthBalance(address addr) view returns (uint256 balance)',
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'
];

const ERC20_INTERFACE = new ethers.Interface([
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)'
]);

// Known test/dummy chains that return fake balances (e.g. 42424242...)
export const DUMMY_IGNORE_CHAINS = new Set([7, 17, 4217]);

// Stablecoins that default to $1.00 when pricing is unavailable
export const STABLECOIN_SYMBOLS = new Set([
    'USDC', 'USDC.E', 'USDT', 'USDT0', 'DAI', 'XDAI', 'BUSD', 'CUSD', 'AUSD',
    'USD0', 'USDE', 'PYUSD', 'FDUSD', 'TUSD', 'FRAX', 'LUSD', 'SUSD', 'GUSD'
]);

// DefiLlama price mapping for major native currencies
export const NATIVE_COIN_PRICE_KEYS = {
    'ETH': 'coingecko:ethereum',
    'WETH': 'coingecko:ethereum',
    'BNB': 'coingecko:binancecoin',
    'WBNB': 'coingecko:binancecoin',
    'POL': 'coingecko:polygon-ecosystem-token',
    'MATIC': 'coingecko:polygon-ecosystem-token',
    'AVAX': 'coingecko:avalanche-2',
    'WAVAX': 'coingecko:avalanche-2',
    'FTM': 'coingecko:fantom',
    'CELO': 'coingecko:celo',
    'XDAI': 'coingecko:xdai',
    'DAI': 'coingecko:dai',
    'S': 'coingecko:sonic-3',
    'SONIC': 'coingecko:sonic-3',
    'BERA': 'coingecko:berachain-bera',
    'ARB': 'coingecko:arbitrum',
    'OP': 'coingecko:optimism',
    'MNT': 'coingecko:mantle',
    'METIS': 'coingecko:metis-token',
    'CORE': 'coingecko:coredaoorg',
    'CRO': 'coingecko:crypto-com-chain',
    'KAVA': 'coingecko:kava',
    'GLMR': 'coingecko:moonbeam',
    'MOVR': 'coingecko:moonriver',
    'ASTR': 'coingecko:astar',
    'ASTAR': 'coingecko:astar',
    'CFX': 'coingecko:conflux-token',
    'FLR': 'coingecko:flare-networks',
    'SGB': 'coingecko:songbird',
    'RON': 'coingecko:ronin',
    'TAIKO': 'coingecko:taiko',
    'BLAST': 'coingecko:blast',
    'ZK': 'coingecko:zksync',
    'LINEA': 'coingecko:linea',
    'SCROLL': 'coingecko:scroll',
    'SEI': 'coingecko:sei-network',
    'APE': 'coingecko:apecoin',
    'DEGEN': 'coingecko:degen-base',
    'USDC': 'coingecko:usd-coin',
    'USDC.E': 'coingecko:usd-coin',
    'USDT': 'coingecko:tether',
    'USDT0': 'coingecko:tether',
    'SOMI': 'coingecko:somnia',
    'SOMNIA': 'coingecko:somnia',
    'MON': 'coingecko:monad',
    'MONAD': 'coingecko:monad',
    'HYPE': 'coingecko:hyperliquid',
    'HYPEREVM': 'coingecko:hyperliquid',
    'GNS': 'coingecko:gains-network',
    'QUICK': 'coingecko:quickswap',
    'AUSD': 'coingecko:agora-dollar'
};

// Curated popular tokens per major chain for high-speed Multicall3 batch queries
export const COMMON_TOKENS_BY_CHAIN = {
    // Ethereum (1)
    1: [
        { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
        { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
        { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
        { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
        { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
        { symbol: 'LINK', address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
        { symbol: 'UNI', address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 }
    ],
    // BSC (56)
    56: [
        { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
        { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
        { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
        { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
        { symbol: 'CAKE', address: '0x0E09FaBB73BD3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
        { symbol: 'JMPT', address: '0x88d7e9b65dc24cf54f5edef929225fc3e1580c25', decimals: 18 }
    ],
    // Polygon (137)
    137: [
        { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
        { symbol: 'USDC.e', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
        { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
        { symbol: 'WETH', address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
        { symbol: 'WBTC', address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', decimals: 8 },
        { symbol: 'DAI', address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
        { symbol: 'QUICK', address: '0x831753DD7087CaC61aB5644b308642cc1c33Dc13', decimals: 18 },
        { symbol: 'QUICK (OLD)', address: '0xB5C064F955D8e7F38fE0460C556a72987494eE17', decimals: 18 },
        { symbol: 'sLGNS', address: '0x99a57E6C8558BC6689f894e068733ADf83C19725', decimals: 18 },
        { symbol: 'BRZ', address: '0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc', decimals: 18 },
        { symbol: 'pUSD', name: 'Polymarket USD', address: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB', decimals: 6 },
        { symbol: '99PC', address: '0xD98E5BDBb77c1bFeac4DD6d2f4D598c9a6D0Ab33', decimals: 18 }
    ],
    // Arbitrum One (42161)
    42161: [
        { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
        { symbol: 'USDC.e', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', decimals: 6 },
        { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
        { symbol: 'USDT0', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
        { symbol: 'ARB', address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
        { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
        { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
        { symbol: 'GNS', address: '0x18c11FD286C5EC11c3b683Caa813B77f5163A122', decimals: 18 }
    ],
    // Base (8453)
    8453: [
        { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
        { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
        { symbol: 'DEGEN', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', decimals: 18 },
        { symbol: 'BRETT', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', decimals: 18 },
        { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 }
    ],
    // Optimism (10)
    10: [
        { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6 },
        { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
        { symbol: 'OP', address: '0x4200000000000000000000000000000000000042', decimals: 18 },
        { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 }
    ],
    // Avalanche (43114)
    43114: [
        { symbol: 'USDC', address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', decimals: 6 },
        { symbol: 'USDT', address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
        { symbol: 'WAVAX', address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', decimals: 18 }
    ],
    // Gnosis (100)
    100: [
        { symbol: 'WXDAI', address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', decimals: 18 },
        { symbol: 'USDC', address: '0xDDAfbb505ad214D7b80b1f830fcCc89B575F44aB', decimals: 6 },
        { symbol: 'USDT', address: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6', decimals: 6 }
    ],
    // Celo (42220)
    42220: [
        { symbol: 'USDT', address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
        { symbol: 'cUSD', address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: 18 },
        { symbol: 'JMPT', address: '0x88d7e9b65dc24cf54f5edef929225fc3e1580c25', decimals: 18 }
    ],
    // Sonic (146)
    146: [
        { symbol: 'wS', address: '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38', decimals: 18 },
        { symbol: 'USDC', address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', decimals: 6 }
    ],
    // Scroll (534352)
    534352: [
        { symbol: 'WETH', address: '0x5300000000000000000000000000000000000004', decimals: 18 },
        { symbol: 'USDC', address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', decimals: 6 }
    ],
    // Linea (59144)
    59144: [
        { symbol: 'USDC', address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', decimals: 6 },
        { symbol: 'WETH', address: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', decimals: 18 }
    ],
    // Monad (143)
    143: [
        { symbol: 'AUSD', address: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', decimals: 6 },
        { symbol: 'WMON', address: '0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701', decimals: 18 },
        { symbol: 'USDC', address: '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea', decimals: 6 },
        { symbol: 'USDT', address: '0x88b8E2161DEDC77EF4ab7585569D2415a1C1055D', decimals: 6 }
    ],
    // HyperEVM (999)
    999: [
        { symbol: 'USDC', address: '0x2b066063b46944e88383a8b48f98c48408f625f3', decimals: 6 }
    ],
    // Astar (592)
    592: [
        { symbol: 'WASTR', address: '0xAeaaf0e2c81Af264101B9Db29C15d9B6741437fd', decimals: 18 },
        { symbol: 'USDT', address: '0x3795C36e7DaF3A888d380d74045574288519c9e8', decimals: 6 },
        { symbol: 'USDC', address: '0x6a2d262D56735DbA19Dd70682B39F6bE9a931D98', decimals: 6 }
    ]
};

/**
 * Fetch token holdings via RouteScan Multichain Indexer
 */
async function fetchRoutescanTokens(walletAddress) {
    try {
        const url = `https://api.routescan.io/v2/network/mainnet/evm/all/address/${walletAddress}/erc20-holdings`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(7000)
        });
        if (!res.ok) return [];
        const data = await res.json();
        if (!data || !Array.isArray(data.items)) return [];

        const validTokens = [];
        for (const item of data.items) {
            if (!item.chainId || !item.tokenAddress || !item.tokenQuantity) continue;
            const name = item.tokenName || '';
            const symbol = item.tokenSymbol || '';
            // Skip spam
            if (name.includes('www.') || name.includes('.club') || name.includes('.top') || name.includes('claim') || name.includes('reward') || name.includes('.cfd') || name.includes('.rest')) {
                continue;
            }
            const dec = Number(item.tokenDecimals) || 18;
            const balRaw = BigInt(item.tokenQuantity);
            if (balRaw <= 0n) continue;
            const balFormatted = ethers.formatUnits(balRaw, dec);
            if (parseFloat(balFormatted) <= 0.000001) continue;

            validTokens.push({
                chainId: Number(item.chainId),
                address: item.tokenAddress,
                symbol: symbol || 'TOKEN',
                name: name || symbol || 'Token',
                decimals: dec,
                balance: balFormatted,
                balanceRaw: balRaw.toString(),
                priceUSD: item.tokenPriceUSD ? parseFloat(item.tokenPriceUSD) : 0
            });
        }
        return validTokens;
    } catch (e) {
        return [];
    }
}

/**
 * Batch-fetch token balances for a chain using Multicall3
 */
async function fetchMulticallTokens(provider, walletAddress, tokensList) {
    if (!tokensList || tokensList.length === 0) return [];

    const CHUNK_SIZE = 250;
    const chunks = [];
    for (let i = 0; i < tokensList.length; i += CHUNK_SIZE) {
        chunks.push(tokensList.slice(i, i + CHUNK_SIZE));
    }

    const discovered = [];
    try {
        const mc3 = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
        await Promise.all(chunks.map(async (chunk) => {
            const calls = [];
            for (const t of chunk) {
                try {
                    const cAddr = ethers.getAddress(t.address.toLowerCase());
                    calls.push({
                        target: cAddr,
                        allowFailure: true,
                        callData: ERC20_INTERFACE.encodeFunctionData('balanceOf', [walletAddress])
                    });
                } catch (e) {}
            }
            if (calls.length === 0) return;

            try {
                const results = await Promise.race([
                    mc3.aggregate3(calls),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Multicall timeout')), 6500))
                ]);

                results.forEach((r, idx) => {
                    if (r.success && r.returnData && r.returnData !== '0x') {
                        try {
                            const balWei = BigInt(r.returnData);
                            if (balWei > 0n) {
                                const token = chunk[idx];
                                const balFormatted = ethers.formatUnits(balWei, token.decimals);
                                if (parseFloat(balFormatted) > 0.000001) {
                                    discovered.push({
                                        symbol: token.symbol,
                                        name: token.name || token.symbol,
                                        address: token.address,
                                        decimals: token.decimals,
                                        balance: balFormatted,
                                        balanceRaw: balWei.toString(),
                                        priceUSD: token.priceUSD || 0
                                    });
                                }
                            }
                        } catch (e) {}
                    }
                });
            } catch (e) {}
        }));
    } catch (e) {}
    return discovered;
}

/**
 * Fallback price resolution via CoinGecko Free Simple Price API
 */
async function fetchCoinGeckoFallback(geckoIds) {
    if (!geckoIds || geckoIds.length === 0) return {};
    try {
        const url = `https://api.coingecko.com/api/v3/simple/price?ids=${geckoIds.join(',')}&vs_currencies=usd`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return {};
        const data = await res.json();
        const map = {};
        for (const [id, val] of Object.entries(data)) {
            if (val && typeof val.usd === 'number') {
                map[`coingecko:${id}`] = val.usd;
            }
        }
        return map;
    } catch (e) {
        return {};
    }
}

/**
 * Robust batch fetch real-time USD prices via DefiLlama with retry, cache, and CoinGecko fallback
 */
export async function fetchPricesBatch(priceKeys) {
    if (!priceKeys || priceKeys.length === 0) return {};

    const uniqueKeys = [...new Set(priceKeys)].filter(Boolean);
    const resultMap = {};

    // First, fill in any in-memory cached prices
    if (inMemoryPriceCache.prices) {
        for (const k of uniqueKeys) {
            if (inMemoryPriceCache.prices[k]) {
                resultMap[k] = inMemoryPriceCache.prices[k];
            }
        }
    }

    const missingKeys = uniqueKeys.filter(k => !resultMap[k]);
    const BATCH_SIZE = 35;
    const fetchBatches = [];

    for (let i = 0; i < missingKeys.length; i += BATCH_SIZE) {
        fetchBatches.push(missingKeys.slice(i, i + BATCH_SIZE));
    }

    for (const batch of fetchBatches) {
        let succeeded = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const url = `https://coins.llama.fi/prices/current/${batch.join(',')}`;
                const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
                if (res.ok) {
                    const data = await res.json();
                    if (data.coins) {
                        for (const [key, info] of Object.entries(data.coins)) {
                            if (info && typeof info.price === 'number') {
                                resultMap[key] = info.price;
                                inMemoryPriceCache.prices[key] = info.price;
                            }
                        }
                    }
                    succeeded = true;
                    break;
                }
            } catch (e) {
                if (attempt === 1) await new Promise(r => setTimeout(r, 400));
            }
        }

        // Secondary fallback to CoinGecko for coingecko:* keys that failed
        if (!succeeded) {
            const cgIds = batch
                .filter(k => k.startsWith('coingecko:'))
                .map(k => k.replace('coingecko:', ''));
            if (cgIds.length > 0) {
                const cgPrices = await fetchCoinGeckoFallback(cgIds);
                for (const [k, p] of Object.entries(cgPrices)) {
                    resultMap[k] = p;
                    inMemoryPriceCache.prices[k] = p;
                }
            }
        }
    }

    return resultMap;
}

/**
 * Main Multi-Chain Portfolio Scanner Engine
 * Features:
 * - Stale-While-Revalidate (SWR): Never wipes confirmed funds when an RPC drops on a slow network
 * - Adaptive worker pool to prevent socket exhaustion
 * - Instant token discovery on major chains via parallel Multicall3 & RouteScan
 * - Persistent local cache of verified holdings & prices
 */
export async function scanPortfolio(walletAddress, options = {}) {
    const {
        chains = null,
        savedTokens = [],
        deep = false,
        concurrency = 14,
        onProgress = () => {}
    } = options;

    const allChainsList = chains || getAllChains();
    
    // Load existing confirmed portfolio cache
    const cache = loadPortfolioCache(walletAddress);
    const cachedHoldings = cache.holdings;
    const cachedActive = cache.activeChains;

    // Determine target chains
    const priorityIds = new Set([
        ...POPULAR_CHAIN_IDS,
        ...cachedActive,
        1, 100, 8453, 137, 42161, 43114, 5031, 4326, 42220, 146, 57073, 999, 143, 534352, 4663, 56, 59144, 10, 592
    ]);

    let chainsToScan;
    if (chains && Array.isArray(chains)) {
        chainsToScan = chains;
    } else if (deep) {
        // Deep scan: priority chains first, followed by all remaining EVM chains
        const priorityList = allChainsList.filter(c => priorityIds.has(c.chainId));
        const restList = allChainsList.filter(c => !priorityIds.has(c.chainId));
        chainsToScan = [...priorityList, ...restList];
    } else {
        // Fast scan: scan priority / known active / popular chains
        chainsToScan = allChainsList.filter(c => priorityIds.has(c.chainId));
    }

    const totalChains = chainsToScan.length;
    let scannedCount = 0;
    const allDiscoveredAssets = [];
    const activeChainIds = new Set(cachedActive);
    const seenAssetKeys = new Set();
    const confirmedHoldingsMap = new Map(cachedHoldings);

    // =========================================================================
    // STEP 1: FAST TOKEN DISCOVERY (Multicall3 + RouteScan in parallel)
    // =========================================================================
    const tokenDiscoveryPromises = [];

    // A. RouteScan Multichain Indexer
    tokenDiscoveryPromises.push((async () => {
        try {
            const rtTokens = await fetchRoutescanTokens(walletAddress);
            for (const rt of rtTokens) {
                const key = `${rt.chainId}:${rt.address.toLowerCase()}`;
                if (!seenAssetKeys.has(key)) {
                    seenAssetKeys.add(key);
                    const matchingChain = getChain(rt.chainId);
                    activeChainIds.add(rt.chainId);
                    const assetObj = {
                        symbol: rt.symbol,
                        name: rt.name,
                        address: rt.address,
                        decimals: rt.decimals,
                        balance: rt.balance,
                        balanceRaw: rt.balanceRaw,
                        isNative: false,
                        chainId: rt.chainId,
                        chainName: matchingChain ? matchingChain.name : `Chain ${rt.chainId}`,
                        priceUSD: rt.priceUSD || 0
                    };
                    allDiscoveredAssets.push(assetObj);
                    confirmedHoldingsMap.set(key, assetObj);
                }
            }
        } catch (e) {}
    })());

    // B. Parallel Multicall3 on priority & active chains
    const multicallTargetIds = new Set([
        1, 56, 137, 42161, 8453, 10, 43114, 100, 42220, 146, 59144, 534352, 143, 592, 999, 5031,
        ...activeChainIds
    ]);

    const multicallBatches = Array.from(multicallTargetIds).map(async cId => {
        const commonTokens = COMMON_TOKENS_BY_CHAIN[cId] || [];
        const customForChain = savedTokens.filter(t => t.chainId === cId);
        let dynamicTokens = [];
        try {
            dynamicTokens = await getTokensForChain(cId);
        } catch (e) {}

        const seenForChain = new Set();
        const combined = [];
        const addCandidate = (t) => {
            if (!t || !t.address) return;
            const low = t.address.toLowerCase();
            if (low === '0x0000000000000000000000000000000000000000') return;
            if (!seenAssetKeys.has(`${cId}:${low}`) && !seenForChain.has(low)) {
                seenForChain.add(low);
                combined.push(t);
            }
        };

        commonTokens.forEach(addCandidate);
        customForChain.forEach(addCandidate);
        if (Array.isArray(dynamicTokens)) {
            dynamicTokens.forEach(addCandidate);
        }

        if (combined.length === 0) return;
        const chain = getChain(cId);
        if (!chain) return;

        const rpcList = chain.rpcList || [chain.rpc];
        let mcSucceeded = false;

        for (const url of rpcList.slice(0, 2)) {
            try {
                const p = new ethers.JsonRpcProvider(url, cId, {
                    staticNetwork: ethers.Network.from({ chainId: cId, name: chain.name })
                });
                const mcTokens = await fetchMulticallTokens(p, walletAddress, combined);
                for (const t of mcTokens) {
                    const key = `${cId}:${t.address.toLowerCase()}`;
                    if (!seenAssetKeys.has(key)) {
                        seenAssetKeys.add(key);
                        activeChainIds.add(cId);
                        const assetObj = {
                            ...t,
                            isNative: false,
                            chainId: cId,
                            chainName: chain.name
                        };
                        allDiscoveredAssets.push(assetObj);
                        confirmedHoldingsMap.set(key, assetObj);
                    }
                }
                mcSucceeded = true;
                break;
            } catch (e) {}
        }

        // If Multicall failed on this chain (network slow/timeout), retain previously verified cached tokens for this chain
        if (!mcSucceeded) {
            for (const [key, cachedToken] of cachedHoldings.entries()) {
                if (cachedToken.chainId === cId && !cachedToken.isNative) {
                    if (!seenAssetKeys.has(key) && parseFloat(cachedToken.balance) > 0.000001) {
                        seenAssetKeys.add(key);
                        activeChainIds.add(cId);
                        allDiscoveredAssets.push({ ...cachedToken, isFromCache: true });
                    }
                }
            }
        }
    });

    tokenDiscoveryPromises.push(Promise.allSettled(multicallBatches));
    await Promise.allSettled(tokenDiscoveryPromises);

    // =========================================================================
    // STEP 2: NATIVE BALANCE SCANNER (Controlled Adaptive Concurrency)
    // =========================================================================
    const queue = [...chainsToScan];
    const workerCount = Math.min(concurrency, queue.length);

    async function worker() {
        while (queue.length > 0) {
            const chain = queue.shift();
            if (!chain) break;

            if (!DUMMY_IGNORE_CHAINS.has(chain.chainId)) {
                const rpcList = (chain.rpcList && chain.rpcList.length > 0) ? chain.rpcList : [chain.rpc];
                let querySucceeded = false;
                let foundBalance = null;

                for (const rpcUrl of rpcList.slice(0, 2)) {
                    try {
                        const balWei = await getBalanceRaw(rpcUrl, walletAddress, deep ? 2200 : 2500);
                        querySucceeded = true;
                        foundBalance = balWei;
                        break;
                    } catch (e) {}
                }

                const key = `${chain.chainId}:native`;

                if (querySucceeded) {
                    if (foundBalance > 0n) {
                        const balFormatted = ethers.formatEther(foundBalance);
                        if (balFormatted.length < 32 && parseFloat(balFormatted) > 0.000001) {
                            activeChainIds.add(chain.chainId);
                            if (!seenAssetKeys.has(key)) {
                                seenAssetKeys.add(key);
                                const assetObj = {
                                    symbol: chain.currency,
                                    name: `${chain.name} Native`,
                                    address: '0x0000000000000000000000000000000000000000',
                                    decimals: chain.decimals || 18,
                                    balance: balFormatted,
                                    balanceRaw: foundBalance.toString(),
                                    isNative: true,
                                    chainId: chain.chainId,
                                    chainName: chain.name,
                                    coingeckoId: chain.coingeckoId
                                };
                                allDiscoveredAssets.push(assetObj);
                                confirmedHoldingsMap.set(key, assetObj);
                            }
                        }
                    } else {
                        // Confirmed 0 balance by RPC
                        confirmedHoldingsMap.delete(key);
                    }
                } else {
                    // All RPC queries failed or timed out due to slow network / rate limit
                    // Retain previously verified confirmed balance so mobile drops never wipe funds
                    const cachedAsset = cachedHoldings.get(key);
                    if (cachedAsset && parseFloat(cachedAsset.balance) > 0.000001) {
                        if (!seenAssetKeys.has(key)) {
                            seenAssetKeys.add(key);
                            activeChainIds.add(chain.chainId);
                            allDiscoveredAssets.push({ ...cachedAsset, isFromCache: true });
                        }
                    }
                }
            }

            scannedCount++;
            onProgress({
                scanned: Math.min(scannedCount, totalChains),
                total: totalChains,
                currentChain: chain.name,
                foundCount: allDiscoveredAssets.length
            });
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // =========================================================================
    // STEP 3: PRICE RESOLUTION (DefiLlama + CoinGecko + Stablecoin Fallbacks)
    // =========================================================================
    const chainSlugMap = {
        1: 'ethereum', 56: 'bsc', 137: 'polygon', 42161: 'arbitrum', 8453: 'base',
        10: 'optimism', 43114: 'avax', 42220: 'celo', 100: 'xdai', 250: 'fantom',
        324: 'zksync', 59144: 'linea', 534352: 'scroll', 81457: 'blast', 5000: 'mantle',
        146: 'sonic', 1116: 'core', 1088: 'metis', 252: 'fraxtal', 34443: 'mode',
        592: 'astar', 999: 'hyperliquid', 143: 'monad', 5031: 'somnia'
    };

    const priceKeys = [];
    for (const a of allDiscoveredAssets) {
        const symUpper = (a.symbol || '').toUpperCase();
        if (NATIVE_COIN_PRICE_KEYS[symUpper]) {
            priceKeys.push(NATIVE_COIN_PRICE_KEYS[symUpper]);
        }
        if (a.isNative) {
            const slug = chainSlugMap[a.chainId];
            if (slug) priceKeys.push(`${slug}:0x0000000000000000000000000000000000000000`);
        } else if (a.address && a.address !== '0x0000000000000000000000000000000000000000') {
            const slug = chainSlugMap[a.chainId] || 'ethereum';
            priceKeys.push(`${slug}:${a.address}`);
        }
    }

    const priceMap = await fetchPricesBatch(priceKeys);

    // =========================================================================
    // STEP 4: AGGREGATE TOTALS & DUST FILTERING
    // =========================================================================
    let grandTotalUSD = 0;
    const chainSummariesMap = new Map();
    const enrichedAssets = [];

    for (const a of allDiscoveredAssets) {
        const symUpper = (a.symbol || '').toUpperCase();
        let price = a.priceUSD || 0;

        if (!price) {
            const key = NATIVE_COIN_PRICE_KEYS[symUpper];
            if (key && priceMap[key]) {
                price = priceMap[key];
            } else {
                const slug = chainSlugMap[a.chainId] || 'ethereum';
                if (priceMap[`${slug}:${a.address}`]) {
                    price = priceMap[`${slug}:${a.address}`];
                } else if (slug && priceMap[`${slug}:0x0000000000000000000000000000000000000000`]) {
                    price = priceMap[`${slug}:0x0000000000000000000000000000000000000000`];
                }
            }
        }

        // Fallback for stablecoins if external price feed was slow/unreachable
        if (!price && STABLECOIN_SYMBOLS.has(symUpper)) {
            price = 1.0;
        }

        const balNum = parseFloat(a.balance);
        const valueUSD = balNum * price;

        // Skip negligible dust: balance < 0.000001 with 0 value
        if (balNum < 0.000001 && valueUSD < 0.001) continue;

        grandTotalUSD += valueUSD;

        const cId = a.chainId;
        if (!chainSummariesMap.has(cId)) {
            chainSummariesMap.set(cId, {
                chainId: cId,
                chainName: a.chainName,
                totalUSD: 0,
                assetCount: 0
            });
        }
        const cSum = chainSummariesMap.get(cId);
        cSum.totalUSD += valueUSD;
        cSum.assetCount += 1;

        const enrichedObj = {
            ...a,
            priceUSD: price,
            valueUSD: valueUSD,
            valueFormatted: valueUSD.toFixed(2)
        };
        enrichedAssets.push(enrichedObj);

        // Update confirmed holdings map with calculated price
        const assetKey = a.isNative ? `${cId}:native` : `${cId}:${a.address.toLowerCase()}`;
        confirmedHoldingsMap.set(assetKey, enrichedObj);
    }

    // Persist verified holdings, active chains, and prices
    savePortfolioCache(walletAddress, activeChainIds, confirmedHoldingsMap, priceMap);

    // Sort assets by USD value descending
    enrichedAssets.sort((a, b) => b.valueUSD - a.valueUSD);

    const chainSummaries = Array.from(chainSummariesMap.values()).map(c => ({
        ...c,
        totalUSDFormatted: c.totalUSD.toFixed(2),
        pctOfTotal: grandTotalUSD > 0 ? ((c.totalUSD / grandTotalUSD) * 100).toFixed(1) + '%' : '0%'
    })).sort((a, b) => b.totalUSD - a.totalUSD);

    return {
        walletAddress,
        grandTotalUSD: grandTotalUSD.toFixed(2),
        totalAssets: enrichedAssets.length,
        activeChainsCount: chainSummaries.length,
        chainSummaries,
        assets: enrichedAssets
    };
}
