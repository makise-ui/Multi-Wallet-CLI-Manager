import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHAINS_FILE = path.join(__dirname, 'data', 'chains.json');

let cachedChains = null;
let chainsById = new Map();
let chainsByKey = new Map();

export function loadChains() {
    if (cachedChains) return cachedChains;

    try {
        if (fs.existsSync(CHAINS_FILE)) {
            const raw = fs.readFileSync(CHAINS_FILE, 'utf8');
            cachedChains = JSON.parse(raw);
        } else {
            cachedChains = [];
        }
    } catch (e) {
        console.error('Failed to load chains.json:', e.message);
        cachedChains = [];
    }

    chainsById.clear();
    chainsByKey.clear();

    for (const chain of cachedChains) {
        chainsById.set(Number(chain.chainId), chain);
        if (chain.key) chainsByKey.set(chain.key.toLowerCase(), chain);
        if (chain.currency) chainsByKey.set(chain.currency.toLowerCase(), chain);
        if (chain.name) chainsByKey.set(chain.name.toLowerCase().replace(/[^a-z0-9]/g, ''), chain);
    }

    return cachedChains;
}

// Initial load
loadChains();

export const CHAIN_ALIASES = {
    // Somnia aliases & common typos
    'somi': 5031,
    'somu': 5031,
    'somia': 5031,
    'somnia': 5031,
    'som': 5031,
    // Monad aliases
    'mon': 143,
    'monad': 143,
    // HyperEVM / Hyperliquid
    'hype': 999,
    'hyperevm': 999,
    'hyperliquid': 999,
    'hyp': 999,
    // Astar aliases
    'astr': 592,
    'astar': 592,
    // Polygon aliases
    'matic': 137,
    'pol': 137,
    'polygon': 137,
    // Arbitrum
    'arb': 42161,
    'arbitrum': 42161,
    // Optimism
    'op': 10,
    'optimism': 10,
    // BSC
    'bsc': 56,
    'bnb': 56,
    'binance': 56,
    // Avalanche
    'avax': 43114,
    'avalanche': 43114,
    // Fantom
    'ftm': 250,
    'fantom': 250,
    // Gnosis
    'xdai': 100,
    'gnosis': 100,
    // Ethereum
    'eth': 1,
    'ethereum': 1,
    'mainnet': 1,
    // Celo
    'celo': 42220,
    // Sonic
    'sonic': 146,
    's': 146,
    // Berachain
    'bera': 80094,
    'berachain': 80094
};

export const POPULAR_CHAIN_IDS = [
    1,       // Ethereum
    56,      // BSC
    137,     // Polygon
    42161,   // Arbitrum One
    8453,    // Base
    10,      // OP Mainnet
    43114,   // Avalanche
    5031,    // Somnia (SOMI)
    143,     // Monad (MON)
    999,     // HyperEVM (HYPE)
    592,     // Astar (ASTR)
    100,     // Gnosis (xDAI)
    146,     // Sonic (S)
    42220,   // Celo (CELO)
    59144,   // Linea
    534352,  // Scroll
    81457,   // Blast
    5000,    // Mantle
    324,     // zkSync Era
    80094,   // Berachain
    250,     // Fantom
    1284,    // Moonbeam
    25,      // Cronos
    167000   // Taiko
];

export function getAllChains() {
    if (!cachedChains) loadChains();
    return cachedChains;
}

export function getPopularChains() {
    if (!cachedChains) loadChains();
    const result = [];
    for (const id of POPULAR_CHAIN_IDS) {
        const c = chainsById.get(id);
        if (c) result.push(c);
    }
    return result;
}

export function getBridgeEnabledChains() {
    if (!cachedChains) loadChains();
    return cachedChains.filter(c => c.hasSwapBridge);
}

function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

export function getChain(idOrKey) {
    if (!cachedChains) loadChains();
    if (!idOrKey) return null;

    if (typeof idOrKey === 'number' || (!isNaN(idOrKey) && !isNaN(parseFloat(idOrKey)))) {
        const num = Number(idOrKey);
        if (chainsById.has(num)) return chainsById.get(num);
    }

    const str = String(idOrKey).toLowerCase().trim();
    if (CHAIN_ALIASES[str] && chainsById.has(CHAIN_ALIASES[str])) {
        return chainsById.get(CHAIN_ALIASES[str]);
    }

    const cleanStr = str.replace(/\b(chain|network|mainnet|testnet|l2|rollup|evm|net)\b/gi, '').trim();
    if (cleanStr && CHAIN_ALIASES[cleanStr] && chainsById.has(CHAIN_ALIASES[cleanStr])) {
        return chainsById.get(CHAIN_ALIASES[cleanStr]);
    }

    if (chainsByKey.has(str)) return chainsByKey.get(str);
    if (cleanStr && chainsByKey.has(cleanStr)) return chainsByKey.get(cleanStr);

    const sanitized = str.replace(/[^a-z0-9]/g, '');
    if (chainsByKey.has(sanitized)) return chainsByKey.get(sanitized);

    // Fallback: search partial match
    for (const c of cachedChains) {
        if (c.name.toLowerCase() === str || c.key.toLowerCase() === str || c.currency.toLowerCase() === str ||
            (cleanStr && (c.name.toLowerCase() === cleanStr || c.currency.toLowerCase() === cleanStr))) {
            return c;
        }
    }

    return null;
}

export function searchChains(query) {
    if (!cachedChains) loadChains();
    if (!query || typeof query !== 'string' || query.trim() === '') {
        const pop = getPopularChains();
        return pop.length > 0 ? pop : cachedChains.slice(0, 50);
    }

    const rawQ = query.toLowerCase().trim();
    const cleanQ = rawQ.replace(/\b(chain|network|mainnet|testnet|l2|rollup|evm|net)\b/gi, '').trim();
    const tokens = (cleanQ || rawQ).split(/\s+/).filter(t => t.length > 0);

    const scored = [];

    for (const c of cachedChains) {
        let score = 0;
        const nameLower = (c.name || '').toLowerCase();
        const currLower = (c.currency || '').toLowerCase();
        const keyLower = (c.key || '').toLowerCase();
        const idStr = String(c.chainId);

        // Exact ID match
        if (idStr === rawQ || idStr === cleanQ) {
            score = Math.max(score, 1000);
        }

        // Direct alias match
        const aliasIdRaw = CHAIN_ALIASES[rawQ];
        const aliasIdClean = cleanQ ? CHAIN_ALIASES[cleanQ] : null;
        if (aliasIdRaw === c.chainId || aliasIdClean === c.chainId) {
            score = Math.max(score, 900);
        }

        // Exact currency/symbol match
        if (currLower === rawQ || (cleanQ && currLower === cleanQ)) {
            score = Math.max(score, 850);
        }

        // Exact name match
        if (nameLower === rawQ || (cleanQ && nameLower === cleanQ)) {
            score = Math.max(score, 800);
        }

        // Exact key match
        if (keyLower === rawQ || (cleanQ && keyLower === cleanQ)) {
            score = Math.max(score, 750);
        }

        // Starts-with match
        if (cleanQ && (nameLower.startsWith(cleanQ) || currLower.startsWith(cleanQ))) {
            score = Math.max(score, 600);
        }

        // Multi-word token match (e.g. "somnia network" or "astar mainnet")
        if (tokens.length > 0 && tokens.every(tok => nameLower.includes(tok) || currLower.includes(tok) || keyLower.includes(tok))) {
            score = Math.max(score, 500);
        }

        // Substring match
        if (nameLower.includes(rawQ) || currLower.includes(rawQ) || (cleanQ && (nameLower.includes(cleanQ) || currLower.includes(cleanQ)))) {
            score = Math.max(score, 400);
        }

        // Fuzzy match for short typos (e.g. "somu", "somia")
        const target = cleanQ || rawQ;
        if (target.length >= 3 && score === 0) {
            const dName = levenshteinDistance(target, nameLower);
            const dCurr = levenshteinDistance(target, currLower);
            const minD = Math.min(dName, dCurr);
            if (minD <= 2) {
                score = Math.max(score, 250 - minD * 50);
            }
        }

        if (score > 0) {
            scored.push({ chain: c, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.chain);
}

// Provider cache with fallback support
const providerCache = new Map();

export function getProvider(idOrKey) {
    const chain = getChain(idOrKey);
    if (!chain) {
        throw new Error(`Chain not found: ${idOrKey}`);
    }

    if (providerCache.has(chain.chainId)) {
        return providerCache.get(chain.chainId);
    }

    const rpcList = (chain.rpcList && chain.rpcList.length > 0) ? chain.rpcList : [chain.rpc];
    // Create fallback or standard provider
    const provider = new ethers.JsonRpcProvider(rpcList[0], chain.chainId, {
        staticNetwork: ethers.Network.from({
            chainId: chain.chainId,
            name: chain.name
        })
    });

    providerCache.set(chain.chainId, provider);
    return provider;
}

export async function getWorkingProvider(idOrKey) {
    const chain = getChain(idOrKey);
    if (!chain) throw new Error(`Chain not found: ${idOrKey}`);

    const rpcList = (chain.rpcList && chain.rpcList.length > 0) ? chain.rpcList : [chain.rpc];
    for (const url of rpcList) {
        try {
            const p = new ethers.JsonRpcProvider(url, chain.chainId, {
                staticNetwork: ethers.Network.from({
                    chainId: chain.chainId,
                    name: chain.name
                })
            });
            await Promise.race([
                p.getBlockNumber(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
            ]);
            providerCache.set(chain.chainId, p);
            return p;
        } catch (e) {
            // Try next RPC
        }
    }

    return getProvider(chain.chainId);
}

// Test RPC latency
export async function testRpcLatency(chain) {
    const start = Date.now();
    try {
        const provider = getProvider(chain.chainId);
        const block = await Promise.race([
            provider.getBlockNumber(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('RPC Timeout')), 4000))
        ]);
        const latency = Date.now() - start;
        return { ok: true, latency, block };
    } catch (e) {
        return { ok: false, latency: Date.now() - start, error: e.message };
    }
}
