#!/usr/bin/env node
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { ethers } from 'ethers';
import {
    loadSettings,
    hasEncryptedWallets,
    unlockWallets,
    loadPublicWallets,
    DECRYPTED_WALLETS,
    USER_SETTINGS
} from './core.js';
import {
    getAllChains,
    getPopularChains,
    getChain,
    searchChains,
    testRpcLatency,
    getWorkingProvider
} from './chains.js';
import {
    getTokensForChain,
    getQuote,
    executeQuote,
    checkTransferStatus
} from './swapBridge.js';
import {
    scanPortfolio,
    loadCachedPortfolio
} from './portfolio.js';

// --- Screen Initialization ---
const screen = blessed.screen({
    smartCSR: true,
    title: 'Multi-Wallet CLI Manager Pro | Advanced Web3 Terminal',
    cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: 'cyan'
    }
});

// Theme Colors
const THEME = {
    bg: '#0f172a',
    fg: '#f8fafc',
    border: 'cyan',
    accent: 'blue',
    success: 'green',
    warning: 'yellow',
    danger: 'red',
    muted: 'grey'
};

// --- Application State ---
let currentWalletIndex = 0;
let currentChainId = 1; // Default to Ethereum
let activeTab = 0; // 0: Portfolio, 1: Swap/Bridge, 2: Chains, 3: Transfer, 4: Wallets, 5: Logs
let portfolioData = null;
let isScanning = false;
let currentQuote = null;
let isQuoting = false;
let isExecuting = false;

// Swap Form State
let swapState = {
    fromChainId: 1,
    toChainId: 137,
    fromTokenAddress: '0x0000000000000000000000000000000000000000',
    toTokenAddress: '0x0000000000000000000000000000000000000000',
    fromAmount: '0.05',
    slippage: 0.005,
    fromTokens: [],
    toTokens: []
};

// --- Top Header ---
const headerBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    style: {
        bg: 'blue',
        fg: 'white',
        bold: true
    },
    content: '  [MULTI-WALLET PRO v2.0] Initializing...'
});

// --- Tab Bar ---
const TAB_LABELS = [
    ' [1] Portfolio ',
    ' [2] Swap & Bridge ',
    ' [3] 260+ Chains ',
    ' [4] Transfer ',
    ' [5] Wallets ',
    ' [6] Logs '
];

const tabBar = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: '100%',
    height: 1,
    style: {
        bg: 'black',
        fg: 'cyan'
    }
});

function renderTabBar() {
    let content = ' ';
    TAB_LABELS.forEach((label, idx) => {
        if (idx === activeTab) {
            content += `{bold}{blue-bg}{white-fg}${label}{/white-fg}{/blue-bg}{/bold} `;
        } else {
            content += `{grey-fg}${label}{/grey-fg} `;
        }
    });
    content += '{right}{grey-fg}[r: Fast Scan (3s) | d: Deep Scan 260+ | Tab: Next | 1-6: Jump | q: Quit]{/grey-fg}{/right}';
    tabBar.setContent(content);
    tabBar.tags = true;
}

// --- Main Content Container ---
const mainContainer = blessed.box({
    parent: screen,
    top: 4,
    left: 0,
    width: '100%',
    height: '100%-6'
});

// --- Bottom Status Bar ---
const statusBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 2,
    style: {
        bg: '#1e293b',
        fg: 'white'
    },
    tags: true,
    content: ' {cyan-fg}Status:{/cyan-fg} Ready. Press {yellow-fg}[f/d]{/yellow-fg} for Full Scan 260+, {yellow-fg}[r]{/yellow-fg} for Fast Scan, {yellow-fg}[m]{/yellow-fg} for Menu, {yellow-fg}[s]{/yellow-fg} for Swap/Bridge.'
});

function setStatus(msg, type = 'info') {
    let color = 'cyan-fg';
    if (type === 'success') color = 'green-fg';
    if (type === 'warning') color = 'yellow-fg';
    if (type === 'error') color = 'red-fg';
    statusBar.setContent(` {${color}}Status:{/${color}} ${msg}`);
    screen.render();
}

function updateHeader() {
    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    const chain = getChain(currentChainId);
    const walletName = wallet ? wallet.name : 'No Wallet';
    const addr = wallet ? `${wallet.wallet.address.slice(0, 6)}...${wallet.wallet.address.slice(-4)}` : 'None';
    const chainName = chain ? chain.name : 'Unknown';
    const totalUSD = portfolioData ? `$${portfolioData.grandTotalUSD}` : '$0.00';
    const timeStr = new Date().toLocaleTimeString();

    headerBox.setContent(
        `  {bold}MULTI-WALLET PRO{/bold} | [Wallet: {yellow-fg}${walletName}{/yellow-fg} ({cyan-fg}${addr}{/cyan-fg})] | [Network: {magenta-fg}${chainName}{/magenta-fg}] | [Net Worth: {green-fg}${totalUSD}{/green-fg}] | [${timeStr}]`
    );
    headerBox.tags = true;
    screen.render();
}

// ==========================================
// VIEW 0: PORTFOLIO
// ==========================================
const portfolioView = blessed.box({
    parent: mainContainer,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%'
});

// KPI Summary Cards
const kpiBox = blessed.box({
    parent: portfolioView,
    top: 0,
    left: 0,
    width: '100%',
    height: 4,
    border: { type: 'line', fg: 'cyan' },
    style: { fg: 'white' },
    tags: true,
    content: ' Loading Portfolio Overview...'
});

// Portfolio Action Bar with Quick Scan Buttons
const portfolioActionBar = blessed.box({
    parent: portfolioView,
    top: 4,
    left: 0,
    width: '100%',
    height: 3,
    style: { bg: 'default' },
    tags: true
});

const btnFastScan = blessed.button({
    parent: portfolioActionBar,
    top: 0,
    left: 1,
    width: 20,
    height: 3,
    border: { type: 'line' },
    content: ' ⚡ Fast Scan (r) ',
    mouse: true,
    style: {
        bg: 'blue',
        fg: 'white',
        bold: true,
        focus: { bg: 'cyan', fg: 'black' }
    }
});

const btnFullScan = blessed.button({
    parent: portfolioActionBar,
    top: 0,
    left: 23,
    width: 27,
    height: 3,
    border: { type: 'line' },
    content: ' 🔬 FULL SCAN 260+ (f) ',
    mouse: true,
    style: {
        bg: 'magenta',
        fg: 'white',
        bold: true,
        focus: { bg: 'white', fg: 'black' }
    }
});

const btnScanMenu = blessed.button({
    parent: portfolioActionBar,
    top: 0,
    left: 52,
    width: 19,
    height: 3,
    border: { type: 'line' },
    content: ' ⚙️ Options (m) ',
    mouse: true,
    style: {
        bg: 'yellow',
        fg: 'black',
        bold: true,
        focus: { bg: 'white', fg: 'black' }
    }
});

const scanHints = blessed.box({
    parent: portfolioActionBar,
    top: 1,
    left: 73,
    width: '100%-74',
    height: 1,
    tags: true,
    content: 'Hotkeys: {bold}{magenta-fg}[f/d]{/magenta-fg}{/bold} Deep Full Scan (260+) | {bold}{cyan-fg}[r]{/cyan-fg}{/bold} Fast Scan | {bold}{yellow-fg}[m]{/yellow-fg}{/bold} Options'
});

btnFastScan.on('press', () => refreshPortfolioView(false));
btnFastScan.on('click', () => refreshPortfolioView(false));
btnFullScan.on('press', () => refreshPortfolioView(true));
btnFullScan.on('click', () => refreshPortfolioView(true));
btnScanMenu.on('press', () => promptScanOptionsModal());
btnScanMenu.on('click', () => promptScanOptionsModal());

// Left: Active Chains Table
const portfolioChainsTable = contrib.table({
    parent: portfolioView,
    top: 7,
    left: 0,
    width: '35%',
    height: '100%-7',
    keys: true,
    interactive: true,
    fg: 'white',
    selectedFg: 'white',
    selectedBg: 'blue',
    label: ' Active Chains Summary ',
    border: { type: 'line', fg: 'cyan' },
    columnSpacing: 2,
    columnWidth: [14, 6, 11, 8]
});

// Right: Detailed Assets Table
const portfolioAssetsTable = contrib.table({
    parent: portfolioView,
    top: 7,
    left: '35%',
    width: '65%',
    height: '100%-7',
    keys: true,
    interactive: true,
    fg: 'white',
    selectedFg: 'white',
    selectedBg: 'blue',
    label: ' Auto-Detected Tokens & Balances ',
    border: { type: 'line', fg: 'cyan' },
    columnSpacing: 2,
    columnWidth: [9, 13, 14, 11, 11]
});

function renderPortfolioData(res) {
    if (!res) return;
    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    if (!wallet) return;

    portfolioData = res;

    // Render KPI
    kpiBox.setContent(
        `  {bold}NET WORTH:{/bold} {green-fg}$${res.grandTotalUSD} USD{/green-fg}   |   ` +
        `{bold}ACTIVE CHAINS:{/bold} {cyan-fg}${res.activeChainsCount}{/cyan-fg}   |   ` +
        `{bold}TOTAL ASSETS HELD:{/bold} {yellow-fg}${res.totalAssets}{/yellow-fg}   |   ` +
        `{bold}WALLET:{/bold} {grey-fg}${wallet.wallet.address}{/grey-fg}`
    );
    kpiBox.tags = true;

    // Render Chains Summary
    const chainsData = res.chainSummaries.map(c => [
        c.chainName.slice(0, 14),
        String(c.assetCount),
        `$${c.totalUSDFormatted}`,
        c.pctOfTotal
    ]);

    portfolioChainsTable.setData({
        headers: ['Chain', 'Assets', 'Value ($)', 'Share'],
        data: chainsData.length > 0 ? chainsData : [['No assets', '0', '$0.00', '0%']]
    });

    // Render Assets
    const assetsData = res.assets.map(a => [
        a.symbol.slice(0, 9),
        a.chainName.slice(0, 13),
        parseFloat(a.balance).toFixed(4),
        a.priceUSD ? `$${a.priceUSD.toFixed(2)}` : '$0.00',
        `$${a.valueFormatted}`
    ]);

    portfolioAssetsTable.setData({
        headers: ['Asset', 'Network', 'Balance', 'Price ($)', 'Value ($)'],
        data: assetsData.length > 0 ? assetsData : [['No tokens found', '-', '0.0000', '$0.00', '$0.00']]
    });

    updateHeader();
    screen.render();
}

async function refreshPortfolioView(deep = false, targetChains = null) {
    if (DECRYPTED_WALLETS.length === 0) return;
    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    if (!wallet || isScanning) return;

    // If no portfolio data displayed yet, instantly render cached data (0ms)
    if (!portfolioData) {
        const cached = loadCachedPortfolio(wallet.wallet.address);
        if (cached) {
            renderPortfolioData(cached);
        }
    }

    isScanning = true;
    let modeLabel;
    if (targetChains && targetChains.length === 1) {
        modeLabel = `Scanning ${targetChains[0].name} (Chain ID: ${targetChains[0].chainId})`;
    } else if (deep) {
        modeLabel = 'Deep Scanning all 260+ EVM chains';
    } else {
        modeLabel = 'Fast scanning active holdings & major networks';
    }

    setStatus(`${modeLabel}...`, 'warning');
    screen.render();

    try {
        const res = await scanPortfolio(wallet.wallet.address, {
            deep: deep,
            chains: targetChains,
            savedTokens: USER_SETTINGS.savedTokens || [],
            onProgress: (p) => {
                const scanType = (targetChains && targetChains.length === 1) ? 'Single Chain' : (deep ? 'Deep Scan' : 'Fast Scan');
                setStatus(`${scanType}: ${p.scanned}/${p.total} (${p.currentChain}) - Found ${p.foundCount} assets...`, 'warning');
            }
        });

        renderPortfolioData(res);
        setStatus(`✅ Portfolio updated! Grand Total: $${res.grandTotalUSD} across ${res.activeChainsCount} chains.`, 'success');
    } catch (e) {
        setStatus(`❌ Scan failed: ${e.message}`, 'error');
    } finally {
        isScanning = false;
        screen.render();
    }
}

// Modal: Scan Options Selector
function promptScanOptionsModal() {
    const modal = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 64,
        height: 14,
        border: { type: 'line', fg: 'yellow' },
        style: { bg: '#0f172a', fg: 'white' },
        label: ' 🔬 Select Portfolio Scan Mode '
    });

    const options = [
        '⚡ Fast Scan (~3s) - Active holdings & top 35 networks',
        '🔬 Deep Full Scan (~15-20s) - All 260+ EVM chains',
        '🎯 Scan Specific Chain - Choose any chain from 260+ list',
        '❌ Cancel'
    ];

    const optList = blessed.list({
        parent: modal,
        top: 1,
        left: 2,
        width: 58,
        height: 10,
        keys: true,
        vi: true,
        mouse: true,
        border: { type: 'line' },
        style: { selected: { bg: 'yellow', fg: 'black', bold: true } },
        items: options.map(o => ` ${o}`)
    });

    optList.on('select', (item, index) => {
        modal.detach();
        screen.render();
        if (index === 0) {
            refreshPortfolioView(false);
        } else if (index === 1) {
            refreshPortfolioView(true);
        } else if (index === 2) {
            promptScanSingleChainModal();
        }
    });

    optList.key(['escape', 'q'], () => {
        modal.detach();
        screen.render();
    });

    optList.focus();
    screen.render();
}

// Modal: Pick single chain to scan
function promptScanSingleChainModal() {
    const modal = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 66,
        height: 20,
        border: { type: 'line', fg: 'cyan' },
        style: { bg: '#0f172a', fg: 'white' },
        label: ' 🎯 Select Chain to Scan (260+ Chains) '
    });

    const allChains = getAllChains();
    const chainItems = allChains.map(c => ` ${c.name} (${c.currency} - ID: ${c.chainId})`);

    const chainList = blessed.list({
        parent: modal,
        top: 1,
        left: 2,
        width: 60,
        height: 16,
        keys: true,
        vi: true,
        mouse: true,
        border: { type: 'line' },
        style: { selected: { bg: 'cyan', fg: 'black', bold: true } },
        items: chainItems
    });

    chainList.on('select', (item, index) => {
        const selectedChain = allChains[index];
        modal.detach();
        screen.render();
        if (selectedChain) {
            refreshPortfolioView(false, [selectedChain]);
        }
    });

    chainList.key(['escape', 'q'], () => {
        modal.detach();
        screen.render();
    });

    chainList.focus();
    screen.render();
}

// ==========================================
// VIEW 1: SWAP & BRIDGE
// ==========================================
const swapView = blessed.box({
    parent: mainContainer,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true
});

// Left: Controls & Form
const swapFormBox = blessed.box({
    parent: swapView,
    top: 0,
    left: 0,
    width: '45%',
    height: '100%',
    border: { type: 'line', fg: 'cyan' },
    label: ' 🔄 Swap & Cross-Chain Bridge Configuration '
});

// Right: Live Estimation & Route Breakdown Card
const quoteCardBox = blessed.box({
    parent: swapView,
    top: 0,
    left: '45%',
    width: '55%',
    height: '65%',
    border: { type: 'line', fg: 'magenta' },
    label: ' ⚡ Live Route Estimation & Output Breakdown ',
    tags: true,
    content: ' Configure your pair on the left and click [GET QUOTE] or press Enter.'
});

// Swap Activity & Execution Log
const swapLogBox = blessed.log({
    parent: swapView,
    top: '65%',
    left: '45%',
    width: '55%',
    height: '35%',
    border: { type: 'line', fg: 'green' },
    label: ' 📜 Execution Status & Bridge Tracker ',
    tags: true,
    scrollable: true
});

// Swap Form Interactive Fields
const swapFormLabels = blessed.box({
    parent: swapFormBox,
    top: 1,
    left: 2,
    width: '92%',
    height: 12,
    tags: true
});

function updateSwapFormText() {
    const fromChain = getChain(swapState.fromChainId);
    const toChain = getChain(swapState.toChainId);
    const isCross = swapState.fromChainId !== swapState.toChainId;

    let text = ``;
    text += `{bold}1. Source Chain:{/bold}      {cyan-fg}${fromChain ? fromChain.name : swapState.fromChainId}{/cyan-fg} (ID: ${swapState.fromChainId})\n`;
    text += `{bold}2. Source Token:{/bold}      {yellow-fg}${swapState.fromTokenSymbol || 'ETH'}{/yellow-fg}\n`;
    text += `{bold}3. Dest Chain:{/bold}        {magenta-fg}${toChain ? toChain.name : swapState.toChainId}{/magenta-fg} (ID: ${swapState.toChainId})\n`;
    text += `{bold}4. Dest Token:{/bold}        {yellow-fg}${swapState.toTokenSymbol || 'POL'}{/yellow-fg}\n`;
    text += `{bold}5. Amount In:{/bold}          {green-fg}${swapState.fromAmount}{/green-fg} ${swapState.fromTokenSymbol || 'ETH'}\n`;
    text += `{bold}6. Slippage Limit:{/bold}     {cyan-fg}${(swapState.slippage * 100).toFixed(1)}%{/cyan-fg}\n`;
    text += `{bold}7. Mode:{/bold}               ${isCross ? '{blue-bg}{white-fg} CROSS-CHAIN BRIDGE {/white-fg}{/blue-bg}' : '{green-bg}{black-fg} SAME-CHAIN SWAP {/black-fg}{/green-bg}'}\n`;

    swapFormLabels.setContent(text);
    screen.render();
}

// Action Buttons
const btnGetQuote = blessed.button({
    parent: swapFormBox,
    top: 14,
    left: 2,
    width: 20,
    height: 3,
    border: { type: 'line' },
    content: ' GET QUOTE ',
    style: {
        bg: 'blue',
        fg: 'white',
        focus: { bg: 'cyan', fg: 'black' }
    }
});

const btnExecute = blessed.button({
    parent: swapFormBox,
    top: 14,
    left: 25,
    width: 22,
    height: 3,
    border: { type: 'line' },
    content: ' EXECUTE ROUTE ',
    style: {
        bg: 'green',
        fg: 'black',
        focus: { bg: 'white', fg: 'black' }
    }
});

const swapInstructions = blessed.box({
    parent: swapFormBox,
    top: 18,
    left: 2,
    width: '92%',
    height: 10,
    tags: true,
    content:
        `{bold}Quick Controls:{/bold}\n` +
        `• Press {yellow-fg}[q]{/yellow-fg} on this tab to fetch a quote\n` +
        `• Press {yellow-fg}[x]{/yellow-fg} to execute swap/bridge\n` +
        `• Press {yellow-fg}[f]{/yellow-fg} to change Source Chain/Token\n` +
        `• Press {yellow-fg}[t]{/yellow-fg} to change Dest Chain/Token\n` +
        `• Press {yellow-fg}[a]{/yellow-fg} to set Amount In`
});

async function fetchLiveQuote() {
    if (DECRYPTED_WALLETS.length === 0) return;
    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    if (!wallet || isQuoting) return;

    isQuoting = true;
    quoteCardBox.setContent('  {yellow-fg}⏳ Fetching best route across 36 DEXs & 36 bridges...{/yellow-fg}');
    setStatus('Fetching quote from LI.FI aggregator...', 'warning');
    screen.render();

    try {
        const quote = await getQuote({
            fromChainId: swapState.fromChainId,
            toChainId: swapState.toChainId,
            fromTokenAddress: swapState.fromTokenAddress,
            toTokenAddress: swapState.toTokenAddress,
            fromAmount: swapState.fromAmount,
            fromAddress: wallet.wallet.address,
            slippage: swapState.slippage
        });

        currentQuote = quote;

        let content = `\n`;
        content += `  {bold}⚡ ROUTE FOUND BY:{/bold} {cyan-fg}${quote.provider.toUpperCase()}{/cyan-fg} (${quote.isCrossChain ? 'Cross-Chain Bridge' : 'DEX Aggregator'})\n\n`;
        content += `  {bold}YOU PAY:{/bold}               {yellow-fg}${quote.fromAmount} ${quote.fromToken.symbol}{/yellow-fg} on {bold}${quote.fromChain.name}{/bold}\n`;
        content += `  {bold}EST. OUTPUT:{/bold}           {green-fg}{bold}${quote.toAmount} ${quote.toToken.symbol}{/bold}{/green-fg} on {bold}${quote.toChain.name}{/bold}\n`;
        content += `  {bold}GUARANTEED MIN:{/bold}        {white-fg}${quote.toAmountMin} ${quote.toToken.symbol}{/white-fg}\n\n`;
        content += `  {bold}EXCHANGE RATE:{/bold}         ${quote.exchangeRate}\n`;
        content += `  {bold}EST. DURATION:{/bold}         {magenta-fg}${quote.durationFormatted}{/magenta-fg}\n`;
        content += `  {bold}EST. GAS COST:{/bold}         ${quote.gasCostUSD ? '$' + quote.gasCostUSD : 'N/A'}\n`;
        content += `  {bold}BRIDGE/DEX FEES:{/bold}       ${quote.feeCostUSD ? '$' + quote.feeCostUSD : '$0.00'}\n`;
        content += `  {bold}TOTAL ROUTE FEES:{/bold}      {yellow-fg}$${quote.totalFeesUSD}{/yellow-fg}\n`;
        content += `  {bold}MAX SLIPPAGE:{/bold}          ${quote.slippagePct}\n\n`;
        content += `  {green-bg}{black-fg} READY TO BROADCAST {/black-fg}{/green-bg} Press {yellow-fg}[x]{/yellow-fg} or click [EXECUTE ROUTE]`;

        quoteCardBox.setContent(content);
        swapLogBox.log(`[${new Date().toLocaleTimeString()}] ✅ Quote received: ${quote.fromAmount} ${quote.fromToken.symbol} -> ~${quote.toAmount} ${quote.toToken.symbol} via ${quote.provider}`);
        setStatus(`Quote ready! Est Output: ${quote.toAmount} ${quote.toToken.symbol} (~${quote.durationFormatted})`, 'success');
    } catch (e) {
        currentQuote = null;
        quoteCardBox.setContent(`\n  {red-fg}❌ Quote Error:{/red-fg}\n  ${e.message}\n\n  Tip: Ensure the amount is valid and liquidity exists for this pair.`);
        swapLogBox.log(`[${new Date().toLocaleTimeString()}] ❌ Quote failed: ${e.message}`);
        setStatus(`Quote error: ${e.message}`, 'error');
    } finally {
        isQuoting = false;
        screen.render();
    }
}

async function executeCurrentQuote() {
    if (!currentQuote) {
        setStatus('No quote available. Press [GET QUOTE] first.', 'warning');
        return;
    }
    if (isExecuting) return;

    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    if (!wallet) return;

    if (!wallet.isUnlocked || typeof wallet.wallet.connect !== 'function') {
        const unlocked = await promptUnlockModal('Authorize Swap/Bridge');
        if (!unlocked) {
            setStatus('Operation cancelled: Vault is locked.', 'warning');
            return;
        }
    }

    isExecuting = true;
    swapLogBox.log(`[${new Date().toLocaleTimeString()}] 🚀 Initiating transaction for ${wallet.name}...`);
    setStatus('Executing swap/bridge transaction...', 'warning');

    try {
        const provider = await getWorkingProvider(currentQuote.fromChain.id);
        const signer = DECRYPTED_WALLETS[currentWalletIndex].wallet.connect(provider);

        const result = await executeQuote(signer, currentQuote, (status) => {
            swapLogBox.log(`[${new Date().toLocaleTimeString()}] ⚙️ ${status.message}`);
            setStatus(status.message, 'warning');
            screen.render();
        });

        swapLogBox.log(`[${new Date().toLocaleTimeString()}] ✅ Transmit confirmed in block ${result.blockNumber}! Hash: ${result.hash}`);
        setStatus(`✅ Transaction Confirmed! Tx: ${result.hash.slice(0, 10)}...`, 'success');

        if (result.isCrossChain) {
            swapLogBox.log(`[${new Date().toLocaleTimeString()}] 🌉 Cross-chain transfer active. Tracking status...`);
            // Poll bridge status
            let attempts = 0;
            const pollInterval = setInterval(async () => {
                attempts++;
                if (attempts > 30) {
                    clearInterval(pollInterval);
                    return;
                }
                const st = await checkTransferStatus(result.hash, currentQuote.fromChain.id, currentQuote.toChain.id);
                if (st && st.status === 'DONE') {
                    swapLogBox.log(`[${new Date().toLocaleTimeString()}] 🎉 Bridge Transfer Completed on destination chain!`);
                    setStatus('🎉 Bridge Transfer Completed!', 'success');
                    clearInterval(pollInterval);
                }
            }, 6000);
        }
    } catch (e) {
        swapLogBox.log(`[${new Date().toLocaleTimeString()}] ❌ Execution failed: ${e.message}`);
        setStatus(`Execution failed: ${e.message}`, 'error');
    } finally {
        isExecuting = false;
        screen.render();
    }
}

btnGetQuote.on('press', () => fetchLiveQuote());
btnExecute.on('press', () => executeCurrentQuote());

// Modal for setting amount
function promptAmount() {
    const promptBox = blessed.textbox({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 40,
        height: 6,
        border: { type: 'line', fg: 'cyan' },
        label: ' Enter Amount In ',
        inputOnFocus: true,
        style: { bg: 'blue', fg: 'white' }
    });

    promptBox.setValue(swapState.fromAmount);
    promptBox.focus();
    screen.render();

    promptBox.key('enter', () => {
        const val = promptBox.getValue().trim();
        if (val && !isNaN(parseFloat(val))) {
            swapState.fromAmount = val;
            updateSwapFormText();
            fetchLiveQuote();
        }
        promptBox.detach();
        screen.render();
    });

    promptBox.key(['escape'], () => {
        promptBox.detach();
        screen.render();
    });
}

function promptChainAndTokenModal(title, isSource = true) {
    const modal = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 60,
        height: 18,
        border: { type: 'line', fg: 'cyan' },
        style: { bg: '#0f172a', fg: 'white' },
        label: ` ${title} `
    });

    const popular = getPopularChains();
    const chainItems = popular.map(c => ` ${c.name} (${c.currency} - ID ${c.chainId})`);

    const chainList = blessed.list({
        parent: modal,
        top: 1,
        left: 2,
        width: 54,
        height: 14,
        keys: true,
        vi: true,
        border: { type: 'line' },
        style: { selected: { bg: 'blue', fg: 'white', bold: true } },
        items: chainItems
    });

    chainList.on('select', async (item, index) => {
        const selectedChain = popular[index];
        modal.detach();
        screen.render();

        if (isSource) {
            swapState.fromChainId = selectedChain.chainId;
            swapState.fromTokenSymbol = selectedChain.currency;
            swapState.fromTokenAddress = '0x0000000000000000000000000000000000000000';
        } else {
            swapState.toChainId = selectedChain.chainId;
            swapState.toTokenSymbol = selectedChain.currency;
            swapState.toTokenAddress = '0x0000000000000000000000000000000000000000';
        }
        updateSwapFormText();
        promptTokenModal(selectedChain, isSource);
    });

    chainList.key(['escape', 'q'], () => {
        modal.detach();
        screen.render();
    });

    chainList.focus();
    screen.render();
}

async function promptTokenModal(chain, isSource = true) {
    setStatus(`Loading verified tokens for ${chain.name}...`, 'warning');
    const tokens = await getTokensForChain(chain.chainId);

    const modal = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: 60,
        height: 18,
        border: { type: 'line', fg: 'magenta' },
        style: { bg: '#0f172a', fg: 'white' },
        label: ` Select Token on ${chain.name} `
    });

    const tokenItems = tokens.slice(0, 25).map(t => ` ${t.symbol} - ${t.name}`);

    const tokenList = blessed.list({
        parent: modal,
        top: 1,
        left: 2,
        width: 54,
        height: 14,
        keys: true,
        vi: true,
        border: { type: 'line' },
        style: { selected: { bg: 'magenta', fg: 'white', bold: true } },
        items: tokenItems
    });

    tokenList.on('select', (item, index) => {
        const selToken = tokens[index];
        modal.detach();
        screen.render();

        if (isSource) {
            swapState.fromTokenAddress = selToken.address;
            swapState.fromTokenSymbol = selToken.symbol;
        } else {
            swapState.toTokenAddress = selToken.address;
            swapState.toTokenSymbol = selToken.symbol;
        }
        updateSwapFormText();
        fetchLiveQuote();
    });

    tokenList.key(['escape', 'q'], () => {
        modal.detach();
        screen.render();
    });

    tokenList.focus();
    screen.render();
}


// ==========================================
// VIEW 2: 260+ CHAINS EXPLORER
// ==========================================
const chainsView = blessed.box({
    parent: mainContainer,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true
});

const chainSearchBox = blessed.textbox({
    parent: chainsView,
    top: 0,
    left: 0,
    width: '40%',
    height: 3,
    border: { type: 'line', fg: 'cyan' },
    label: ' Search 260+ EVM Chains (Type query & Enter) ',
    inputOnFocus: true,
    style: { fg: 'white', bg: '#1e293b' }
});

const chainsList = blessed.list({
    parent: chainsView,
    top: 3,
    left: 0,
    width: '40%',
    height: '100%-3',
    keys: true,
    vi: true,
    border: { type: 'line', fg: 'cyan' },
    label: ' Available Chains ',
    style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' }
    }
});

const chainDetailBox = blessed.box({
    parent: chainsView,
    top: 0,
    left: '40%',
    width: '60%',
    height: '100%',
    border: { type: 'line', fg: 'magenta' },
    label: ' Chain Network Specifications & Status ',
    tags: true,
    content: ' Select a chain on the left to inspect specifications.'
});

let displayedChains = getPopularChains();

function populateChainsList(chains) {
    displayedChains = chains;
    const items = chains.map(c => ` ${c.name} (${c.currency}) [ID: ${c.chainId}]`);
    chainsList.setItems(items);
    if (items.length > 0) {
        chainsList.select(0);
        showChainDetail(chains[0]);
    }
    screen.render();
}

function showChainDetail(chain) {
    if (!chain) return;
    let content = `\n`;
    content += `  {bold}NETWORK NAME:{/bold}      {cyan-fg}${chain.name}{/cyan-fg}\n`;
    content += `  {bold}CHAIN ID:{/bold}          {yellow-fg}${chain.chainId}{/yellow-fg}\n`;
    content += `  {bold}NATIVE CURRENCY:{/bold}   {green-fg}${chain.currency}{/green-fg} (${chain.decimals || 18} decimals)\n`;
    content += `  {bold}PRIMARY RPC:{/bold}       {grey-fg}${chain.rpc}{/grey-fg}\n`;
    if (chain.rpcList && chain.rpcList.length > 1) {
        content += `  {bold}FALLBACK RPCS:{/bold}     ${chain.rpcList.slice(1).join('\n                    ')}\n`;
    }
    content += `  {bold}EXPLORER:{/bold}          {blue-fg}${chain.explorer || 'N/A'}{/blue-fg}\n`;
    content += `  {bold}MULTICALL3:{/bold}        {green-fg}0xca11bde05977b3631167028862be2a173976ca11 (Supported){/green-fg}\n`;
    content += `  {bold}SWAP & BRIDGE:{/bold}     ${chain.hasSwapBridge ? '{green-bg}{black-fg} FULLY SUPPORTED {/black-fg}{/green-bg}' : '{grey-bg} DIRECT DEX ROUTER {/grey-bg}'}\n\n`;
    content += `  {bold}Actions:{/bold}\n`;
    content += `  • Press {yellow-fg}[Enter]{/yellow-fg} to set as Active Network\n`;
    content += `  • Press {yellow-fg}[p]{/yellow-fg} to test RPC Ping / Latency\n`;

    chainDetailBox.setContent(content);
    screen.render();
}

chainsList.on('select', (item, index) => {
    const chain = displayedChains[index];
    if (chain) {
        currentChainId = chain.chainId;
        updateHeader();
        setStatus(`Active network changed to ${chain.name} (Chain ID ${chain.chainId})`, 'success');
    }
});

chainsList.on('keypress', (ch, key) => {
    const idx = chainsList.selected;
    if (displayedChains[idx]) {
        showChainDetail(displayedChains[idx]);
    }
});

chainSearchBox.on('submit', () => {
    const q = chainSearchBox.getValue().trim();
    if (q) {
        const matches = searchChains(q);
        populateChainsList(matches);
        setStatus(`Found ${matches.length} chains matching "${q}"`, 'info');
    } else {
        populateChainsList(getAllChains());
    }
    chainsList.focus();
});

// ==========================================
// VIEW 3: TRANSFER
// ==========================================
const transferView = blessed.box({
    parent: mainContainer,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true
});

const transferFormBox = blessed.box({
    parent: transferView,
    top: 'center',
    left: 'center',
    width: '60%',
    height: '70%',
    border: { type: 'line', fg: 'cyan' },
    label: ' 💸 Transfer Assets (Native or Token) '
});

const tfRecipientInput = blessed.textbox({
    parent: transferFormBox,
    top: 2,
    left: 20,
    width: '60%',
    height: 3,
    border: { type: 'line' },
    inputOnFocus: true,
    label: ' Recipient Address '
});

const tfAmountInput = blessed.textbox({
    parent: transferFormBox,
    top: 6,
    left: 20,
    width: '60%',
    height: 3,
    border: { type: 'line' },
    inputOnFocus: true,
    label: ' Amount '
});

const tfTokenInput = blessed.textbox({
    parent: transferFormBox,
    top: 10,
    left: 20,
    width: '60%',
    height: 3,
    border: { type: 'line' },
    inputOnFocus: true,
    value: 'NATIVE',
    label: ' Asset (NATIVE or Token Contract) '
});

const btnSendTransfer = blessed.button({
    parent: transferFormBox,
    bottom: 2,
    left: 'center',
    width: 20,
    height: 3,
    border: { type: 'line' },
    content: ' SEND NOW ',
    style: { bg: 'green', fg: 'black', focus: { bg: 'white' } }
});

btnSendTransfer.on('press', async () => {
    const to = tfRecipientInput.getValue().trim();
    const amt = tfAmountInput.getValue().trim();
    const token = tfTokenInput.getValue().trim();

    if (!ethers.isAddress(to)) {
        setStatus('Invalid recipient address!', 'error');
        return;
    }
    if (!amt || isNaN(parseFloat(amt))) {
        setStatus('Invalid amount!', 'error');
        return;
    }

    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    if (!wallet) return;

    if (!wallet.isUnlocked || typeof wallet.wallet.connect !== 'function') {
        const unlocked = await promptUnlockModal('Authorize Transfer');
        if (!unlocked) {
            setStatus('Transfer cancelled: Vault is locked.', 'warning');
            return;
        }
    }

    try {
        setStatus(`Sending ${amt} on chain ${currentChainId}...`, 'warning');
        const provider = await getWorkingProvider(currentChainId);
        const signer = DECRYPTED_WALLETS[currentWalletIndex].wallet.connect(provider);

        let tx;
        if (token.toUpperCase() === 'NATIVE') {
            tx = await signer.sendTransaction({
                to: to,
                value: ethers.parseEther(amt)
            });
        } else {
            const erc20 = new ethers.Contract(token, [
                'function transfer(address, uint256) returns (bool)',
                'function decimals() view returns (uint8)'
            ], signer);
            const dec = await erc20.decimals();
            tx = await erc20.transfer(to, ethers.parseUnits(amt, dec));
        }

        setStatus(`✅ Transaction broadcast! Hash: ${tx.hash}`, 'success');
        refreshPortfolioView();
    } catch (e) {
        setStatus(`❌ Transfer failed: ${e.message}`, 'error');
    }
});

// ==========================================
// VIEW 4: WALLETS
// ==========================================
const walletsView = blessed.box({
    parent: mainContainer,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    hidden: true
});

const walletListBox = blessed.list({
    parent: walletsView,
    top: 0,
    left: 0,
    width: '40%',
    height: '100%',
    keys: true,
    vi: true,
    border: { type: 'line', fg: 'cyan' },
    label: ' Vault Wallets ',
    style: {
        selected: { bg: 'blue', fg: 'white', bold: true },
        item: { fg: 'white' }
    }
});

const walletDetailBox = blessed.box({
    parent: walletsView,
    top: 0,
    left: '40%',
    width: '60%',
    height: '100%',
    border: { type: 'line', fg: 'magenta' },
    label: ' Wallet Security & Details ',
    tags: true
});

function updateWalletsView() {
    const items = DECRYPTED_WALLETS.map((w, idx) => {
        const isCurrent = idx === currentWalletIndex;
        return `${isCurrent ? '⭐ ' : '   '}${w.name} (${w.wallet.address.slice(0, 6)}...${w.wallet.address.slice(-4)})`;
    });
    walletListBox.setItems(items);

    if (DECRYPTED_WALLETS.length > 0) {
        const w = DECRYPTED_WALLETS[currentWalletIndex];
        let content = `\n`;
        content += `  {bold}WALLET NAME:{/bold}      {yellow-fg}${w.name}{/yellow-fg}\n`;
        content += `  {bold}PUBLIC ADDRESS:{/bold}   {cyan-fg}${w.wallet.address}{/cyan-fg}\n`;
        content += `  {bold}VAULT STATUS:{/bold}     {green-fg}Unlocked & Encrypted on Disk{/green-fg}\n`;
        content += `  {bold}ENCRYPTION:{/bold}       AES-GCM (ethers.js Keystore Standard)\n\n`;
        content += `  {bold}Navigation:{/bold}\n`;
        content += `  • Press {yellow-fg}[Enter]{/yellow-fg} to switch active wallet\n`;
        content += `  • Run {yellow-fg}my-wallet{/yellow-fg} in standard CLI to import, export, or create new wallets\n`;
        walletDetailBox.setContent(content);
    }
    screen.render();
}

walletListBox.on('select', (item, index) => {
    currentWalletIndex = index;
    updateHeader();
    updateWalletsView();
    refreshPortfolioView();
    setStatus(`Active wallet switched to ${DECRYPTED_WALLETS[index].name}`, 'success');
});

// ==========================================
// VIEW 5: LOGS
// ==========================================
const logsView = blessed.log({
    parent: mainContainer,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    border: { type: 'line', fg: 'green' },
    label: ' System Activity & Network Logs ',
    scrollable: true,
    hidden: true
});

// Tab Switching Mechanism
const VIEWS = [portfolioView, swapView, chainsView, transferView, walletsView, logsView];

function switchTab(index) {
    activeTab = (index + VIEWS.length) % VIEWS.length;
    VIEWS.forEach((v, idx) => {
        if (idx === activeTab) v.show();
        else v.hide();
    });
    renderTabBar();

    if (activeTab === 0) {
        portfolioAssetsTable.focus();
    } else if (activeTab === 1) {
        btnGetQuote.focus();
    } else if (activeTab === 2) {
        chainsList.focus();
    } else if (activeTab === 4) {
        walletListBox.focus();
    }

    screen.render();
}

// Global Keybindings
screen.key(['tab'], () => switchTab(activeTab + 1));
screen.key(['S-tab'], () => switchTab(activeTab - 1));
screen.key(['1'], () => switchTab(0));
screen.key(['2'], () => switchTab(1));
screen.key(['3'], () => switchTab(2));
screen.key(['4'], () => switchTab(3));
screen.key(['5'], () => switchTab(4));
screen.key(['6'], () => switchTab(5));

screen.key(['r', 'R'], () => refreshPortfolioView(false));
screen.key(['d', 'D'], () => refreshPortfolioView(true));
screen.key(['m', 'M'], () => {
    if (activeTab === 0) {
        promptScanOptionsModal();
    }
});
screen.key(['s', 'S'], () => {
    switchTab(1);
    fetchLiveQuote();
});
screen.key(['q', 'Q', 'x', 'X'], (ch) => {
    if (activeTab === 1) {
        if (ch.toLowerCase() === 'q') fetchLiveQuote();
        if (ch.toLowerCase() === 'x') executeCurrentQuote();
    }
});
screen.key(['a', 'A'], () => {
    if (activeTab === 1) promptAmount();
});
screen.key(['f', 'F'], () => {
    if (activeTab === 0) {
        refreshPortfolioView(true);
    } else if (activeTab === 1) {
        promptChainAndTokenModal('Select Source Chain', true);
    }
});
screen.key(['t', 'T'], () => {
    if (activeTab === 1) promptChainAndTokenModal('Select Destination Chain', false);
});
screen.key(['p'], async () => {
    if (activeTab === 2) {
        const idx = chainsList.selected;
        if (displayedChains[idx]) {
            const c = displayedChains[idx];
            setStatus(`Pinging ${c.name} (${c.rpc})...`, 'warning');
            const res = await testRpcLatency(c);
            if (res.ok) {
                setStatus(`✅ ${c.name} RPC Ping: ${res.latency}ms | Block: ${res.block}`, 'success');
            } else {
                setStatus(`❌ ${c.name} RPC Ping failed: ${res.error}`, 'error');
            }
        }
    }
});

screen.key(['escape', 'C-c'], () => process.exit(0));

// --- Vault Password Prompt (Only shown when signing transactions) ---
function promptUnlockModal(actionTitle = 'Authorize Transaction') {
    return new Promise((resolve) => {
        const pwdForm = blessed.box({
            parent: screen,
            top: 'center',
            left: 'center',
            width: 56,
            height: 10,
            border: { type: 'line', fg: 'yellow' },
            style: { bg: '#1e293b', fg: 'white' },
            label: ` 🔐 ${actionTitle} `
        });

        blessed.text({
            parent: pwdForm,
            top: 1,
            left: 2,
            content: 'Enter Master Password to sign transaction:'
        });

        const pwdInput = blessed.textbox({
            parent: pwdForm,
            top: 3,
            left: 2,
            width: 50,
            height: 3,
            censor: true,
            inputOnFocus: true,
            border: { type: 'line' },
            style: { bg: 'black', fg: 'white', focus: { border: { fg: 'cyan' } } }
        });

        pwdInput.on('submit', async () => {
            const pass = pwdInput.getValue();
            if (!pass) return;

            setStatus('Unlocking vault for signing...', 'warning');
            try {
                await unlockWallets(pass);
                pwdForm.detach();
                updateWalletsView();
                screen.render();
                setStatus('Vault unlocked for session.', 'success');
                resolve(true);
            } catch (e) {
                setStatus(`Unlock failed: ${e.message}`, 'error');
                pwdInput.setValue('');
                pwdInput.focus();
                screen.render();
            }
        });

        pwdInput.key(['escape'], () => {
            pwdForm.detach();
            screen.render();
            resolve(false);
        });

        pwdInput.focus();
        screen.render();
    });
}

async function startApp() {
    renderTabBar();
    updateHeader();
    updateWalletsView();
    populateChainsList(getPopularChains());
    updateSwapFormText();

    // Trigger initial scan
    refreshPortfolioView();
    fetchLiveQuote();
}

// Initial Bootstrapping (No password required at entrance!)
async function bootstrap() {
    loadSettings();
    renderTabBar();

    if (hasEncryptedWallets()) {
        loadPublicWallets();
        startApp();
    } else {
        headerBox.setContent('  ⚡ MULTI-WALLET PRO  |  No Wallets Found. Run "my-wallet" CLI to create your first wallet.');
        screen.render();
    }
}

bootstrap();