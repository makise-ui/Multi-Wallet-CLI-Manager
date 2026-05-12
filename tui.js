#!/usr/bin/env node
/**
 * tui.js — Professional Terminal UI Dashboard for Multi-Wallet CLI Manager
 *
 * Dark-theme dashboard with sidebar navigation, inline forms, portfolio
 * visualisation, and keyboard-driven access to every CLI feature.
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import { ethers } from 'ethers';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    loadSettings,
    hasEncryptedWallets,
    unlockWallets,
    DECRYPTED_WALLETS,
    NETWORKS,
    getNativeBalance,
    getPrice,
    USER_SETTINGS,
    PREDEFINED_TOKENS,
    ERC20_ABI,
    getProvider,
    checkAndApproveToken,
    executeSwap,
    ROUTERS,
    WNATIVE,
    saveSettings
} from './core.js';

import {
    setupShamirRecovery,
    recoverFromShares,
    setupGuardianKey,
    recoverFromGuardian,
    recoveryStatus
} from './recovery.js';

// ═══════════════════════════════════════════════════════════════════════════════
//  THEME
// ═══════════════════════════════════════════════════════════════════════════════
const C = {
    bg:           'black',
    panelBg:      '#111111',
    inputBg:      '#1a1a1a',
    focusBg:      '#252525',
    fg:           'white',
    muted:        'gray',
    border:       'cyan',
    borderDim:    '#333333',
    headerBg:     '#0d47a1',
    headerFg:     'white',
    accent:       'bright-cyan',
    success:      'bright-green',
    error:        'bright-red',
    warn:         'bright-yellow',
    info:         'bright-blue',
    menuBg:       '#1a1a2e',
    menuFg:       '#a0a0a0',
    menuSelBg:    'cyan',
    menuSelFg:    'black',
    selBg:        '#1565c0',
    selFg:        'white'
};

// ═══════════════════════════════════════════════════════════════════════════════
//  SCREEN & GRID
// ═══════════════════════════════════════════════════════════════════════════════
const screen = blessed.screen({
    smartCSR: true,
    title:    'Multi-Wallet CLI Manager',
    mouse:    true,
    fullUnicode: true
});

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// ── Header ───────────────────────────────────────────────────────────────────
const header = grid.set(0, 0, 1, 12, blessed.box, {
    tags: true,
    style: { bg: C.headerBg, fg: C.headerFg },
    valign: 'middle',
    padding: { left: 1, right: 1 }
});

// ── Menu Bar ─────────────────────────────────────────────────────────────────
const menuBar = grid.set(1, 0, 1, 12, blessed.listbar, {
    keys: true,
    mouse: true,
    autoCommandKeys: false,
    style: {
        bg: C.menuBg,
        item:   { bg: C.menuBg, fg: C.menuFg },
        selected: { bg: C.menuSelBg, fg: C.menuSelFg, bold: true },
        prefix: { fg: C.accent }
    }
});

// ── Wallet Sidebar ───────────────────────────────────────────────────────────
const walletBox = grid.set(2, 0, 7, 3, blessed.box, {
    label: ' {bold}Wallets{/bold} ',
    tags: true,
    border: { type: 'line', fg: C.border },
    style: { bg: C.bg, fg: C.fg },
    scrollable: true,
    alwaysScroll: true
});

const walletList = blessed.list({
    parent: walletBox,
    top: 0, left: 0, right: 0, bottom: 1,
    keys: true, mouse: true,
    style: {
        bg: C.bg, fg: C.fg,
        item: { bg: C.bg, fg: C.fg },
        selected: { bg: C.selBg, fg: C.selFg, bold: true }
    },
    tags: true
});

const networkLabel = blessed.text({
    parent: walletBox,
    bottom: 0, left: 1, right: 1,
    style: { fg: C.accent, bold: true }
});

// ── Content Area ───────────────────────────────────────────────────────────────
const contentBox = grid.set(2, 3, 7, 9, blessed.box, {
    label: ' {bold}Dashboard{/bold} ',
    tags: true,
    border: { type: 'line', fg: C.border },
    style: { bg: C.bg, fg: C.fg },
    scrollable: false
});

// ── Activity Log ─────────────────────────────────────────────────────────────
const logBox = grid.set(9, 0, 2, 12, contrib.log, {
    label: ' {bold}Activity Log{/bold} ',
    border: { type: 'line', fg: C.borderDim },
    style: { fg: C.success, bg: C.bg },
    bufferLength: 120,
    scrollOnInput: false
});

// ── Status Bar ───────────────────────────────────────────────────────────────
const statusBar = grid.set(11, 0, 1, 12, blessed.box, {
    tags: true,
    style: { bg: '#0a0a0a', fg: C.muted },
    padding: { left: 1, right: 1 },
    valign: 'middle'
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════════════════
let currentWalletIndex = 0;
let currentNetwork     = USER_SETTINGS.defaultNetwork || 'bsc';
let activeOverlay      = null;
let gasPrice           = null;
let refreshTimer       = null;
let sessionPassword    = null;

const CONFIG_DIR   = path.join(os.homedir(), '.my-cli-wallet');
const WALLETS_FILE = path.join(CONFIG_DIR, 'my_wallets.json');
const TRASH_FILE   = path.join(CONFIG_DIR, 'trash_wallets.json');

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
function log(msg, type = 'info') {
    const color =
        type === 'error'   ? C.error :
        type === 'warn'    ? C.warn :
        type === 'success' ? C.success :
        type === 'info'    ? C.info : C.fg;
    const sym =
        type === 'error'   ? '✗' :
        type === 'warn'    ? '!' :
        type === 'success' ? '✓' : '›';
    logBox.log(`{${color}-fg}[${sym}] ${msg}{/${color}-fg}`);
    screen.render();
}

function updateHeader() {
    const wCount = DECRYPTED_WALLETS.length;
    const net    = NETWORKS[currentNetwork];
    const time   = new Date().toLocaleTimeString();
    header.setContent(
        `{left}{bold}⛓  Multi-Wallet CLI Manager{/bold}  v1.0.0{/left}` +
        `{center}Wallets: {bold}${wCount}{/bold}  |  Network: {bold}${net?.name || currentNetwork}{/bold}{/center}` +
        `{right}${time}{/right}`
    );
    screen.render();
}

function updateStatusBar() {
    const wName = DECRYPTED_WALLETS[currentWalletIndex]?.name || '—';
    const gas   = gasPrice ? `${parseFloat(gasPrice).toFixed(2)} gwei` : '…';
    const rpc   = USER_SETTINGS.customRpcs?.[currentNetwork] ? 'custom' : 'default';
    const cur   = USER_SETTINGS.currency;
    statusBar.setContent(
        `  {bold}${wName}{/bold}  ·  ${NETWORKS[currentNetwork]?.currency}  ·  gas ${gas}  ·  rpc:${rpc}  ·  ${cur}  ` +
        `|  {bold}Keys:{/bold} [1-8] Menu  [←→] Wallet  [n] Net  [r] Refresh  [q] Quit`
    );
    screen.render();
}

function clearContent(label) {
    // remove every blessed child from contentBox
    contentBox.children.slice().forEach(c => c.detach ? c.detach() : null);
    contentBox.setLabel(` {bold}${label}{/bold} `);
    contentBox.dashboardTable = null;
    screen.render();
}

function showOverlay(widget) {
    if (activeOverlay) {
        try { activeOverlay.destroy(); } catch {}
        activeOverlay = null;
    }
    activeOverlay = widget;
    screen.render();
}

function closeOverlay() {
    if (activeOverlay) {
        try { activeOverlay.destroy(); } catch {}
        activeOverlay = null;
        screen.render();
    }
}

function setLoading(text) {
    const box = blessed.box({
        parent: screen,
        top: 'center', left: 'center',
        width: 30, height: 3,
        bg: C.panelBg,
        border: { type: 'line', fg: C.accent },
        tags: true,
        content: `{center}{${C.accent}-g}⏳  ${text}…{/${C.accent}-fg}{/center}`,
        valign: 'middle'
    });
    showOverlay(box);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  OVERLAY WIDGETS
// ═══════════════════════════════════════════════════════════════════════════════

function createMessageBox(title, content, type = 'info') {
    const bc = type === 'error' ? C.error : type === 'warn' ? C.warn : C.border;
    const box = blessed.box({
        parent: screen,
        top: 'center', left: 'center',
        width: '72%', height: '56%',
        bg: C.panelBg,
        border: { type: 'line', fg: bc },
        label: ` {bold}${title}{/bold} `,
        tags: true,
        content: content,
        scrollable: true, alwaysScroll: true,
        keys: true, mouse: true,
        padding: { left: 1, right: 1 }
    });

    const btn = blessed.button({
        parent: box,
        bottom: 1, left: 'center',
        content: '  CLOSE  ',
        style: { bg: C.selBg, fg: 'white', focus: { bg: 'white', fg: 'black' } },
        shrink: true, padding: { left: 1, right: 1 }
    });

    btn.on('press', () => closeOverlay());
    box.key(['escape', 'q'], () => closeOverlay());
    btn.focus();
    showOverlay(box);
}

function showConfirm(title, message) {
    return new Promise(resolve => {
        const box = blessed.box({
            parent: screen,
            top: 'center', left: 'center',
            width: '50%', height: 8,
            bg: C.panelBg,
            border: { type: 'line', fg: C.warn },
            label: ` {bold}${title}{/bold} `,
            tags: true,
            content: `\n{center}{bold}${message}{/bold}{/center}`,
            valign: 'middle'
        });

        const yes = blessed.button({
            parent: box, bottom: 1, left: '25%',
            content: '  YES  ',
            style: { bg: 'green', fg: 'black', focus: { bg: 'white' } },
            shrink: true
        });
        const no  = blessed.button({
            parent: box, bottom: 1, left: '55%',
            content: '  NO  ',
            style: { bg: C.error, fg: 'white', focus: { bg: 'white', fg: 'black' } },
            shrink: true
        });

        yes.on('press', () => { closeOverlay(); resolve(true); });
        no.on('press',  () => { closeOverlay(); resolve(false); });
        box.key(['escape'], () => { closeOverlay(); resolve(false); });
        yes.focus();
        showOverlay(box);
    });
}

function showListPicker(title, items) {
    return new Promise(resolve => {
        const h = Math.min(items.length + 4, 20);
        const box = blessed.box({
            parent: screen,
            top: 'center', left: 'center',
            width: '50%', height: h,
            bg: C.panelBg,
            border: { type: 'line', fg: C.border },
            label: ` {bold}${title}{/bold} `
        });

        const list = blessed.list({
            parent: box,
            top: 1, left: 1, right: 1, bottom: 1,
            items,
            keys: true, mouse: true,
            style: {
                bg: C.panelBg, fg: C.fg,
                selected: { bg: C.menuSelBg, fg: C.menuSelFg, bold: true }
            },
            tags: true
        });

        list.key(['escape'], () => { closeOverlay(); resolve(null); });
        list.on('select', (item, index) => {
            closeOverlay();
            resolve({ text: item.getText(), index, value: items[index] });
        });
        list.focus();
        showOverlay(box);
    });
}

function createForm(title, fields, onSubmit, onCancel) {
    const totalH = fields.length * 4 + 5;
    const form = blessed.form({
        parent: screen,
        keys: true,
        left: 'center', top: 'center',
        width: '64%', height: totalH,
        bg: C.panelBg,
        border: { type: 'line', fg: C.border },
        label: ` {bold}${title}{/bold} `,
        tags: true
    });

    const inputs = {};
    let offset = 1;

    fields.forEach(f => {
        blessed.text({
            parent: form,
            top: offset, left: 2,
            content: f.label,
            style: { fg: C.muted, bg: C.panelBg }
        });

        const opts = {
            parent: form,
            name: f.name,
            top: offset, left: 22, right: 2, height: 3,
            inputOnFocus: true,
            border: { type: 'line', fg: C.borderDim },
            style: {
                fg: 'white', bg: C.inputBg,
                focus: { border: { fg: C.accent }, bg: C.focusBg }
            }
        };
        if (f.type === 'password') opts.censor = true;
        if (f.type === 'number')  opts.keys = true;

        inputs[f.name] = blessed.textbox(opts);
        offset += 4;
    });

    const submit = blessed.button({
        parent: form,
        bottom: 1, left: '30%',
        content: '  SUBMIT  ',
        style: { bg: 'green', fg: 'black', focus: { bg: 'white' } },
        shrink: true, padding: { left: 1, right: 1 }
    });
    const cancel = blessed.button({
        parent: form,
        bottom: 1, left: '55%',
        content: '  CANCEL  ',
        style: { bg: C.error, fg: 'white', focus: { bg: 'white', fg: 'black' } },
        shrink: true, padding: { left: 1, right: 1 }
    });

    submit.on('press', () => {
        const data = {};
        fields.forEach(f => data[f.name] = inputs[f.name].getValue());
        closeOverlay();
        onSubmit(data);
    });
    cancel.on('press', () => { closeOverlay(); if (onCancel) onCancel(); });
    form.key(['escape'], () => { closeOverlay(); if (onCancel) onCancel(); });

    showOverlay(form);
    if (fields.length) inputs[fields[0].name].focus();
}

function promptForm(title, fields) {
    return new Promise(resolve => createForm(title, fields, resolve, () => resolve(null)));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DATA FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function refreshWalletList() {
    if (DECRYPTED_WALLETS.length === 0) {
        walletList.setItems(['  (no wallets)']);
    } else {
        const items = DECRYPTED_WALLETS.map((w, i) =>
            `${i === currentWalletIndex ? '{inverse}' : ''}${String(i + 1).padStart(2)}. ${w.name}{/inverse}`
        );
        walletList.setItems(items);
        walletList.select(currentWalletIndex);
    }
    const net = NETWORKS[currentNetwork];
    networkLabel.setContent(`⛓  ${net?.name || currentNetwork}`);
    updateHeader();
    updateStatusBar();
    screen.render();
}

async function refreshBalances() {
    if (DECRYPTED_WALLETS.length === 0) return;
    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    if (!wallet) return;

    log(`Fetching balances for ${wallet.name} on ${currentNetwork}…`);

    const tableData = [];
    try {
        const bal      = await getNativeBalance(wallet.wallet.address, currentNetwork);
        const symbol   = NETWORKS[currentNetwork].currency;
        const price    = await getPrice(NETWORKS[currentNetwork].coingeckoId);
        const val      = (parseFloat(bal) * price).toFixed(2);
        tableData.push([symbol, parseFloat(bal).toFixed(4), `$${val}`]);

        const tokensToCheck = [];
        if (PREDEFINED_TOKENS[currentNetwork]) tokensToCheck.push(...PREDEFINED_TOKENS[currentNetwork]);
        if (USER_SETTINGS.savedTokens) {
            tokensToCheck.push(...USER_SETTINGS.savedTokens.filter(t => t.network === currentNetwork));
        }

        const provider = getProvider(currentNetwork);
        for (const token of tokensToCheck) {
            try {
                const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
                const balWei   = await contract.balanceOf(wallet.wallet.address);
                const decimals = token.decimals || await contract.decimals();
                const sym      = token.symbol || await contract.symbol();
                const balFloat = parseFloat(ethers.formatUnits(balWei, decimals));
                if (balFloat > 0) {
                    let valStr = '—';
                    if (token.coingeckoId) {
                        const tPrice = await getPrice(token.coingeckoId);
                        valStr = `$${(balFloat * tPrice).toFixed(2)}`;
                    }
                    tableData.push([sym, balFloat.toFixed(4), valStr]);
                }
            } catch (e) { /* skip token */ }
        }
    } catch (e) {
        log(`Balance fetch failed: ${e.message}`, 'error');
    }

    if (contentBox.dashboardTable) {
        contentBox.dashboardTable.setData({
            headers: ['Asset', 'Balance', `Value (${USER_SETTINGS.currency})`],
            data: tableData
        });
    }
    screen.render();
    log('Balances updated.', 'success');
}

async function refreshGasPrice() {
    try {
        const provider = getProvider(currentNetwork);
        const feeData  = await provider.getFeeData();
        gasPrice = feeData.gasPrice ? ethers.formatUnits(feeData.gasPrice, 'gwei') : '?';
    } catch {
        gasPrice = '?';
    }
    updateStatusBar();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Dashboard
// ═══════════════════════════════════════════════════════════════════════════════

function showDashboard() {
    clearContent('Dashboard');

    const table = contrib.table({
        parent: contentBox,
        top: 0, left: 0, right: 0, bottom: 0,
        keys: true, mouse: true,
        fg: 'white',
        selectedFg: 'white',
        selectedBg: C.selBg,
        interactive: true,
        label: 'Balances',
        border: { type: 'line', fg: C.borderDim },
        columnSpacing: 4,
        columnWidth: [10, 20, 18]
    });

    contentBox.dashboardTable = table;
    refreshBalances();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Transfer
// ═══════════════════════════════════════════════════════════════════════════════

async function showTransferForm() {
    if (DECRYPTED_WALLETS.length === 0) { log('No wallets loaded.', 'warn'); return; }

    // 1. Choose asset
    const assets = [`Native (${NETWORKS[currentNetwork]?.currency})`];
    const assetMap = [{ type: 'native' }];

    const tokens = [];
    if (PREDEFINED_TOKENS[currentNetwork]) tokens.push(...PREDEFINED_TOKENS[currentNetwork]);
    if (USER_SETTINGS.savedTokens) tokens.push(...USER_SETTINGS.savedTokens.filter(t => t.network === currentNetwork));

    tokens.forEach(t => {
        assets.push(t.symbol);
        assetMap.push({ type: 'token', ...t });
    });

    const assetPick = await showListPicker('Select Asset', assets);
    if (!assetPick) return;
    const asset = assetMap[assetPick.index];

    // 2. Recipient
    const myAddrs = DECRYPTED_WALLETS
        .filter((_, i) => i !== currentWalletIndex)
        .map(w => `${w.name} — ${w.wallet.address}`);
    const dests = ['Manual Address Entry', ...myAddrs];
    const destPick = await showListPicker('Send To', dests);
    if (!destPick) return;

    let to;
    if (destPick.index === 0) {
        const form = await promptForm('Recipient Address', [{ name: 'to', label: 'Address' }]);
        if (!form) return;
        to = form.to;
    } else {
        to = DECRYPTED_WALLETS.find(w => `${w.name} — ${w.wallet.address}` === destPick.value).wallet.address;
    }

    // 3. Amount
    const formData = await promptForm(
        `Send ${asset.type === 'native' ? NETWORKS[currentNetwork].currency : asset.symbol}`,
        [{ name: 'amount', label: 'Amount' }]
    );
    if (!formData) return;

    const ok = await showConfirm('Confirm Transfer',
        `Send ${formData.amount} ${asset.type === 'native' ? NETWORKS[currentNetwork].currency : asset.symbol}\nto ${to.slice(0, 10)}…${to.slice(-8)}`);
    if (!ok) return;

    setLoading('Broadcasting transaction');
    try {
        const wallet   = DECRYPTED_WALLETS[currentWalletIndex].wallet;
        const provider = getProvider(currentNetwork);
        const signer   = wallet.connect(provider);

        if (asset.type === 'native') {
            const tx = await signer.sendTransaction({
                to, value: ethers.parseEther(formData.amount)
            });
            log(`✅ Native transfer sent! Hash: ${tx.hash}`, 'success');
        } else {
            const contract = new ethers.Contract(asset.address, ERC20_ABI, signer);
            const tx = await contract.transfer(to, ethers.parseUnits(formData.amount, asset.decimals));
            log(`✅ Token transfer sent! Hash: ${tx.hash}`, 'success');
        }
    } catch (e) {
        log(`Transfer failed: ${e.message}`, 'error');
    }
    closeOverlay();
    refreshBalances();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Swap
// ═══════════════════════════════════════════════════════════════════════════════

async function showSwapForm() {
    if (DECRYPTED_WALLETS.length === 0) { log('No wallets loaded.', 'warn'); return; }
    if (!ROUTERS[currentNetwork]) { log('Swap not supported on this network.', 'warn'); return; }

    const tokens = [];
    if (PREDEFINED_TOKENS[currentNetwork]) tokens.push(...PREDEFINED_TOKENS[currentNetwork]);
    if (USER_SETTINGS.savedTokens) tokens.push(...USER_SETTINGS.savedTokens.filter(t => t.network === currentNetwork));

    if (tokens.length === 0) { log('No tokens available to swap.', 'warn'); return; }

    const pick = await showListPicker('Token to Sell', tokens.map(t => t.symbol));
    if (!pick) return;
    const token = tokens[pick.index];

    const amtData = await promptForm(
        `Swap ${token.symbol} → ${NETWORKS[currentNetwork].currency}`,
        [{ name: 'amount', label: `Amount (${token.symbol})` }]
    );
    if (!amtData) return;

    setLoading('Fetching swap quote');
    try {
        const wallet   = DECRYPTED_WALLETS[currentWalletIndex].wallet;
        const provider = getProvider(currentNetwork);
        const signer   = wallet.connect(provider);
        const amountIn = ethers.parseUnits(amtData.amount, token.decimals);

        const router   = new ethers.Contract(ROUTERS[currentNetwork], ROUTER_ABI, signer);
        const path     = [token.address, WNATIVE[currentNetwork]];
        const amounts  = await router.getAmountsOut(amountIn, path);
        const outMin   = amounts[1] * 95n / 100n;
        const expected = ethers.formatEther(amounts[1]);
        const min      = ethers.formatEther(outMin);

        closeOverlay();
        const ok = await showConfirm('Confirm Swap',
            `Sell: ${amtData.amount} ${token.symbol}\n` +
            `Expected: ${expected} ${NETWORKS[currentNetwork].currency}\n` +
            `Min (5% slippage): ${min} ${NETWORKS[currentNetwork].currency}`);
        if (!ok) return;

        setLoading('Approving & swapping');
        const approveHash = await checkAndApproveToken(signer, token.address, ROUTERS[currentNetwork], amountIn);
        if (approveHash) log(`Approved: ${approveHash.slice(0, 16)}…`, 'success');

        const tx = await executeSwap(signer, currentNetwork, token, amountIn);
        log(`✅ Swap sent! Hash: ${tx.hash}`, 'success');
    } catch (e) {
        log(`Swap failed: ${e.message}`, 'error');
    }
    closeOverlay();
    refreshBalances();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Portfolio
// ═══════════════════════════════════════════════════════════════════════════════

async function showPortfolio() {
    if (DECRYPTED_WALLETS.length === 0) { log('No wallets loaded.', 'warn'); return; }
    clearContent('Portfolio Overview');
    log('Scanning all networks…', 'info');
    setLoading('Building portfolio');

    let grandTotal = 0;
    const rows     = [];
    const donutData = [];

    for (const w of DECRYPTED_WALLETS) {
        let wTotal = 0;
        try {
            for (const netKey of Object.keys(NETWORKS)) {
                const provider = getProvider(netKey);
                try {
                    const balWei = await provider.getBalance(w.wallet.address);
                    const bal    = parseFloat(ethers.formatEther(balWei));
                    if (bal > 0) {
                        const price = await getPrice(NETWORKS[netKey].coingeckoId);
                        wTotal += bal * (price || 0);
                    }
                } catch (e) {}

                if (PREDEFINED_TOKENS[netKey]) {
                    for (const t of PREDEFINED_TOKENS[netKey]) {
                        try {
                            const c    = new ethers.Contract(t.address, ERC20_ABI, provider);
                            const bWei = await c.balanceOf(w.wallet.address);
                            if (bWei > 0n) {
                                const b = parseFloat(ethers.formatUnits(bWei, t.decimals));
                                const p = t.coingeckoId ? await getPrice(t.coingeckoId) : 0;
                                wTotal += b * p;
                            }
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {
            log(`Error scanning ${w.name}: ${e.message}`, 'error');
        }
        grandTotal += wTotal;
        rows.push([w.name, w.wallet.address, `${wTotal.toFixed(2)} ${USER_SETTINGS.currency}`]);
    }

    closeOverlay();

    // Table
    const table = contrib.table({
        parent: contentBox,
        top: 0, left: 0, width: '65%', height: '70%',
        keys: true, mouse: true,
        fg: 'white', selectedFg: 'white', selectedBg: C.selBg,
        interactive: true,
        label: 'Wallet Values',
        border: { type: 'line', fg: C.borderDim },
        columnSpacing: 3,
        columnWidth: [16, 44, 20]
    });
    table.setData({
        headers: ['Wallet', 'Address', `Value (${USER_SETTINGS.currency})`],
        data: rows
    });

    // Donut chart (percent per wallet)
    const colors = ['green', 'yellow', 'red', 'magenta', 'blue', 'cyan'];
    let donutIdx = 0;
    for (const r of rows) {
        const val = parseFloat(r[2]);
        if (val > 0 && grandTotal > 0) {
            donutData.push({
                percent: Math.round((val / grandTotal) * 100),
                label: r[0],
                color: colors[donutIdx % colors.length]
            });
            donutIdx++;
        }
    }
    if (donutData.length === 0) donutData.push({ percent: 100, label: 'Empty', color: 'gray' });

    const donut = contrib.donut({
        parent: contentBox,
        top: 0, left: '65%', width: '35%', height: '70%',
        label: 'Distribution',
        radius: 7,
        arcWidth: 3,
        remainColor: 'black',
        data: donutData
    });

    const totalBox = blessed.box({
        parent: contentBox,
        top: '70%', left: 0, right: 0, bottom: 0,
        border: { type: 'line', fg: C.borderDim },
        label: ' Summary ',
        tags: true,
        style: { bg: C.panelBg, fg: C.fg },
        valign: 'middle',
        content: `{center}{bold}{${C.accent}-fg}Total Portfolio Value:{/bold}  ${grandTotal.toFixed(2)} ${USER_SETTINGS.currency}{/${C.accent}-fg}{/center}`
    });

    screen.render();
    log('Portfolio ready.', 'success');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Settings
// ═══════════════════════════════════════════════════════════════════════════════

async function showSettingsMenu() {
    const items = [
        `Currency: ${USER_SETTINGS.currency}`,
        `Default Network: ${USER_SETTINGS.defaultNetwork}`,
        `Gas Buffer: ${USER_SETTINGS.gasLimitBuffer}`,
        'Change Currency',
        'Toggle Default Network',
        'Set Gas Buffer',
        'Configure Custom RPC',
        'Toggle Vault Encryption',
        'Backup Configuration',
        'Back'
    ];
    const pick = await showListPicker('Settings', items);
    if (!pick || pick.text === 'Back') return;

    if (pick.text === 'Change Currency') {
        const cur = await showListPicker('Select Currency', ['USD', 'INR', 'EUR', 'GBP', 'JPY']);
        if (cur) {
            USER_SETTINGS.currency = cur.value;
            saveSettings({ currency: cur.value });
            log(`Currency set to ${cur.value}.`, 'success');
        }
    }
    if (pick.text === 'Toggle Default Network') {
        const nets = Object.keys(NETWORKS);
        const net  = await showListPicker('Default Network', nets.map(k => NETWORKS[k].name));
        if (net) {
            const key = Object.keys(NETWORKS).find(k => NETWORKS[k].name === net.value);
            USER_SETTINGS.defaultNetwork = key;
            saveSettings({ defaultNetwork: key });
            log(`Default network set to ${key}.`, 'success');
        }
    }
    if (pick.text === 'Set Gas Buffer') {
        const d = await promptForm('Gas Buffer',
            [{ name: 'buf', label: 'Buffer (wei, 0=disabled)' }]);
        if (d) {
            USER_SETTINGS.gasLimitBuffer = d.buf;
            saveSettings({ gasLimitBuffer: d.buf });
            log(`Gas buffer set to ${d.buf}.`, 'success');
        }
    }
    if (pick.text === 'Configure Custom RPC') {
        await showCustomRpcForm();
    }
    if (pick.text === 'Toggle Vault Encryption') {
        log('Encryption toggle requires CLI wizard.', 'warn');
        spawnCli('Toggle Vault Encryption');
    }
    if (pick.text === 'Backup Configuration') {
        log('Backup config requires CLI wizard.', 'warn');
        spawnCli('Backup Configuration');
    }
}

async function showCustomRpcForm() {
    const netKeys = Object.keys(NETWORKS);
    const net = await showListPicker('Select Network', netKeys.map(k => NETWORKS[k].name));
    if (!net) return;
    const key = Object.keys(NETWORKS).find(k => NETWORKS[k].name === net.value);

    const d = await promptForm(`Custom RPC — ${NETWORKS[key].name}`, [
        { name: 'url', label: 'URL', type: 'text' }
    ]);
    if (!d) return;

    const customRpcs = { ...(USER_SETTINGS.customRpcs || {}) };
    if (d.url.trim()) {
        customRpcs[key] = d.url.trim();
        saveSettings({ customRpcs });
        log(`Custom RPC set for ${key}.`, 'success');
    } else {
        delete customRpcs[key];
        saveSettings({ customRpcs });
        log(`Reverted to default RPC for ${key}.`, 'success');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Wallet Management
// ═══════════════════════════════════════════════════════════════════════════════

async function showWalletManagementMenu() {
    const items = [
        'Create New Wallet',
        'Import Wallet (Private Key)',
        'Import Wallet (Mnemonic)',
        'Rename Wallet',
        'Delete Wallet',
        'Show Private Key',
        'Back'
    ];
    const pick = await showListPicker('Wallet Management', items);
    if (!pick || pick.text === 'Back') return;

    if (pick.text === 'Create New Wallet')          await doCreateWallet();
    if (pick.text === 'Import Wallet (Private Key)')await doImportWallet('pk');
    if (pick.text === 'Import Wallet (Mnemonic)')   await doImportWallet('mnemonic');
    if (pick.text === 'Rename Wallet')              await doRenameWallet();
    if (pick.text === 'Delete Wallet')              await doDeleteWallet();
    if (pick.text === 'Show Private Key')           await doShowPrivateKey();
}

async function doCreateWallet() {
    const d = await promptForm('Create New Wallet',
        [{ name: 'name', label: 'Wallet Name' }]);
    if (!d || !d.name.trim()) return;

    let password = null;
    if (!USER_SETTINGS.encryptionDisabled) {
        if (sessionPassword) {
            password = sessionPassword;
        } else if (fs.existsSync(WALLETS_FILE)) {
            const pw = await promptForm('Vault Password',
                [{ name: 'pass', label: 'Password', type: 'password' }]);
            if (!pw) return;
            password = pw.pass;
            sessionPassword = password;
        } else {
            const enc = await showConfirm('Encryption',
                'Encrypt wallet vault with a password? (Recommended)');
            if (enc) {
                const pw = await promptForm('Set Vault Password', [
                    { name: 'p1', label: 'Password', type: 'password' },
                    { name: 'p2', label: 'Confirm',   type: 'password' }
                ]);
                if (!pw || pw.p1 !== pw.p2) { log('Passwords do not match.', 'error'); return; }
                password = pw.p1;
                sessionPassword = password;
                USER_SETTINGS.encryptionDisabled = false;
                saveSettings({ encryptionDisabled: false });
            } else {
                USER_SETTINGS.encryptionDisabled = true;
                saveSettings({ encryptionDisabled: true });
            }
        }
    }

    const wallet = ethers.Wallet.createRandom();
    await saveWalletToDisk(d.name.trim(), wallet, password);
    DECRYPTED_WALLETS.push({ name: d.name.trim(), wallet });
    currentWalletIndex = DECRYPTED_WALLETS.length - 1;
    refreshWalletList();
    log(`Created wallet: ${wallet.address}`, 'success');
}

async function doImportWallet(mode) {
    const d = await promptForm(`Import Wallet (${mode === 'pk' ? 'Private Key' : 'Mnemonic'})`, [
        { name: 'secret', label: mode === 'pk' ? 'Private Key' : 'Mnemonic', type: 'password' },
        { name: 'name',   label: 'Wallet Name' }
    ]);
    if (!d || !d.secret.trim() || !d.name.trim()) return;

    let wallet;
    try {
        if (mode === 'pk') wallet = new ethers.Wallet(d.secret.trim());
        else wallet = ethers.Wallet.fromPhrase(d.secret.trim());
    } catch (e) {
        log(`Invalid key/phrase: ${e.message}`, 'error');
        return;
    }

    let password = null;
    if (!USER_SETTINGS.encryptionDisabled) {
        if (sessionPassword) password = sessionPassword;
        else {
            const pw = await promptForm('Vault Password',
                [{ name: 'pass', label: 'Password', type: 'password' }]);
            if (!pw) return;
            password = pw.pass;
            sessionPassword = password;
        }
    }

    await saveWalletToDisk(d.name.trim(), wallet, password);
    DECRYPTED_WALLETS.push({ name: d.name.trim(), wallet });
    currentWalletIndex = DECRYPTED_WALLETS.length - 1;
    refreshWalletList();
    log(`Imported wallet: ${wallet.address}`, 'success');
}

async function doRenameWallet() {
    if (DECRYPTED_WALLETS.length === 0) return;
    const pick = await showListPicker('Select Wallet', DECRYPTED_WALLETS.map(w => w.name));
    if (!pick) return;
    const target = DECRYPTED_WALLETS[pick.index];

    const d = await promptForm('Rename Wallet',
        [{ name: 'name', label: 'New Name' }]);
    if (!d || !d.name.trim()) return;

    target.name = d.name.trim();
    await rewriteWalletFile();
    refreshWalletList();
    log('Wallet renamed.', 'success');
}

async function doDeleteWallet() {
    if (DECRYPTED_WALLETS.length === 0) return;
    const pick = await showListPicker('Delete Wallet', DECRYPTED_WALLETS.map(w => w.name));
    if (!pick) return;
    const target = DECRYPTED_WALLETS[pick.index];

    const ok = await showConfirm('Delete Wallet',
        `Move "${target.name}" to trash?\n${target.wallet.address}`);
    if (!ok) return;

    let raw = [];
    if (fs.existsSync(WALLETS_FILE)) raw = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));

    // Match by name (best effort)
    const idx = raw.findIndex(r => r.name === target.name);
    if (idx === -1) { log('Wallet not found in storage.', 'error'); return; }

    const deleted = raw.splice(idx, 1)[0];
    try {
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(raw, null, 2));
        let trash = [];
        if (fs.existsSync(TRASH_FILE)) trash = JSON.parse(fs.readFileSync(TRASH_FILE, 'utf8'));
        trash.push(deleted);
        fs.writeFileSync(TRASH_FILE, JSON.stringify(trash, null, 2));
    } catch (e) {
        log(`Failed to delete: ${e.message}`, 'error');
        return;
    }

    DECRYPTED_WALLETS.splice(pick.index, 1);
    if (currentWalletIndex >= DECRYPTED_WALLETS.length) currentWalletIndex = Math.max(0, DECRYPTED_WALLETS.length - 1);
    refreshWalletList();
    log('Wallet moved to trash.', 'success');
}

async function doShowPrivateKey() {
    if (DECRYPTED_WALLETS.length === 0) return;
    const pick = await showListPicker('Show Private Key', DECRYPTED_WALLETS.map(w => w.name));
    if (!pick) return;
    const target = DECRYPTED_WALLETS[pick.index];

    const ok = await showConfirm('WARNING',
        `Reveal private key for "${target.name}"?\nThis will be displayed on screen.`);
    if (!ok) return;

    createMessageBox(`🔑  Private Key — ${target.name}`,
        `{center}{bold}{red-fg}${target.wallet.privateKey}{/red-fg}{/bold}{/center}\n\n` +
        `{center}{yellow-fg}Clear your screen immediately after copying.{/yellow-fg}{/center}`,
        'warn');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Token Management
// ═══════════════════════════════════════════════════════════════════════════════

async function showTokenManagementMenu() {
    const items = ['Add Token by Address', 'Remove Saved Token', 'Back'];
    const pick = await showListPicker('Token Management', items);
    if (!pick || pick.text === 'Back') return;

    if (pick.text === 'Add Token by Address') {
        const nets = Object.keys(NETWORKS);
        const netPick = await showListPicker('Network', nets.map(k => NETWORKS[k].name));
        if (!netPick) return;
        const netKey = Object.keys(NETWORKS).find(k => NETWORKS[k].name === netPick.value);

        const d = await promptForm('Add Token', [
            { name: 'addr', label: 'Contract Address' },
            { name: 'sym',  label: 'Symbol (optional)' }
        ]);
        if (!d || !d.addr.trim()) return;

        setLoading('Verifying token');
        try {
            const provider = getProvider(netKey);
            const contract = new ethers.Contract(d.addr.trim(), ERC20_ABI, provider);
            const symbol   = d.sym.trim() || await contract.symbol();
            const decimals = await contract.decimals();

            USER_SETTINGS.savedTokens.push({
                symbol, address: d.addr.trim(), network: netKey,
                decimals: Number(decimals)
            });
            saveSettings({ savedTokens: USER_SETTINGS.savedTokens });
            log(`Added ${symbol} on ${netKey}.`, 'success');
        } catch (e) {
            log(`Token verification failed: ${e.message}`, 'error');
        }
        closeOverlay();
    }

    if (pick.text === 'Remove Saved Token') {
        if (!USER_SETTINGS.savedTokens || USER_SETTINGS.savedTokens.length === 0) {
            log('No saved tokens.', 'warn'); return;
        }
        const tPick = await showListPicker('Remove Token',
            USER_SETTINGS.savedTokens.map(t => `${t.symbol} (${t.network})`));
        if (!tPick) return;
        USER_SETTINGS.savedTokens.splice(tPick.index, 1);
        saveSettings({ savedTokens: USER_SETTINGS.savedTokens });
        log('Token removed.', 'success');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Recovery
// ═══════════════════════════════════════════════════════════════════════════════

async function showRecoveryMenu() {
    const st = recoveryStatus();
    const items = [
        `Setup Shamir SSS  ${st.shamir ? '✓' : ''}`,
        `Setup Guardian Key  ${st.guardian ? '✓' : ''}`,
        'Recover from Shamir Shares',
        'Recover from Guardian Mnemonic',
        'Back'
    ];
    const pick = await showListPicker('Vault Recovery', items);
    if (!pick || pick.text === 'Back') return;

    if (pick.text.startsWith('Setup Shamir')) {
        const d = await promptForm('Shamir Setup', [
            { name: 't', label: 'Threshold (≥2)', type: 'number' },
            { name: 'n', label: 'Total Shares',   type: 'number' }
        ]);
        if (!d) return;
        const pw = await promptForm('Vault Password',
            [{ name: 'pass', label: 'Password', type: 'password' }]);
        if (!pw) return;
        try {
            const { shares } = setupShamirRecovery(pw.pass, parseInt(d.t), parseInt(d.n));
            const content = shares.map((s, i) =>
                `{bold}Share ${i + 1}/${d.n}:{/bold}\n${s}\n`).join('\n');
            createMessageBox('🔑  Shamir Shares', content, 'warn');
            log('Shamir setup complete.', 'success');
        } catch (e) {
            log(`Shamir setup failed: ${e.message}`, 'error');
        }
    }

    if (pick.text.startsWith('Setup Guardian')) {
        const pw = await promptForm('Vault Password',
            [{ name: 'pass', label: 'Password', type: 'password' }]);
        if (!pw) return;
        try {
            const { mnemonic } = await setupGuardianKey(pw.pass);
            const words = mnemonic.split(' ');
            let out = '{bold}Guardian Mnemonic (24 words):{/bold}\n\n';
            for (let i = 0; i < words.length; i += 4)
                out += `  ${words.slice(i, i + 4).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w}`).join('   ')}\n`;
            createMessageBox('🔐  Guardian Key', out, 'warn');
            log('Guardian key setup complete.', 'success');
        } catch (e) {
            log(`Guardian setup failed: ${e.message}`, 'error');
        }
    }

    if (pick.text.startsWith('Recover from Shamir')) {
        const d = await promptForm('Shamir Recovery',
            [{ name: 'shares', label: 'Shares (comma-separated)' }]);
        if (!d) return;
        try {
            const shares = d.shares.split(',').map(s => s.trim()).filter(Boolean);
            const { password } = recoverFromShares(shares);
            createMessageBox('✅  Recovered Password', `{center}{bold}${password}{/bold}{/center}`, 'success');
        } catch (e) {
            log(`Recovery failed: ${e.message}`, 'error');
        }
    }

    if (pick.text.startsWith('Recover from Guardian')) {
        const d = await promptForm('Guardian Recovery',
            [{ name: 'phrase', label: '24-Word Mnemonic' }]);
        if (!d) return;
        try {
            const { password } = await recoverFromGuardian(d.phrase.trim());
            createMessageBox('✅  Recovered Password', `{center}{bold}${password}{/bold}{/center}`, 'success');
        } catch (e) {
            log(`Recovery failed: ${e.message}`, 'error');
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Connect (WalletConnect)
// ═══════════════════════════════════════════════════════════════════════════════

function showConnectForm() {
    if (DECRYPTED_WALLETS.length === 0) { log('No wallets loaded.', 'warn'); return; }
    createForm('WalletConnect', [
        { name: 'uri', label: 'Paste wc: URI' }
    ], data => {
        if (!data.uri.trim().startsWith('wc:')) {
            log('Invalid URI. Must start with wc:', 'error');
            return;
        }
        log('Spawning CLI for WalletConnect session…', 'info');
        const child = spawn(process.execPath, ['cli.js', data.uri.trim()], {
            env: { ...process.env, ...(sessionPassword ? { WALLET_PASS: sessionPassword } : {}) },
            stdio: 'inherit'
        });
        child.on('close', code => {
            log(`WalletConnect ended (code ${code}).`);
            refreshBalances();
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIEWS  ──  Network Switcher
// ═══════════════════════════════════════════════════════════════════════════════

async function showNetworkSwitcher() {
    const nets = Object.keys(NETWORKS).map(k => NETWORKS[k].name);
    const pick = await showListPicker('Switch Network', nets);
    if (!pick) return;
    const key = Object.keys(NETWORKS).find(k => NETWORKS[k].name === pick.value);
    currentNetwork = key;
    refreshWalletList();
    refreshBalances();
    refreshGasPrice();
    log(`Switched to ${NETWORKS[key].name}.`, 'success');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DISK HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function saveWalletToDisk(name, wallet, password) {
    let raw = [];
    if (fs.existsSync(WALLETS_FILE)) raw = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));

    if (USER_SETTINGS.encryptionDisabled || !password) {
        raw.push({ name, privateKey: wallet.privateKey });
    } else {
        const enc = await wallet.encrypt(password);
        raw.push({ name, data: enc });
    }
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(raw, null, 2));
}

async function rewriteWalletFile() {
    if (USER_SETTINGS.encryptionDisabled) {
        const raw = DECRYPTED_WALLETS.map(w => ({ name: w.name, privateKey: w.wallet.privateKey }));
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(raw, null, 2));
    } else {
        const password = sessionPassword || await getSessionPassword();
        if (!password) throw new Error('Password required');
        const raw = [];
        for (const w of DECRYPTED_WALLETS) {
            raw.push({ name: w.name, data: await w.wallet.encrypt(password) });
        }
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(raw, null, 2));
    }
}

function getSessionPassword() {
    return new Promise(resolve => {
        createForm('Vault Password',
            [{ name: 'pass', label: 'Password', type: 'password' }],
            data => {
                sessionPassword = data.pass;
                resolve(data.pass);
            },
            () => resolve(null)
        );
    });
}

function spawnCli(label) {
    log(`Launching CLI for: ${label}…`);
    const child = spawn(process.execPath, ['cli.js'], {
        env: { ...process.env, ...(sessionPassword ? { WALLET_PASS: sessionPassword } : {}) },
        stdio: 'inherit'
    });
    child.on('close', () => {
        log('Returned from CLI.');
        // Reload wallets from disk
        loadSettings();
        if (fs.existsSync(WALLETS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
            if (raw.length && !raw[0].privateKey && sessionPassword) {
                unlockWallets(sessionPassword).then(() => {
                    currentWalletIndex = 0;
                    refreshWalletList();
                    refreshBalances();
                }).catch(() => {});
            } else if (raw.length && raw[0].privateKey) {
                DECRYPTED_WALLETS.length = 0;
                raw.forEach(r => DECRYPTED_WALLETS.push({ name: r.name, wallet: new ethers.Wallet(r.privateKey) }));
                currentWalletIndex = 0;
                refreshWalletList();
                refreshBalances();
            }
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MENU BAR
// ═══════════════════════════════════════════════════════════════════════════════

const menuActions = [
    showTransferForm,
    showSwapForm,
    showPortfolio,
    showConnectForm,
    showWalletManagementMenu,
    showTokenManagementMenu,
    showRecoveryMenu,
    showSettingsMenu,
    () => process.exit(0)
];

const menuItems = {
    ' 1 Transfer ': menuActions[0],
    ' 2 Swap ':     menuActions[1],
    ' 3 Portfolio ': menuActions[2],
    ' 4 Connect ':   menuActions[3],
    ' 5 Wallets ':   menuActions[4],
    ' 6 Tokens ':    menuActions[5],
    ' 7 Recovery ':  menuActions[6],
    ' 8 Settings ':  menuActions[7],
    ' 9 Quit ':      menuActions[8]
};

menuBar.setItems(menuItems);

// ═══════════════════════════════════════════════════════════════════════════════
//  KEYBINDINGS
// ═══════════════════════════════════════════════════════════════════════════════

screen.key(['q', 'C-c'], () => process.exit(0));
screen.key(['escape'], () => {
    if (activeOverlay) closeOverlay();
});
screen.key(['n'], showNetworkSwitcher);
screen.key(['r'], () => {
    refreshBalances();
    refreshGasPrice();
});

// Number keys for menu
for (let i = 1; i <= 9; i++) {
    screen.key([String(i)], () => {
        if (activeOverlay) return;
        menuActions[i - 1]();
    });
}

// Arrow keys for wallet selection
screen.key(['left'], () => {
    if (activeOverlay) return;
    if (DECRYPTED_WALLETS.length === 0) return;
    currentWalletIndex = (currentWalletIndex - 1 + DECRYPTED_WALLETS.length) % DECRYPTED_WALLETS.length;
    refreshWalletList();
    refreshBalances();
});
screen.key(['right'], () => {
    if (activeOverlay) return;
    if (DECRYPTED_WALLETS.length === 0) return;
    currentWalletIndex = (currentWalletIndex + 1) % DECRYPTED_WALLETS.length;
    refreshWalletList();
    refreshBalances();
});

walletList.on('select', (item, index) => {
    currentWalletIndex = index;
    refreshWalletList();
    refreshBalances();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  INITIALISATION
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
    loadSettings();
    updateHeader();
    updateStatusBar();

    if (hasEncryptedWallets()) {
        const pwForm = blessed.form({
            parent: screen,
            keys: true,
            left: 'center', top: 'center',
            width: '50%', height: 10,
            bg: C.panelBg,
            border: { type: 'line', fg: C.border },
            label: ' {bold}🔐  Unlock Vault{/bold} ',
            tags: true
        });

        blessed.text({
            parent: pwForm, top: 2, left: 2, right: 2,
            content: 'Enter your vault password to decrypt wallets:',
            style: { fg: C.muted }
        });

        const pwInput = blessed.textbox({
            parent: pwForm,
            top: 4, left: 2, right: 2, height: 3,
            inputOnFocus: true,
            censor: true,
            border: { type: 'line', fg: C.borderDim },
            style: {
                fg: 'white', bg: C.inputBg,
                focus: { border: { fg: C.accent }, bg: C.focusBg }
            }
        });

        pwInput.key('enter', async () => {
            const pass = pwInput.getValue();
            try {
                setLoading('Decrypting');
                await unlockWallets(pass);
                sessionPassword = pass;
                closeOverlay();
                startDashboard();
            } catch (e) {
                closeOverlay();
                log(`Unlock failed: ${e.message}`, 'error');
                pwInput.setValue('');
                pwInput.focus();
                screen.render();
            }
        });

        pwForm.key(['escape'], () => process.exit(0));
        showOverlay(pwForm);
        pwInput.focus();
    } else {
        log('No wallets found. Use [5] Wallets menu to create or import one.', 'warn');
        startDashboard();
    }
}

function startDashboard() {
    refreshWalletList();
    showDashboard();
    refreshGasPrice();
    walletList.focus();

    // Periodic header clock & gas refresh
    refreshTimer = setInterval(() => {
        updateHeader();
        refreshGasPrice();
    }, 30000);

    screen.render();
}

init().catch(e => {
    console.error('TUI init error:', e);
    process.exit(1);
});
