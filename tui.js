#!/usr/bin/env node
import blessed from 'blessed';
import contrib from 'blessed-contrib';
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
    ERC20_ABI
} from './core.js';
import { ethers } from 'ethers';

// --- Setup Screen ---
const screen = blessed.screen({
  smartCSR: true,
  title: 'Multi-Wallet TUI'
});

// --- State ---
let currentWalletIndex = 0;
let currentNetwork = 'bsc'; // Default to BSC

// --- UI Elements ---
const grid = new contrib.grid({rows: 12, cols: 12, screen: screen});

// 1. Menu Bar (Top)
const menuBar = grid.set(0, 0, 1, 12, blessed.listbar, {
    items: {
        'Transfer (t)': () => showTransferForm(),
        'Swap (s)': () => showSwapForm(),
        'Connect (c)': () => showConnectForm(),
        'Refresh (r)': () => refreshBalances(),
        'Quit (q)': () => process.exit(0)
    },
    style: { item: { fg: 'white' }, selected: { bg: 'blue' } },
    autoCommandKeys: true
});

const walletList = grid.set(1, 0, 7, 3, blessed.list, {
  label: 'Wallets',
  keys: true,
  vi: true,
  style: { selected: { bg: 'blue', fg: 'white' } }
});

const balanceTable = grid.set(1, 3, 4, 9, contrib.table, {
  keys: true,
  fg: 'white',
  selectedFg: 'white',
  selectedBg: 'blue',
  interactive: false,
  label: 'Balances (BSC)',
  width: '30%',
  height: '30%',
  border: {type: "line", fg: "cyan"},
  columnSpacing: 10,
  columnWidth: [10, 20, 20]
});

const logBox = grid.set(8, 0, 4, 12, blessed.log, {
  fg: "green",
  selectedFg: "green",
  label: 'Activity Log'
});

const helpBox = grid.set(4, 3, 4, 9, blessed.box, {
    label: 'Controls',
    content: 'UP/DOWN: Select Wallet | q: Quit | n: Switch Network'
});

// --- Logic ---

function log(msg) {
    logBox.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function refreshBalances() {
    if (DECRYPTED_WALLETS.length === 0) return;
    
    const wallet = DECRYPTED_WALLETS[currentWalletIndex];
    if (!wallet) return;

    log(`Fetching balances for ${wallet.name} on ${currentNetwork}...`);
    
    // Native
    const tableData = [];
    try {
        const bal = await getNativeBalance(wallet.wallet.address, currentNetwork);
        const symbol = NETWORKS[currentNetwork].currency;
        
        const price = await getPrice(NETWORKS[currentNetwork].coingeckoId);
        const val = (parseFloat(bal) * price).toFixed(2);
        
        tableData.push([symbol, parseFloat(bal).toFixed(4), val]);
        
        // Tokens
        const tokensToCheck = [];
        if (PREDEFINED_TOKENS[currentNetwork]) tokensToCheck.push(...PREDEFINED_TOKENS[currentNetwork]);
        if (USER_SETTINGS.savedTokens) {
            tokensToCheck.push(...USER_SETTINGS.savedTokens.filter(t => t.network === currentNetwork));
        }

        const provider = new ethers.JsonRpcProvider(NETWORKS[currentNetwork].rpc);

        for (const token of tokensToCheck) {
            try {
                const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
                const balWei = await contract.balanceOf(wallet.wallet.address);
                const decimals = token.decimals || await contract.decimals();
                const symbol = token.symbol || await contract.symbol();
                const balFloat = parseFloat(ethers.formatUnits(balWei, decimals));

                if (balFloat > 0) {
                    let valStr = "0.00";
                    if (token.coingeckoId) {
                        const tPrice = await getPrice(token.coingeckoId);
                        valStr = (balFloat * tPrice).toFixed(2);
                    }
                    tableData.push([symbol, balFloat.toFixed(4), valStr]);
                }
            } catch (e) {
                // Ignore error for specific token
            }
        }

        balanceTable.setData({
            headers: ['Asset', 'Balance', `Value (${USER_SETTINGS.currency})`],
            data: tableData
        });
        screen.render();
        log(`Balance updated.`);
    } catch (e) {
        log(`Error: ${e.message}`);
    }
}

// --- Helpers ---

function createForm(title, fields, onSubmit) {
    const form = blessed.form({
        parent: screen,
        keys: true,
        left: 'center',
        top: 'center',
        width: '60%',
        height: '60%',
        bg: 'blue',
        label: title,
        border: { type: 'line' }
    });

    const inputs = {};
    let offset = 1;

    fields.forEach(f => {
        blessed.text({
            parent: form,
            top: offset,
            left: 2,
            content: f.label
        });
        
        inputs[f.name] = blessed.textbox({
            parent: form,
            name: f.name,
            top: offset,
            left: 20,
            width: '50%',
            height: 3,
            inputOnFocus: true,
            border: { type: 'line' },
            style: { focus: { border: { fg: 'white' } } }
        });
        offset += 4;
    });

    const submitBtn = blessed.button({
        parent: form,
        bottom: 2,
        left: 'center',
        content: ' SUBMIT ',
        style: { bg: 'green', fg: 'black', focus: { bg: 'white' } },
        shrink: true,
        padding: { left: 1, right: 1 }
    });

    const cancelBtn = blessed.button({
        parent: form,
        bottom: 2,
        right: 2,
        content: ' CANCEL ',
        style: { bg: 'red', fg: 'white', focus: { bg: 'white' } },
        shrink: true,
        padding: { left: 1, right: 1 }
    });

    submitBtn.on('press', () => {
        const data = {};
        Object.keys(inputs).forEach(k => data[k] = inputs[k].getValue());
        onSubmit(data);
        form.detach();
        screen.render();
    });

    cancelBtn.on('press', () => {
        form.detach();
        screen.render();
    });

    inputs[fields[0].name].focus(); // Focus first
    screen.render();
}

function showTransferForm() {
    createForm('Transfer Asset', [
        { name: 'to', label: 'Recipient:' },
        { name: 'amount', label: 'Amount:' },
        { name: 'token', label: 'Token (Native/USDT):' } // Simplified for now
    ], async (data) => {
        log(`Sending ${data.amount} ${data.token} to ${data.to}...`);
        
        const wallet = DECRYPTED_WALLETS[currentWalletIndex].wallet;
        const provider = new ethers.JsonRpcProvider(NETWORKS[currentNetwork].rpc);
        const signer = wallet.connect(provider);

        try {
            if (data.token.toLowerCase() === 'native') {
                const tx = await signer.sendTransaction({
                    to: data.to,
                    value: ethers.parseEther(data.amount)
                });
                log(`✅ Sent! Hash: ${tx.hash}`);
            } else {
                // Find token address (simple search)
                const tokens = PREDEFINED_TOKENS[currentNetwork] || [];
                const tokenInfo = tokens.find(t => t.symbol === data.token.toUpperCase());
                
                if (!tokenInfo) {
                    log(`❌ Token ${data.token} not found on ${currentNetwork}`);
                    return;
                }
                
                const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
                const tx = await contract.transfer(data.to, ethers.parseUnits(data.amount, tokenInfo.decimals));
                log(`✅ Sent! Hash: ${tx.hash}`);
            }
        } catch (e) {
            log(`❌ Failed: ${e.message}`);
        }
    });
}

function showConnectForm() {
    createForm('Connect Wallet', [
        { name: 'uri', label: 'WalletConnect URI:' }
    ], (data) => {
        log("Connecting... (Not implemented in TUI yet, run 'my-wallet' for robust connection)");
        // Implementing full WC in TUI is complex due to event loop blocking. 
        // Best to spawn a child process or refactor heavily.
    });
}

function showSwapForm() {
    log("Swap feature coming soon to TUI.");
}

async function init() {
    loadSettings();
    if (hasEncryptedWallets()) {
        // Show Password Prompt
        const form = blessed.form({
            parent: screen,
            keys: true,
            left: 'center',
            top: 'center',
            width: '50%',
            height: 10,
            bg: 'blue',
            content: 'Enter Vault Password:'
        });

        const passwordInput = blessed.textbox({
            parent: form,
            top: 3,
            left: 'center',
            width: '80%',
            height: 3,
            inputOnFocus: true,
            censor: true,
            border: { type: 'line' },
            style: { focus: { border: { fg: 'white' } } }
        });

        passwordInput.key('enter', async () => {
            const pass = passwordInput.getValue();
            try {
                log("Unlocking wallets...");
                await unlockWallets(pass);
                form.detach();
                screen.render();
                startDashboard();
            } catch (e) {
                log(`Unlock failed: ${e.message}`);
                passwordInput.setValue('');
                passwordInput.focus();
            }
        });

        passwordInput.focus();
        screen.render();
    } else {
        log("No wallets found. Please run 'my-wallet' CLI to create one.");
    }
}

function startDashboard() {
    const names = DECRYPTED_WALLETS.map(w => w.name);
    walletList.setItems(names);
    walletList.focus();
    
    walletList.on('select', (item, index) => {
        currentWalletIndex = index;
        refreshBalances();
    });

    screen.key(['n'], () => {
        // Simple network toggle
        const nets = Object.keys(NETWORKS);
        const idx = nets.indexOf(currentNetwork);
        currentNetwork = nets[(idx + 1) % nets.length];
        balanceTable.setLabel(`Balances (${NETWORKS[currentNetwork].name})`);
        refreshBalances();
    });

    refreshBalances();
    screen.render();
}

// --- Keybindings ---
screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

init();