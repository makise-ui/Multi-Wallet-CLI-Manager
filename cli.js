#!/usr/bin/env node
import fs from 'fs';
import inquirer from 'inquirer';
import { ethers } from 'ethers';
import { SignClient } from "@walletconnect/sign-client";
import os from 'os';
import path from 'path';
import 'dotenv/config'; // Load .env
import { setupDrive, setupRclone, triggerBackup } from './drive.js';

const PROJECT_ID = process.env.PROJECT_ID;
if (!PROJECT_ID) {
    console.error("❌ Error: PROJECT_ID is missing from .env file.");
    process.exit(1);
}

const CONFIG_DIR = path.join(os.homedir(), '.my-cli-wallet');
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);

const WALLETS_FILE = path.join(CONFIG_DIR, 'my_wallets.json');
const TRASH_FILE = path.join(CONFIG_DIR, 'trash_wallets.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const RPC_URL = "https://eth.llamarpc.com";

// ... (existing code)

async function deleteWallet() {
    if (DECRYPTED_WALLETS.length === 0) return;

    const wChoices = DECRYPTED_WALLETS.map(w => ({ name: `${w.name} (${w.address})`, value: w.wallet.address }));
    wChoices.push({ name: '🔙 Back', value: 'BACK' });

    const choice = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'addr',
            message: 'Select Wallet to DELETE (Move to Trash):',
            choices: wChoices
        }
    ]);

    if (choice.addr === 'BACK') return;

    const confirm = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'sure',
            message: 'Are you sure? It will be removed from active list.',
            choices: ['Yes', 'No']
        }
    ]);

    if (confirm.sure === 'No') return;

    // Load Raw
    const rawWallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    const walletIndex = rawWallets.findIndex(w => {
        // Need to match by checking if decrypt works? No, assuming order or re-encrypt.
        // We don't have ID. But we have address in memory.
        // We can't match encrypted data easily without decrypting all raw again or relying on index if distinct.
        // Better: We stored name in raw. Match by name? Names can be duplicates? 
        // Let's rely on name for now or better, decrypt to check address.
        return w.name === DECRYPTED_WALLETS.find(dw => dw.wallet.address === choice.addr).name;
    });

    if (walletIndex === -1) {
        console.log("❌ Error finding wallet in storage.");
        return;
    }

    const deletedWallet = rawWallets.splice(walletIndex, 1)[0];
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(rawWallets, null, 2));

    // Add to Trash
    let trash = [];
    if (fs.existsSync(TRASH_FILE)) {
        trash = JSON.parse(fs.readFileSync(TRASH_FILE, 'utf8'));
    }
    trash.push(deletedWallet);
    fs.writeFileSync(TRASH_FILE, JSON.stringify(trash, null, 2));

    // Update Memory
    DECRYPTED_WALLETS = DECRYPTED_WALLETS.filter(w => w.wallet.address !== choice.addr);
    
    console.log("🗑️ Wallet moved to Trash. You can restore it from Settings.");
    await triggerBackup(USER_SETTINGS);
}

async function restoreWallet() {
    if (!fs.existsSync(TRASH_FILE)) {
        console.log("No deleted wallets found.");
        return;
    }
    const trash = JSON.parse(fs.readFileSync(TRASH_FILE, 'utf8'));
    if (trash.length === 0) {
        console.log("Trash is empty.");
        return;
    }

    const choices = trash.map((w, i) => ({ name: w.name, value: i }));
    choices.push({ name: '🔙 Back', value: 'BACK' });

    const choice = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'idx',
            message: 'Select Wallet to Restore:',
            choices: choices
        }
    ]);

    if (choice.idx === 'BACK') return;

    const restored = trash.splice(choice.idx, 1)[0];
    fs.writeFileSync(TRASH_FILE, JSON.stringify(trash, null, 2));

    const rawWallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    rawWallets.push(restored);
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(rawWallets, null, 2));

    // Unlock it into memory
    const password = await getPassword();
    try {
        const wallet = await ethers.Wallet.fromEncryptedJson(restored.data, password);
        DECRYPTED_WALLETS.push({ name: restored.name, wallet: wallet });
        console.log(`✅ Restored ${restored.name}!`);
    } catch(e) {
        console.log("⚠️  Restored file, but failed to unlock in current session (Password mismatch?). Restart app to retry.");
    }
    await triggerBackup(USER_SETTINGS);
}


let DECRYPTED_WALLETS = []; 
let SESSION_PASSWORD = null;
let USER_SETTINGS = { 
    currency: 'USD',
    defaultNetwork: 'ethereum',
    gasLimitBuffer: '0',
    backupMethod: null, // 'rclone' or 'gapi'
    rcloneRemote: null,
    savedTokens: [] // { symbol: "USDT", address: "0x...", network: "bsc", decimals: 18 }
};

// Load Settings
if (fs.existsSync(SETTINGS_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    // Migration: Ensure savedTokens exists
    if (!loaded.savedTokens) loaded.savedTokens = [];
    USER_SETTINGS = { ...USER_SETTINGS, ...loaded };
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(USER_SETTINGS, null, 2));
    triggerBackup(USER_SETTINGS);
}

// Supported Networks
const NETWORKS = {
    "ethereum": { name: "Ethereum Mainnet", rpc: "https://eth.llamarpc.com", chainId: 1, currency: "ETH", coingeckoId: "ethereum" },
    "bsc": { name: "Binance Smart Chain", rpc: "https://bsc-dataseed.binance.org", chainId: 56, currency: "BNB", coingeckoId: "binancecoin" },
    "polygon": { name: "Polygon (Matic)", rpc: "https://polygon-rpc.com", chainId: 137, currency: "POL", coingeckoId: "matic-network" },
    "celo": { name: "Celo Mainnet", rpc: "https://forno.celo.org", chainId: 42220, currency: "CELO", coingeckoId: "celo" }
};

// Common Token Addresses
const PREDEFINED_TOKENS = {
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

async function getPrice(coingeckoId) {
    if (!coingeckoId) return 0;
    try {
        const currency = USER_SETTINGS.currency.toLowerCase();
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=${currency}`);
        const data = await res.json();
        return data[coingeckoId] ? data[coingeckoId][currency] : 0;
    } catch (e) {
        return 0; // API failure or rate limit
    }
}

async function manageTokens() {
    const action = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'do',
            message: 'Manage Tokens:',
            choices: ['Add New Token', 'Remove Token', 'Back']
        }
    ]);

    if (action.do === 'Back') return;

    if (action.do === 'Add New Token') {
        // 1. Select Network
        const network = await selectNetwork();
        
        // 2. Paste Address
        const input = await inquirer.prompt([{ type: 'input', name: 'addr', message: 'Token Contract Address:' }]);
        const address = input.addr.trim();

        // 3. Fetch Details
        try {
            console.log("⏳ Fetching token details...");
            const provider = new ethers.JsonRpcProvider(network.rpc);
            const contract = new ethers.Contract(address, ERC20_ABI, provider);
            const symbol = await contract.symbol();
            const decimals = await contract.decimals();

            console.log(`✅ Found ${symbol} (Decimals: ${decimals})`);
            
            const confirm = await inquirer.prompt([{ type: 'confirm', name: 'save', message: 'Save this token?', default: true }]);
            if (confirm.save) {
                USER_SETTINGS.savedTokens.push({ symbol, address, network: Object.keys(NETWORKS).find(key => NETWORKS[key].rpc === network.rpc), decimals: Number(decimals) });
                saveSettings();
                console.log("💾 Token Saved!");
            }
        } catch (e) {
            console.log(`❌ Could not fetch token info: ${e.message}`);
        }
    } else if (action.do === 'Remove Token') {
        if (USER_SETTINGS.savedTokens.length === 0) {
            console.log("No saved tokens.");
            return;
        }
        const choice = await inquirer.prompt([{
            type: 'rawlist',
            name: 'token',
            message: 'Select Token to Remove:',
            choices: USER_SETTINGS.savedTokens.map((t, i) => ({ name: `${t.symbol} (${t.network})`, value: i }))
        }]);
        
        USER_SETTINGS.savedTokens.splice(choice.token, 1);
        saveSettings();
        console.log("🗑️ Token Removed.");
    }
    
    // Loop back
    await manageTokens();
}

async function changeSettings() {
    const action = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'setting',
            message: 'Which setting to change?',
            choices: [
                'Preferred Currency',
                'Default Network',
                'Gas Limit Buffer (Advanced)',
                'Manage Custom Tokens',
                'Backup Configuration',
                'Restore Deleted Wallet',
                'Back'
            ]
        }
    ]);

    if (action.setting === 'Back') return;
    
    if (action.setting === 'Restore Deleted Wallet') {
        await restoreWallet();
        return;
    }
    
    if (action.setting === 'Backup Configuration') {
        const type = await inquirer.prompt([
            {
                type: 'rawlist',
                name: 'method',
                message: 'Select Backup Method:',
                choices: ['Rclone (Recommended)', 'Google Drive Native API', 'Disable Backup']
            }
        ]);

        if (type.method === 'Rclone (Recommended)') {
            const remote = await setupRclone();
            if (remote) {
                USER_SETTINGS.backupMethod = 'rclone';
                USER_SETTINGS.rcloneRemote = remote;
                console.log(`✅ Backup configured using Rclone remote: ${remote}`);
            }
        } else if (type.method === 'Google Drive Native API') {
            await setupDrive();
            USER_SETTINGS.backupMethod = 'gapi';
            console.log("✅ Backup configured using Native API.");
        } else {
            USER_SETTINGS.backupMethod = null;
            console.log("🚫 Backup disabled.");
        }
        saveSettings();
        return;
    }

    if (action.setting === 'Manage Custom Tokens') {
        await manageTokens();
        return;
    }

    if (action.setting === 'Preferred Currency') {
        const answer = await inquirer.prompt([
            {
                type: 'rawlist',
                name: 'currency',
                message: 'Select Currency:',
                choices: ['USD', 'INR', 'EUR', 'GBP', 'JPY']
            }
        ]);
        USER_SETTINGS.currency = answer.currency;
    } else if (action.setting === 'Default Network') {
        const choices = Object.keys(NETWORKS).map(key => ({ name: NETWORKS[key].name, value: key }));
        const answer = await inquirer.prompt([
            {
                type: 'rawlist',
                name: 'network',
                message: 'Select Default Network:',
                choices: choices
            }
        ]);
        USER_SETTINGS.defaultNetwork = answer.network;
    } else if (action.setting === 'Gas Limit Buffer (Advanced)') {
        const answer = await inquirer.prompt([
            {
                type: 'input',
                name: 'buffer',
                message: 'Enter Gas Limit buffer (0 to disable, e.g. 10000):',
                default: USER_SETTINGS.gasLimitBuffer
            }
        ]);
        USER_SETTINGS.gasLimitBuffer = answer.buffer;
    }

    saveSettings();
    console.log(`✅ Settings saved!`);
}

// Router Addresses (Uniswap V2 style)
const ROUTERS = {
    "ethereum": "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2
    "bsc": "0x10ED43C718714eb63d5aA57B78B54704E256024E",      // PancakeSwap V2
    "polygon": "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  // QuickSwap
    "celo": "0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121"      // Ubeswap (example, verify if V2 compatible)
};

const ROUTER_ABI = [
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external"
];

const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function transfer(address to, uint amount) returns (bool)",
    "function approve(address spender, uint amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

// --- Wallet Management ---

async function getPassword(confirm = false) {
    if (SESSION_PASSWORD) return SESSION_PASSWORD;
    
    const questions = [{
        type: 'password',
        name: 'password',
        message: 'Enter your wallet vault password:',
        mask: '*'
    }];
    
    if (confirm) {
        questions.push({
            type: 'password',
            name: 'confirm',
            message: 'Confirm password:',
            mask: '*'
        });
    }

    const answers = await inquirer.prompt(questions);
    
    if (confirm && answers.password !== answers.confirm) {
        console.log("❌ Passwords do not match. Try again.");
        return getPassword(confirm);
    }
    
    SESSION_PASSWORD = answers.password;
    return SESSION_PASSWORD;
}

function loadWalletsRaw() {
  if (!fs.existsSync(WALLETS_FILE)) {
    return [];
  }
  const data = fs.readFileSync(WALLETS_FILE, 'utf8');
  return JSON.parse(data);
}

async function initializeWallets() {
    const rawWallets = loadWalletsRaw();
    if (rawWallets.length === 0) return;

    // Check if migration is needed (if wallets have 'privateKey' property)
    if (rawWallets[0].privateKey) {
        console.log("⚠️  Unencrypted wallets detected! Securing them now...");
        const password = await getPassword(true);
        
        DECRYPTED_WALLETS = [];
        const encryptedStore = [];

        for (const w of rawWallets) {
            console.log(`🔒 Encrypting ${w.name}...`);
            const wallet = new ethers.Wallet(w.privateKey);
            const encryptedJson = await wallet.encrypt(password);
            
            DECRYPTED_WALLETS.push({ name: w.name, wallet: wallet });
            encryptedStore.push({ name: w.name, data: encryptedJson });
        }
        
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(encryptedStore, null, 2));
        console.log("✅ All wallets encrypted and saved!");
        await triggerBackup(USER_SETTINGS);
    } else {
        // Decrypt existing
        console.log("🔐 Wallets are encrypted.");
        let attempts = 3;
        while (attempts > 0) {
            const password = await getPassword();
            try {
                DECRYPTED_WALLETS = [];
                for (const w of rawWallets) {
                    const wallet = await ethers.Wallet.fromEncryptedJson(w.data, password);
                    DECRYPTED_WALLETS.push({ name: w.name, wallet: wallet });
                }
                console.log(`🔓 Successfully unlocked ${DECRYPTED_WALLETS.length} wallets.`);
                break;
            } catch (e) {
                console.log("❌ Wrong password.");
                SESSION_PASSWORD = null; // Reset to ask again
                attempts--;
            }
        }
        if (attempts === 0) {
            console.log("🚫 Too many failed attempts. Exiting.");
            process.exit(1);
        }
    }
}

async function saveEncryptedWallet(name, wallet) {
    const password = await getPassword();
    console.log("⏳ Encrypting wallet...");
    const encryptedJson = await wallet.encrypt(password);
    
    const rawWallets = loadWalletsRaw();
    rawWallets.push({ name: name, data: encryptedJson });
    
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(rawWallets, null, 2));
    
    // Update memory
    DECRYPTED_WALLETS.push({ name: name, wallet: wallet });
    console.log(`✅ Wallet '${name}' saved securely.`);
    await triggerBackup(USER_SETTINGS);
}

async function createNewWallet() {
  console.log("Creating new wallet locally on device...");
  const wallet = ethers.Wallet.createRandom();
  const nameAnswer = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Give this wallet a name (e.g. "Main", "Burner":',
      default: `Wallet ${DECRYPTED_WALLETS.length + 1}`
    }
  ]);
  
  if (DECRYPTED_WALLETS.length === 0 && !fs.existsSync(WALLETS_FILE)) {
      // First time setup, ask for password confirm
      await getPassword(true); 
  }

  await saveEncryptedWallet(nameAnswer.name, wallet);
  console.log(`🔑 Address: ${wallet.address}`);
}

async function importWallet() {
    console.log("Importing existing wallet...");
    
    // Ensure we have a password set/active before importing
    if (DECRYPTED_WALLETS.length === 0 && !fs.existsSync(WALLETS_FILE)) {
        await getPassword(true);
    } else {
        await getPassword();
    }

    const method = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'type',
            message: 'Import method:',
            choices: [
                { name: 'Private Key', value: 'pk' },
                { name: 'Mnemonic Phrase (12/24 words)', value: 'mnemonic' }
            ]
        }
    ]);

    let wallet;
    try {
        if (method.type === 'pk') {
            const input = await inquirer.prompt([{ 
                type: 'password', 
                name: 'key', 
                message: 'Enter Private Key:', 
                mask: '*' 
            }]);
            wallet = new ethers.Wallet(input.key);
        } else {
            const input = await inquirer.prompt([{ 
                type: 'password', 
                name: 'phrase', 
                message: 'Enter Mnemonic Phrase:', 
                mask: '*' 
            }]);
            wallet = ethers.Wallet.fromPhrase(input.phrase);
        }
    } catch (e) {
        console.log(`❌ Invalid Key or Phrase: ${e.message}`);
        return;
    }

    console.log(`✅ Valid wallet found: ${wallet.address}`);

    const nameAnswer = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Give this wallet a name:',
            default: `Imported ${DECRYPTED_WALLETS.length + 1}`
        }
    ]);

    await saveEncryptedWallet(nameAnswer.name, wallet);
}

async function renameWallet() {
    if (DECRYPTED_WALLETS.length === 0) return;

    const choice = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'walletAddr',
            message: 'Select wallet to rename:',
            choices: DECRYPTED_WALLETS.map(w => ({ name: w.name, value: w.wallet.address }))
        }
    ]);
    
    const newName = await inquirer.prompt([
        { type: 'input', name: 'name', message: 'Enter new name/tag:' }
    ]);

    // Update in memory
    const target = DECRYPTED_WALLETS.find(w => w.wallet.address === choice.walletAddr);
    target.name = newName.name;

    // Update on disk 
    const newRawStore = [];
    const password = await getPassword();
    console.log("⏳ Re-saving wallet names...");
    
    for (const w of DECRYPTED_WALLETS) {
        const encryptedJson = await w.wallet.encrypt(password);
        newRawStore.push({ name: w.name, data: encryptedJson });
    }
    
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(newRawStore, null, 2));
    console.log("✅ Wallet renamed.");
    await triggerBackup(USER_SETTINGS);
}

async function listWallets() {
  if (DECRYPTED_WALLETS.length === 0) {
    console.log("No wallets unlocked. Create one first!");
    return [];
  }
  return DECRYPTED_WALLETS.map(w => ({ name: w.name, address: w.wallet.address }));
}

// --- Blockchain Actions ---

async function selectNetwork(includeBack = false) {
  const choices = Object.keys(NETWORKS).map(key => ({ 
      name: NETWORKS[key].name, 
      value: key 
  }));
  
  if (includeBack) {
      choices.push({ name: '🔙 Back', value: 'BACK' });
  }
  
  // Move default network to top or just pre-select it? Inquirer rawlist doesn't support 'default' index easily
  // But we can inform the user
  const defaultNet = USER_SETTINGS.defaultNetwork || 'ethereum';
  const defaultIndex = choices.findIndex(c => c.value === defaultNet);
  
  // Create a human readable prompt
  const msg = `Select Network (Default: ${defaultIndex + 1} - ${NETWORKS[defaultNet].name}):`;

  const answer = await inquirer.prompt([
      {
          type: 'rawlist',
          name: 'network',
          message: msg,
          choices: choices,
          default: defaultIndex 
      }
  ]);
  
  if (answer.network === 'BACK') return 'BACK';
  return NETWORKS[answer.network];
}
async function checkBalance() {
  const wallets = await listWallets();
  if (wallets.length === 0) return;

  const choices = wallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.address }));
  choices.push({ name: '🔙 Back', value: 'BACK' });

  const walletChoice = await inquirer.prompt([
    {
      type: 'rawlist',
      name: 'walletAddress',
      message: 'Select wallet:',
      choices: choices
    }
  ]);
  
  if (walletChoice.walletAddress === 'BACK') return;

  const selectedWalletData = wallets.find(w => w.address === walletChoice.walletAddress);
  
  const network = await selectNetwork(true); // true = include back option
  if (network === 'BACK') return;

  const provider = new ethers.JsonRpcProvider(network.rpc);

  console.log(`⏳ Fetching balances on ${network.name}...`);
  
  const nativeBalanceWei = await provider.getBalance(selectedWalletData.address);
  const nativeBalance = parseFloat(ethers.formatEther(nativeBalanceWei));
  const nativePrice = await getPrice(network.coingeckoId);
  const nativeValue = (nativeBalance * nativePrice).toFixed(2);
  
  console.log(`
💰 Native: ${nativeBalance} ${network.currency} (≈ ${nativeValue} ${USER_SETTINGS.currency})`);

  // 2. Check Tokens (Predefined + Saved)
  const networkKey = Object.keys(NETWORKS).find(key => NETWORKS[key].rpc === network.rpc);
  
  // Build list of tokens to check
  const tokensToCheck = [];
  
  // Add Predefined Tokens
  if (PREDEFINED_TOKENS[networkKey]) {
      tokensToCheck.push(...PREDEFINED_TOKENS[networkKey]);
  }

  // Add user saved tokens for this network
  if (USER_SETTINGS.savedTokens) {
      const saved = USER_SETTINGS.savedTokens.filter(t => t.network === networkKey);
      tokensToCheck.push(...saved);
  }

  if (tokensToCheck.length > 0) {
      console.log("\n💎 Checking Tokens:");
      for (const token of tokensToCheck) {
          try {
              const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
              const balanceWei = await contract.balanceOf(selectedWalletData.address);
              // Use saved decimals if available, else fetch
              const decimals = token.decimals || await contract.decimals();
              const symbol = token.symbol || await contract.symbol();
              
              const bal = parseFloat(ethers.formatUnits(balanceWei, decimals));
              
              // Only fetch price if coingeckoId is known
              let valStr = "";
              if (token.coingeckoId) {
                  const price = await getPrice(token.coingeckoId);
                  const val = (bal * price).toFixed(2);
                  valStr = `(≈ ${val} ${USER_SETTINGS.currency})`;
              }

              console.log(`   - ${bal} ${symbol} ${valStr}`);
          } catch (e) {
              // console.log(`   - ${token.symbol}: Error fetching balance`);
          }
      }
  }
}

async function transferAsset() {
    const wallets = await listWallets();
    if (wallets.length === 0) return;

    // 1. Select Sender
    const wChoices = wallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.address }));
    wChoices.push({ name: '🔙 Back', value: 'BACK' });

    const senderChoice = await inquirer.prompt([
        { type: 'rawlist', name: 'address', message: 'Select Sender Wallet:', choices: wChoices }
    ]);
    
    if (senderChoice.address === 'BACK') return;

    const senderWalletData = DECRYPTED_WALLETS.find(w => w.wallet.address === senderChoice.address); 
    const signer = senderWalletData.wallet;

    // 2. Select Network
    const network = await selectNetwork(true);
    if (network === 'BACK') return;
    
    const provider = new ethers.JsonRpcProvider(network.rpc);
    const connectedSigner = signer.connect(provider);

    // 3. Select Asset
    const networkKey = Object.keys(NETWORKS).find(key => NETWORKS[key].rpc === network.rpc);
    const assetOptions = [
        { name: `Native Coin (${network.currency})`, value: 'native' }
    ];

    if (PREDEFINED_TOKENS[networkKey]) {
        PREDEFINED_TOKENS[networkKey].forEach(t => {
            assetOptions.push({ name: `${t.symbol} Token`, value: t });
        });
    }

    assetOptions.push({ name: 'Custom Token Address', value: 'custom' });
    assetOptions.push({ name: '🔙 Back', value: 'BACK' });

    const assetChoice = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'type',
            message: 'What do you want to send?',
            choices: assetOptions
        }
    ]);

    if (assetChoice.type === 'BACK') return;

    let tokenAddress = null;
    let decimals = 18;
    let symbol = network.currency;

    if (assetChoice.type === 'native') {
        // do nothing, default
    } else if (assetChoice.type === 'custom') {
        const addrInput = await inquirer.prompt([{ type: 'input', name: 'addr', message: 'Enter Token Contract Address:' }]);
        tokenAddress = addrInput.addr;
    } else {
        // Predefined token object
        tokenAddress = assetChoice.type.address;
        decimals = assetChoice.type.decimals;
        symbol = assetChoice.type.symbol;
    }

    if (tokenAddress && assetChoice.type === 'custom') {
        try {
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
            decimals = await contract.decimals();
            symbol = await contract.symbol();
        } catch (e) {
            console.log("❌ Invalid token address or network error.");
            return;
        }
    }

    // 4. Recipient
    let recipientAddress = null;
    
    // Check if we have other wallets to send to
    const otherWallets = DECRYPTED_WALLETS.filter(w => w.wallet.address !== senderWalletData.wallet.address);
    
    let destType = 'manual';
    if (otherWallets.length > 0) {
        const destChoice = await inquirer.prompt([
            {
                type: 'rawlist',
                name: 'dest',
                message: 'Send to:',
                choices: ['Manual Address Entry', 'My Other Wallets']
            }
        ]);
        destType = destChoice.dest;
    }

    if (destType === 'My Other Wallets') {
        const targetChoice = await inquirer.prompt([
            {
                type: 'rawlist',
                name: 'wallet',
                message: 'Select Recipient Wallet:',
                choices: otherWallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.wallet.address }))
            }
        ]);
        recipientAddress = targetChoice.wallet;
    } else {
        const manualInput = await inquirer.prompt([
            { type: 'input', name: 'to', message: 'Recipient Address:' }
        ]);
        recipientAddress = manualInput.to;
    }

    // 5. Amount
    const details = await inquirer.prompt([
        { type: 'input', name: 'amount', message: `Amount to send (${symbol}):` }
    ]);

    console.log(`\n🚀 Preparing to send ${details.amount} ${symbol} on ${network.name}...`);
    console.log(`   To: ${recipientAddress}`);
    
    try {
        let txResponse;
        if (tokenAddress) {
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, connectedSigner);
            const amountWei = ethers.parseUnits(details.amount, decimals);
            txResponse = await contract.transfer(recipientAddress, amountWei);
        } else {
            // Native Transfer
            const amountWei = ethers.parseEther(details.amount);
            const txRequest = {
                to: recipientAddress,
                value: amountWei
            };
            
            // Add Gas Buffer if configured
            if (USER_SETTINGS.gasLimitBuffer && USER_SETTINGS.gasLimitBuffer !== '0') {
                const estimatedGas = await connectedSigner.estimateGas(txRequest);
                txRequest.gasLimit = estimatedGas + BigInt(USER_SETTINGS.gasLimitBuffer);
            }

            txResponse = await connectedSigner.sendTransaction(txRequest);
        }
        console.log(`✅ Transaction Sent! Hash: ${txResponse.hash}`);
    } catch (e) {
        console.error(`❌ Transaction Failed: ${e.message}`);
    }
}

async function swapToken() {
    console.log("\n🔄 Swap Token for Native Currency (e.g. JMPT -> BNB)");
    console.log("⚠️  Requires Native Currency (Gas) to execute transaction.\n");

    const wallets = await listWallets();
    if (wallets.length === 0) return;

    // 1. Select Wallet
    const wChoices = wallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.address }));
    wChoices.push({ name: '🔙 Back', value: 'BACK' });

    const walletChoice = await inquirer.prompt([{ type: 'rawlist', name: 'addr', message: 'Select Wallet:', choices: wChoices }]);
    if (walletChoice.addr === 'BACK') return;

    const selectedWalletData = DECRYPTED_WALLETS.find(w => w.wallet.address === walletChoice.addr);
    const signer = selectedWalletData.wallet;

    // 2. Select Network
    const network = await selectNetwork(true);
    if (network === 'BACK') return;
    const networkKey = Object.keys(NETWORKS).find(key => NETWORKS[key].rpc === network.rpc);

    if (!ROUTERS[networkKey]) {
        console.log("❌ Swap not supported on this network yet.");
        return;
    }

    const provider = new ethers.JsonRpcProvider(network.rpc);
    const connectedSigner = signer.connect(provider);

    // 3. Select Token
    const tokenOptions = [];
    if (PREDEFINED_TOKENS[networkKey]) {
        PREDEFINED_TOKENS[networkKey].forEach(t => tokenOptions.push({ name: t.symbol, value: t }));
    }
    // Add saved tokens
    if (USER_SETTINGS.savedTokens) {
        USER_SETTINGS.savedTokens.filter(t => t.network === networkKey).forEach(t => tokenOptions.push({ name: t.symbol, value: t }));
    }
    tokenOptions.push({ name: 'Custom Address', value: 'custom' });
    tokenOptions.push({ name: '🔙 Back', value: 'BACK' });

    const tokenChoice = await inquirer.prompt([{ type: 'rawlist', name: 'token', message: 'Select Token to Sell:', choices: tokenOptions }]);
    if (tokenChoice.token === 'BACK') return;

    let tokenData = tokenChoice.token;
    if (tokenChoice.token === 'custom') {
        const input = await inquirer.prompt([{ type: 'input', name: 'addr', message: 'Contract Address:' }]);
        try {
            const c = new ethers.Contract(input.addr, ERC20_ABI, provider);
            tokenData = { 
                address: input.addr, 
                symbol: await c.symbol(), 
                decimals: await c.decimals() 
            };
        } catch(e) { console.log("Invalid Token"); return; }
    }

    // 4. Amount
    const amt = await inquirer.prompt([{ type: 'input', name: 'val', message: `Amount of ${tokenData.symbol} to swap:` }]);
    const amountIn = ethers.parseUnits(amt.val, tokenData.decimals);

    // 5. Check Approval
    const routerAddress = ROUTERS[networkKey];
    console.log(`DEBUG: Token Address: ${tokenData.address}`);
    console.log(`DEBUG: Router Address: ${routerAddress}`);
    
    const tokenContract = new ethers.Contract(tokenData.address, ERC20_ABI, connectedSigner);
    
    console.log("⏳ Checking allowance...");
    const allowance = await tokenContract.allowance(signer.address, routerAddress);
    
    if (allowance < amountIn) {
        const approvePrompt = await inquirer.prompt([{ type: 'rawlist', name: 'ok', message: `Router needs approval to spend your ${tokenData.symbol}. Approve?`, choices: ['Yes', 'No'] }]);
        if (approvePrompt.ok === 'No') return;

        console.log("🚀 Approving (max)...");
        const txApprove = await tokenContract.approve(routerAddress, ethers.MaxUint256);
        console.log(`✅ Approved! Hash: ${txApprove.hash}`);
        console.log("⏳ Waiting for confirmation...");
        await txApprove.wait();
    }

    // 6. Execute Swap
    // Native wrapped address is needed for path.
    // WETH/WBNB addresses
    const WNATIVE = {
        "ethereum": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "bsc": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        "polygon": "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        "celo": "0x471EcE3750Da237f93b8E339c536989b8978a438"
    };

    if (!WNATIVE[networkKey]) {
        console.log("❌ WNative address missing for this chain.");
        return;
    }

    const path = [tokenData.address, WNATIVE[networkKey]];
    const routerContract = new ethers.Contract(routerAddress, ROUTER_ABI, connectedSigner);
    
    // Get Quote
    // try {
    //    const amounts = await routerContract.getAmountsOut(amountIn, path);
    //    const amountOutMin = amounts[1] * 95n / 100n; // 5% slippage tolerance (simple)
    // } catch ... (skip quote for speed/simplicity or use 0 min for now with caution)
    
    console.log("🚀 Swapping...");
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 mins
    
    try {
        // Use SupportingFeeOnTransferTokens to be safe with all tokens
        const txSwap = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
            amountIn,
            0, // accept any amount of ETH (risky but simple for CLI). Ideally use getAmountsOut
            path,
            selectedWalletData.address,
            deadline
        );
        console.log(`✅ Swap Sent! Hash: ${txSwap.hash}`);
    } catch (e) {
        console.log(`❌ Swap Failed: ${e.message}`);
    }
}

// --- WalletConnect Logic ---

async function connectWallet(predefinedUri = null) {
  const wallets = await listWallets();
  if (wallets.length === 0) return;

  const wChoices = wallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.address }));
  wChoices.push({ name: '🔙 Back', value: 'BACK' });

  const walletChoice = await inquirer.prompt([
    {
      type: 'rawlist',
      name: 'walletAddress',
      message: 'Select wallet to connect:',
      choices: wChoices
    }
  ]);

  if (walletChoice.walletAddress === 'BACK') return;

  const selectedWalletData = DECRYPTED_WALLETS.find(w => w.wallet.address === walletChoice.walletAddress);
  const signer = selectedWalletData.wallet;

  let uri = predefinedUri;
  if (!uri) {
      const uriAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'uri',
          message: 'Paste the WalletConnect URI (wc:...):',
          validate: (input) => input.startsWith('wc:') || 'Invalid URI, must start with wc:'
        }
      ]);
      uri = uriAnswer.uri;
  }

  console.log(`\n🔌 Initializing WalletConnect with ${selectedWalletData.name}...\n`);
  
  const SilentLogger = {
      fatal: () => {},
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
      child: () => SilentLogger 
  };

  const isVerbose = process.argv.includes('-v');
  const wcLogger = isVerbose ? "error" : SilentLogger;
  
  const client = await SignClient.init({
    projectId: PROJECT_ID,
    logger: wcLogger,
    metadata: {
      name: "Headless CLI Wallet",
      description: "My Local CLI Wallet",
      url: "https://cli-wallet.com",
      icons: ["https://avatars.githubusercontent.com/u/37784886"],
    },
  });

  // Wrap event listeners in a Promise to block main loop
  await new Promise(async (resolve) => {
      
      client.on("session_proposal", async (proposal) => {
        const { id, params } = proposal;
        const dAppName = params.proposer.metadata.name;
        console.log(`\n📥 Session Proposal from: ${dAppName}`);
        console.log(`   Required Chains: ${JSON.stringify(params.requiredNamespaces)}`);

        const confirm = await inquirer.prompt([
          {
            type: 'rawlist',
            name: 'approve',
            message: `Do you want to connect ${selectedWalletData.name} to ${dAppName}?`,
            choices: ['Yes', 'No']
          }
        ]);

        if (confirm.approve === 'No') {
            console.log("❌ Connection rejected.");
            // Don't resolve here, user might want to try another URI or wait? 
            // Actually, usually connection rejection ends the flow.
            // Let's resolve to go back to menu.
            resolve();
            return;
        }

        const namespaces = {};
        const required = params.requiredNamespaces || {};
        const optional = params.optionalNamespaces || {};
        const allNamespaces = { ...required, ...optional };

        Object.keys(allNamespaces).forEach((key) => {
          const chains = allNamespaces[key].chains || ["eip155:1"];
          const accounts = chains.map((chain) => `${chain}:${signer.address}`);
          namespaces[key] = {
            accounts,
            methods: allNamespaces[key].methods || [],
            events: allNamespaces[key].events || [],
          };
        });

        const { topic, acknowledged } = await client.approve({
          id,
          namespaces,
        });

        console.log(`✅ Connected! Session Topic: ${topic}`);
        await acknowledged();
        console.log("🔗 Session Acknowledged. Waiting for requests... (Press Ctrl+C to force quit if stuck)");
      });

      client.on("session_request", async (event) => {
        const { topic, params, id } = event;
        const { request } = params;
        
        console.log(`\n📩 New Request: ${request.method}`);

        const confirmSign = await inquirer.prompt([
            {
              type: 'rawlist',
              name: 'sign',
              message: `Approve ${request.method} request?`,
              choices: ['Yes', 'No']
            }
          ]);

        if (confirmSign.sign === 'No') {
            console.log("❌ Request rejected locally.");
            return;
        }

        try {
            let result;
            if (request.method === "personal_sign") {
                const message = request.params[0];
                const data = ethers.isHexString(message) ? ethers.getBytes(message) : message;
                const readable = ethers.isHexString(message) ? ethers.toUtf8String(message) : message;
                console.log(`📝 Signing: "${readable}"`);
                result = await signer.signMessage(data);
            } else if (request.method.startsWith("eth_signTypedData")) {
                 const [_, data] = request.params;
                 const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
                 result = await signer.signTypedData(parsedData.domain, parsedData.types, parsedData.message);
            } else if (request.method === "eth_sendTransaction") {
                const provider = new ethers.JsonRpcProvider(RPC_URL);
                const connectedWallet = signer.connect(provider);
                
                const txParams = request.params[0];
                console.log("💸 Processing Transaction:", txParams);
                
                const tx = {
                    to: txParams.to,
                    value: txParams.value,
                    data: txParams.data,
                    gasLimit: txParams.gas,
                };

                const confirmTx = await inquirer.prompt([
                    {
                        type: 'rawlist',
                        name: 'send',
                        message: `Send transaction to ${tx.to} with value ${tx.value}?`,
                        choices: ['Yes', 'No']
                    }
                ]);

                if (confirmTx.send === 'No') {
                    console.log("❌ Transaction cancelled.");
                    return; 
                }

                console.log("🚀 Sending transaction...");
                const txResponse = await connectedWallet.sendTransaction(tx);
                console.log(`✅ Sent! Hash: ${txResponse.hash}`);
                result = txResponse.hash;
            }

            if (result) {
                await client.respond({
                    topic,
                    response: { id, jsonrpc: "2.0", result },
                });
                console.log("📤 Signed & Sent!");
            }
        } catch (error) {
            console.error("❌ Error signing:", error.message);
        }
      });

      client.on("session_delete", () => {
          console.log("🔌 Disconnected by dApp.");
          resolve(); // Resolve promise to return to main menu
      });

      try {
          await client.pair({ uri: uri });
          console.log("⏳ Pairing request sent. Check the dApp...");
      } catch (e) {
          console.error("❌ Pairing Error:", e.message);
          resolve(); // Error pairing, go back
      }
  });
}

// --- Main Menu ---

async function main() {
  console.log("\n🚀 Multi-Wallet CLI Manager");
  await initializeWallets();
  
  // Check for direct WC URI in args
  const wcArg = process.argv.find(arg => arg.startsWith('wc:'));
  if (wcArg) {
      console.log("🔗 Direct Connection Mode detected.");
      await connectWallet(wcArg);
      process.exit(0);
  }
  
  while (true) {
    const answer = await inquirer.prompt([
      {
        type: 'rawlist',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          'Create New Wallet',
          'Import Wallet',
          'List Wallets',
          'Rename Wallet',
          'Delete Wallet',
          'Check Balance',
          'Transfer Assets (Tokens/Native)',
          'Swap Token -> Native',
          'Connect to dApp (WalletConnect)',
          'Settings',
          new inquirer.Separator(),
          'Exit'
        ]
      }
    ]);

    switch (answer.action) {
      case 'Create New Wallet':
        await createNewWallet();
        break;
      case 'Import Wallet':
        await importWallet();
        break;
      case 'List Wallets':
        const w = await listWallets();
        console.table(w.map(w => ({ Name: w.name, Address: w.address })));
        break;
      case 'Rename Wallet':
        await renameWallet();
        break;
      case 'Delete Wallet':
        await deleteWallet();
        break;
      case 'Check Balance':
        await checkBalance();
        break;
      case 'Transfer Assets (Tokens/Native)':
        await transferAsset();
        break;
      case 'Swap Token -> Native':
        await swapToken();
        break;
      case 'Connect to dApp (WalletConnect)':
        await connectWallet();
        break;
      case 'Settings':
        await changeSettings();
        break;
      case 'Exit':
        console.log("Bye! 👋");
        process.exit(0);
    }
    console.log(""); 
  }
}

main();