#!/usr/bin/env node
import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { getPublicWallets, loadSettings, USER_SETTINGS } from './core.js';
import { getAllChains, getPopularChains, getChain, searchChains, testRpcLatency } from './chains.js';
import { scanPortfolio, loadCachedPortfolio } from './portfolio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Load settings
loadSettings();

// In-memory scan lock to prevent spamming RPCs
let activeScanPromise = null;
let activeScanAddr = null;

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    const pathname = reqUrl.pathname;

    // CORS Headers for API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Helper: JSON response
    const sendJson = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    };

    // Helper: Error response
    const sendError = (msg, status = 500) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
    };

    // --- API ROUTES ---

    // 1. Wallets List (100% Read-Only: Names & Public Addresses ONLY)
    if (pathname === '/api/wallets') {
        try {
            const wallets = getPublicWallets();
            return sendJson({
                success: true,
                wallets: wallets.map(w => ({ name: w.name, address: w.address }))
            });
        } catch (e) {
            return sendError(e.message);
        }
    }

    // 2. Portfolio Balance & Analytics
    if (pathname === '/api/portfolio') {
        const queryAddr = reqUrl.searchParams.get('address');
        const deep = reqUrl.searchParams.get('deep') === 'true';
        const refresh = reqUrl.searchParams.get('refresh') === 'true';

        let targetAddr = queryAddr;
        if (!targetAddr) {
            const wallets = getPublicWallets();
            if (wallets.length > 0) targetAddr = wallets[0].address;
        }

        if (!targetAddr) {
            return sendError('No wallet address specified or found in vault', 400);
        }

        try {
            // If refresh is NOT explicitly requested, try instant cached data (0ms)
            if (!refresh) {
                const cached = loadCachedPortfolio(targetAddr);
                if (cached && cached.assets.length > 0) {
                    return sendJson({
                        success: true,
                        cached: true,
                        portfolio: cached
                    });
                }
            }

            // Run live scan
            if (activeScanPromise && activeScanAddr === targetAddr.toLowerCase()) {
                const result = await activeScanPromise;
                return sendJson({ success: true, cached: false, portfolio: result });
            }

            activeScanAddr = targetAddr.toLowerCase();
            activeScanPromise = scanPortfolio(targetAddr, {
                deep: deep,
                savedTokens: USER_SETTINGS.savedTokens || []
            });

            const freshResult = await activeScanPromise;
            activeScanPromise = null;
            activeScanAddr = null;

            return sendJson({
                success: true,
                cached: false,
                portfolio: freshResult
            });
        } catch (e) {
            activeScanPromise = null;
            activeScanAddr = null;
            return sendError(e.message);
        }
    }

    // 3. 260+ Chains Directory
    if (pathname === '/api/chains') {
        try {
            const q = reqUrl.searchParams.get('q');
            let chains;
            if (q) {
                chains = searchChains(q);
            } else {
                chains = getAllChains();
            }
            return sendJson({
                success: true,
                total: chains.length,
                chains: chains
            });
        } catch (e) {
            return sendError(e.message);
        }
    }

    // 4. Ping Chain RPC Latency
    if (pathname === '/api/ping') {
        const chainId = parseInt(reqUrl.searchParams.get('chainId'));
        if (!chainId) return sendError('chainId query parameter required', 400);

        const chain = getChain(chainId);
        if (!chain) return sendError(`Chain ID ${chainId} not found in catalog`, 404);

        try {
            const pingRes = await testRpcLatency(chain);
            return sendJson({
                success: true,
                chain: chain.name,
                chainId: chain.chainId,
                ...pingRes
            });
        } catch (e) {
            return sendError(e.message);
        }
    }

    // 5. Export Portfolio CSV
    if (pathname === '/api/export/csv') {
        const targetAddr = reqUrl.searchParams.get('address');
        if (!targetAddr) return sendError('Address required', 400);

        try {
            const data = loadCachedPortfolio(targetAddr) || await scanPortfolio(targetAddr, { deep: false });
            let csv = 'Asset,Network,ChainId,Balance,PriceUSD,ValueUSD,ContractAddress\n';
            for (const a of data.assets) {
                csv += `"${a.symbol}","${a.chainName}",${a.chainId},"${a.balance}",${a.priceUSD || 0},${a.valueUSD || 0},"${a.address || '0x0'}"\n`;
            }
            res.writeHead(200, {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="portfolio_${targetAddr.slice(0, 8)}.csv"`
            });
            res.end(csv);
            return;
        } catch (e) {
            return sendError(e.message);
        }
    }

    // --- STATIC FILES SERVING ---
    let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

    // Security check: stay inside public dir
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Access Denied');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // Fallback to index.html for SPA
            filePath = path.join(PUBLIC_DIR, 'index.html');
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        fs.readFile(filePath, (readErr, content) => {
            if (readErr) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        });
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('\n======================================================');
    console.log('⚡ MULTI-WALLET PRO - WEB ANALYTICS DASHBOARD');
    console.log('======================================================');
    console.log(`🌐 Local URL:   http://localhost:${PORT}`);
    console.log(`📡 Network URL: http://0.0.0.0:${PORT}`);
    console.log('🔒 Security:    100% Read-Only Mode (Private Keys NEVER loaded)');
    console.log('⚡ Features:    Live Net Worth, 260+ EVM Chains, Token Analytics');
    console.log('======================================================\n');
});

export default server;
