#!/usr/bin/env node
import fs from 'fs';
import inquirer from 'inquirer';
import { ethers } from 'ethers';
import { SignClient } from "@walletconnect/sign-client";
import os from 'os';
import path from 'path';
import { 
    setupDrive, 
    setupRclone, 
    triggerBackup, 
    checkCloudBackupAvailable, 
    restoreFromCloud, 
    getRcloneRemotes 
} from './drive.js';
import { 
    getAllChains, 
    getPopularChains, 
    getChain, 
    searchChains, 
    testRpcLatency, 
    getWorkingProvider,
    getProvider 
} from './chains.js';
import { 
    getTokensForChain, 
    getQuote, 
    executeQuote, 
    checkTransferStatus 
} from './swapBridge.js';
import { 
    scanPortfolio,
    COMMON_TOKENS_BY_CHAIN 
} from './portfolio.js';
import {
    NETWORKS as CORE_NETWORKS,
    getPublicWallets,
    getPrice as getPriceCore,
    getFiatRate
} from './core.js';

let PROJECT_ID = process.env.PROJECT_ID;
const CONFIG_DIR = path.join(os.homedir(), '.my-cli-wallet');
const ENV_FILE = path.join(CONFIG_DIR, '.env');

// Load .env manually if not loaded by dotenv (which looks in cwd)
if (fs.existsSync(ENV_FILE)) {
    const envConfig = fs.readFileSync(ENV_FILE, 'utf8');
    const match = envConfig.match(/PROJECT_ID=(.*)/);
    if (match) PROJECT_ID = match[1].trim();
}

async function checkProjectId() {
    if (PROJECT_ID) return;
    
    console.log("⚠️  WalletConnect Project ID not found.");
    const answer = await inquirer.prompt([{
        type: 'input',
        name: 'id',
        message: 'Enter your Project ID (from cloud.walletconnect.com):'
    }]);
    
    PROJECT_ID = answer.id.trim();
    fs.writeFileSync(ENV_FILE, `PROJECT_ID=${PROJECT_ID}\n`);
    console.log(`✅ Project ID saved to ${ENV_FILE}`);
}

// Ensure Config Dir Exists
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);

const WALLETS_FILE = path.join(CONFIG_DIR, 'my_wallets.json');
const TRASH_FILE = path.join(CONFIG_DIR, 'trash_wallets.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const RPC_URL = "https://eth.llamarpc.com";

// ... (Rest of imports and state) ...

// Helper to ensure wallets are unlocked before actions
async function ensureWalletsUnlocked() {
    if (DECRYPTED_WALLETS.length > 0) return; // Already unlocked
    await initializeWallets();
}

// ... (Existing functions: deleteWallet, restoreWallet, etc.) ...

// --- WalletConnect Logic ---

async function connectWallet(predefinedUri = null) {
  await ensureWalletsUnlocked(); 
  await checkProjectId(); 

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
          resolve(); 
      });

      try {
          await client.pair({ uri: uri });
          console.log("⏳ Pairing request sent. Check the dApp...");
      } catch (e) {
          console.error("❌ Pairing Error:", e.message);
          resolve(); 
      }
  });
}

async function showPrivateKey() {
    if (DECRYPTED_WALLETS.length === 0) {
        console.log("❌ No wallets unlocked.");
        return;
    }

    const wChoices = DECRYPTED_WALLETS.map(w => ({ name: `${w.name} (${w.wallet.address})`, value: w.wallet.address }));
    wChoices.push({ name: '🔙 Back', value: 'BACK' });

    const choice = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'addr',
            message: 'Select Wallet to REVEAL Private Key:',
            choices: wChoices
        }
    ]);

    if (choice.addr === 'BACK') return;

    const target = DECRYPTED_WALLETS.find(w => w.wallet.address === choice.addr);
    if (!target) {
        console.log("❌ Error: Wallet not found in session.");
        return;
    }
    
    // Double confirmation
    const confirm = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'sure',
            message: `⚠️  REVEAL Private Key for '${target.name}'?`,
            choices: ['No', 'Yes, Reveal']
        }
    ]);

    if (confirm.sure !== 'Yes, Reveal') return;

    // Print headers
    console.log("\n" + "=".repeat(42));
    console.log(`🔑 PRIVATE KEY REVEALED`);
    console.log(`Wallet: ${target.name}`);
    console.log(`Address: ${target.wallet.address}`);
    console.log("-".repeat(42));
    console.log(target.wallet.privateKey);
    console.log("=".repeat(42));
    console.log("\n⏳ THIS KEY WILL BE HIDDEN IN 5 SECONDS...");

    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Clear lines
    const linesToClear = 10;
    for (let i = 0; i < linesToClear; i++) {
        process.stdout.moveCursor(0, -1);
        process.stdout.clearLine(0);
    }
    
    console.log("🔒 Private Key has been cleared from screen.   ");
}

async function deleteWallet() {
    if (DECRYPTED_WALLETS.length === 0) {
        console.log("❌ No wallets unlocked.");
        return;
    }

    const wChoices = DECRYPTED_WALLETS.map(w => ({ name: `${w.name} (${w.wallet.address})`, value: w.wallet.address }));
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
    encryptionDisabled: false,
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

// Supported Networks (260+ EVM Chains)
const NETWORKS = CORE_NETWORKS;

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
        const networkKey = Object.keys(NETWORKS).find(key => NETWORKS[key].rpc === network.rpc);
        
        // 2. Choose Method
        const method = await inquirer.prompt([
            { type: 'rawlist', name: 'mode', message: 'How to find token?', choices: ['Search by Name (CoinGecko)', 'Enter Contract Address'] }
        ]);

        let address = null;
        let coingeckoId = null;

        if (method.mode.startsWith('Enter')) {
            const input = await inquirer.prompt([{ type: 'input', name: 'addr', message: 'Token Contract Address:' }]);
            address = input.addr.trim();
        } else {
            // Search Logic
            const query = await inquirer.prompt([{ type: 'input', name: 'q', message: 'Enter Token Name (e.g. Pepe):' }]);
            console.log("🔍 Searching CoinGecko...");
            
            try {
                const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${query.q}`);
                const data = await res.json();
                
                if (!data.coins || data.coins.length === 0) {
                    console.log("❌ No coins found.");
                    return;
                }

                const choices = data.coins.slice(0, 10).map(c => ({
                    name: `${c.name} (${c.symbol}) - Rank #${c.market_cap_rank || 'N/A'}`,
                    value: c.id
                }));

                const coinChoice = await inquirer.prompt([
                    { type: 'rawlist', name: 'id', message: 'Select Coin:', choices: choices }
                ]);

                console.log("⏳ Fetching contract details...");
                const detailRes = await fetch(`https://api.coingecko.com/api/v3/coins/${coinChoice.id}`);
                const detail = await detailRes.json();

                // Map our network keys to CoinGecko platform keys
                const platformMap = {
                    'ethereum': 'ethereum',
                    'bsc': 'binance-smart-chain',
                    'polygon': 'polygon-pos',
                    'celo': 'celo'
                };

                const platformKey = platformMap[networkKey];
                address = detail.platforms[platformKey];
                coingeckoId = detail.id;

                console.log("DEBUG: Platforms in response:", Object.keys(detail.platforms));

                if (!address) {
                    console.log(`❌ This token does not have a contract on ${NETWORKS[networkKey].name}.`);
                    console.log(`   Available on: ${Object.keys(detail.platforms).join(', ')}`);
                    return;
                }
                console.log(`✅ Found Address: ${address}`);

            } catch (e) {
                console.log(`❌ Search failed: ${e.message}`);
                return;
            }
        }

        // 3. Fetch Details & Save
        try {
            console.log("⏳ Verifying on-chain...");
            const provider = new ethers.JsonRpcProvider(network.rpc);
            const contract = new ethers.Contract(address, ERC20_ABI, provider);
            const symbol = await contract.symbol();
            const decimals = await contract.decimals();

            console.log(`✅ Verified ${symbol} (Decimals: ${decimals})`);
            
            const confirm = await inquirer.prompt([{ type: 'confirm', name: 'save', message: 'Save this token?', default: true }]);
            if (confirm.save) {
                USER_SETTINGS.savedTokens.push({ 
                    symbol, 
                    address, 
                    network: networkKey, 
                    decimals: Number(decimals),
                    coingeckoId: coingeckoId // Store ID for price data!
                });
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
                'Restore Vault from Cloud Backup (Google Drive / Rclone)',
                'Restore Deleted Wallet',
                'Toggle Vault Encryption',
                'Back'
            ]
        }
    ]);

    if (action.setting === 'Back') return;

    if (action.setting === 'Restore Vault from Cloud Backup (Google Drive / Rclone)') {
        await handleCloudRestoreInteractive();
        return;
    }
    
    if (action.setting === 'Toggle Vault Encryption') {
        await toggleEncryption();
        return;
    }
    
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

async function toggleEncryption() {
    if (DECRYPTED_WALLETS.length === 0) {
        console.log("No wallets loaded to convert.");
        return;
    }

    const isCurrentlyEncrypted = SESSION_PASSWORD !== null;
    
    if (isCurrentlyEncrypted) {
        // Encrypted -> Plain
        console.log("⚠️  WARNING: You are about to decrypt your wallet vault.");
        console.log("   Your private keys will be stored in PLAIN TEXT in my_wallets.json.");
        console.log("   Anyone with access to this file can steal your funds.");
        
        const confirm = await inquirer.prompt([
            { type: 'rawlist', name: 'sure', message: 'Are you absolutely sure?', choices: ['No', 'Yes, I understand the risk'] }
        ]);
        
        if (confirm.sure !== 'Yes, I understand the risk') return;

        const confirm2 = await inquirer.prompt([
            { type: 'rawlist', name: 'sure', message: 'Confirm again:', choices: ['No', 'Decrypt Wallet'] }
        ]);

        if (confirm2.sure !== 'Decrypt Wallet') return;

        // Save as plain
        const plainStore = DECRYPTED_WALLETS.map(w => ({
            name: w.name,
            privateKey: w.wallet.privateKey
        }));
        
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(plainStore, null, 2));
        SESSION_PASSWORD = null; // Clear password
        console.log("🔓 Wallets decrypted and saved.");
        
    } else {
        // Plain -> Encrypted
        console.log("🔐 Encrypting wallet vault...");
        const password = await getPassword(true); // Ask for new password
        
        const encryptedStore = [];
        for (const w of DECRYPTED_WALLETS) {
            console.log(`Encrypting ${w.name}...`);
            const encryptedJson = await w.wallet.encrypt(password);
            encryptedStore.push({ name: w.name, data: encryptedJson });
        }
        
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(encryptedStore, null, 2));
        console.log("✅ Wallets encrypted and saved.");
    }
    await triggerBackup(USER_SETTINGS);
}

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
    let rawWallets = loadWalletsRaw();
    if (rawWallets.length === 0) {
        try {
            const cloud = await checkCloudBackupAvailable(USER_SETTINGS);
            if (cloud.available) {
                console.log(`\n☁️  Cloud backup detected on ${cloud.method === 'rclone' ? `Rclone ('${cloud.remote}')` : 'Google Drive'}!`);
                const answer = await inquirer.prompt([{
                    type: 'confirm',
                    name: 'restore',
                    message: 'No local wallets found. Would you like to restore your vault from cloud backup?',
                    default: true
                }]);
                if (answer.restore) {
                    const res = await restoreFromCloud(USER_SETTINGS, { remote: cloud.remote, method: cloud.method });
                    if (res.success) {
                        console.log(`✅ Restored ${res.count} wallet(s) from cloud backup: ${(res.wallets || []).join(', ')}`);
                        loadPublicWallets();
                        rawWallets = loadWalletsRaw();
                    } else {
                        console.log(`⚠️  Cloud restore failed: ${res.error}`);
                    }
                }
            }
        } catch (e) {}
    }
    if (rawWallets.length === 0) return;

    // Check if wallets are unencrypted (contain 'privateKey')
    if (rawWallets[0].privateKey) {
        if (!USER_SETTINGS.encryptionDisabled) {
            console.log("⚠️  Unencrypted wallets detected!");
            const choice = await inquirer.prompt([{
                type: 'rawlist',
                name: 'action',
                message: 'How would you like to proceed?',
                choices: ['Encrypt wallets now (Recommended)', 'Keep unencrypted (RISKY)']
            }]);

            if (choice.action.startsWith('Encrypt')) {
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
                // Confirm risk
                console.log("\n🛑 RISK WARNING: Your private keys are stored in PLAIN TEXT.");
                console.log("   Anyone with access to your device can see them.");
                
                const confirm1 = await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'Are you sure you want to stay unencrypted?', default: false }]);
                if (!confirm1.ok) return initializeWallets(); // Try again

                const confirm2 = await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'LAST CHANCE: Stay unencrypted?', default: false }]);
                if (!confirm2.ok) return initializeWallets();

                USER_SETTINGS.encryptionDisabled = true;
                saveSettings();
                
                DECRYPTED_WALLETS = rawWallets.map(w => ({ name: w.name, wallet: new ethers.Wallet(w.privateKey) }));
                console.log("🔓 Unlocked unencrypted wallets.");
            }
        } else {
            DECRYPTED_WALLETS = rawWallets.map(w => ({ name: w.name, wallet: new ethers.Wallet(w.privateKey) }));
            // console.log("🔓 Unlocked unencrypted wallets.");
        }
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
    const rawWallets = loadWalletsRaw();
    
    if (USER_SETTINGS.encryptionDisabled) {
        rawWallets.push({ name: name, privateKey: wallet.privateKey });
    } else {
        const password = await getPassword();
        console.log("⏳ Encrypting wallet...");
        const encryptedJson = await wallet.encrypt(password);
        rawWallets.push({ name: name, data: encryptedJson });
    }
    
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(rawWallets, null, 2));
    
    // Update memory
    DECRYPTED_WALLETS.push({ name: name, wallet: wallet });
    console.log(`✅ Wallet '${name}' saved.`);
    await triggerBackup(USER_SETTINGS);
}

async function ensureEncryptionPreference() {
    if (DECRYPTED_WALLETS.length > 0 || fs.existsSync(WALLETS_FILE)) return;

    console.log("\n🛡️  Vault Setup");
    const choice = await inquirer.prompt([{
        type: 'rawlist',
        name: 'action',
        message: 'Do you want to encrypt your wallet vault with a password?',
        choices: ['Yes, encrypt (Recommended)', 'No, store in plain text (RISKY)']
    }]);

    if (choice.action.startsWith('Yes')) {
        await getPassword(true);
        USER_SETTINGS.encryptionDisabled = false;
    } else {
        console.log("\n🛑 RISK WARNING: Your private keys will be stored in PLAIN TEXT.");
        const confirm1 = await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'Are you sure?', default: false }]);
        const confirm2 = await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'REALLY SURE? This is unsafe.', default: false }]);
        
        if (confirm1.ok && confirm2.ok) {
            USER_SETTINGS.encryptionDisabled = true;
        } else {
            return ensureEncryptionPreference(); // Back to start
        }
    }
    saveSettings();
}

async function createNewWallet() {
  await ensureEncryptionPreference();
  console.log("Creating new wallet locally on device...");
  const wallet = ethers.Wallet.createRandom();
  const nameAnswer = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'Give this wallet a name (e.g. "Main", "Burner"):',
      default: `Wallet ${DECRYPTED_WALLETS.length + 1}`
    }
  ]);
  
  await saveEncryptedWallet(nameAnswer.name, wallet);
  console.log(`🔑 Address: ${wallet.address}`);
}

async function handleCloudRestoreInteractive() {
    console.log("\n☁️  Cloud Vault Restore (Google Drive / Rclone)");
    const status = await checkCloudBackupAvailable(USER_SETTINGS);
    
    let method = USER_SETTINGS.backupMethod || 'rclone';
    let remote = USER_SETTINGS.rcloneRemote;

    if (status.available) {
        method = status.method;
        if (status.remote) remote = status.remote;
        console.log(`✅ Cloud backup detected on ${method === 'rclone' ? `Rclone remote '${remote}'` : 'Google Drive Native API'}.`);
    } else {
        const choice = await inquirer.prompt([{
            type: 'rawlist',
            name: 'm',
            message: 'No automatic backup detected. How would you like to restore?',
            choices: ['Rclone Remote', 'Google Drive Native API', 'Cancel']
        }]);
        if (choice.m === 'Cancel') return;
        if (choice.m.startsWith('Rclone')) {
            method = 'rclone';
            const remotes = await getRcloneRemotes();
            if (remotes.length === 0) {
                console.log("❌ No Rclone remotes configured. Run 'rclone config' in terminal.");
                return;
            }
            const rAnswer = await inquirer.prompt([{
                type: 'rawlist',
                name: 'r',
                message: 'Select Rclone remote to restore from:',
                choices: remotes
            }]);
            remote = rAnswer.r;
        } else {
            method = 'gapi';
        }
    }

    const currentWallets = loadWalletsRaw();
    let merge = false;
    if (currentWallets.length > 0) {
        const strategy = await inquirer.prompt([{
            type: 'rawlist',
            name: 'mode',
            message: `You currently have ${currentWallets.length} local wallet(s). How would you like to restore?`,
            choices: [
                'Merge (Add any missing wallets from cloud, preserve local wallets)',
                'Replace (Overwrite local vault completely with cloud backup)',
                'Cancel'
            ]
        }]);
        if (strategy.mode === 'Cancel') return;
        merge = strategy.mode.startsWith('Merge');
    }

    console.log(`\n⏳ Restoring vault from cloud (${method === 'rclone' ? remote : 'Google Drive'})...`);
    const res = await restoreFromCloud(USER_SETTINGS, { method, remote, merge, restoreSettings: true });
    if (res.success) {
        console.log(`✅ Restore successful! Vault now contains ${res.count} wallet(s):`);
        if (res.wallets) {
            res.wallets.forEach(name => console.log(`   🔑 ${name}`));
        }
        loadPublicWallets();
        DECRYPTED_WALLETS = [];
        SESSION_PASSWORD = null;
        console.log("💡 Wallets are ready in your local vault.\n");
    } else {
        console.log(`❌ Restore failed: ${res.error}\n`);
    }
}

async function importWallet() {
    await ensureEncryptionPreference();
    console.log("Importing wallet...");

    const method = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'type',
            message: 'Import method:',
            choices: [
                { name: 'Private Key', value: 'pk' },
                { name: 'Mnemonic Phrase (12/24 words)', value: 'mnemonic' },
                { name: '☁️  Restore from Cloud Backup (Google Drive / Rclone)', value: 'cloud' }
            ]
        }
    ]);

    if (method.type === 'cloud') {
        await handleCloudRestoreInteractive();
        return;
    }

    // Ensure we have a password set/active before importing (if not disabled)
    if (!USER_SETTINGS.encryptionDisabled) {
        await getPassword();
    }

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
  if (DECRYPTED_WALLETS.length > 0) {
    return DECRYPTED_WALLETS.map(w => ({ name: w.name, address: w.address || w.wallet.address }));
  }
  const publicList = getPublicWallets();
  if (publicList.length === 0) {
    console.log("No wallets found. Create one first!");
    return [];
  }
  return publicList.map(w => ({ name: w.name, address: w.address }));
}

// --- Blockchain Actions ---

async function selectNetwork(includeBack = false) {
  const popular = getPopularChains();
  const choices = popular.map(c => ({ 
      name: `${c.name} (${c.currency} - ID ${c.chainId})`, 
      value: c 
  }));
  
  choices.push(new inquirer.Separator('--- Chain Directory (260+ Chains) ---'));
  choices.push({ name: '🔍 Search All 260+ EVM Chains', value: 'SEARCH' });
  choices.push({ name: '📋 Browse All Chains', value: 'ALL' });
  
  if (includeBack) {
      choices.push({ name: '🔙 Back', value: 'BACK' });
  }

  const answer = await inquirer.prompt([
      {
          type: 'rawlist',
          name: 'selected',
          message: 'Select Network:',
          choices: choices
      }
  ]);
  
  if (answer.selected === 'BACK') return 'BACK';
  
  if (answer.selected === 'SEARCH') {
      const qInput = await inquirer.prompt([{
          type: 'input',
          name: 'q',
          message: 'Enter Chain Name, Symbol, or Chain ID (e.g. Base, Arbitrum, 8453):'
      }]);
      const matches = searchChains(qInput.q);
      if (matches.length === 0) {
          console.log("❌ No matching chains found.");
          return await selectNetwork(includeBack);
      }
      const matchChoices = matches.slice(0, 30).map(c => ({
          name: `${c.name} (${c.currency} - ID ${c.chainId})`,
          value: c
      }));
      matchChoices.push({ name: '🔙 Back', value: 'BACK' });
      const sub = await inquirer.prompt([{
          type: 'rawlist',
          name: 'c',
          message: `Select matching chain (${matches.length} found):`,
          choices: matchChoices
      }]);
      if (sub.c === 'BACK') return await selectNetwork(includeBack);
      return sub.c;
  }
  
  if (answer.selected === 'ALL') {
      const all = getAllChains();
      const allChoices = all.slice(0, 50).map(c => ({
          name: `${c.name} (${c.currency} - ID ${c.chainId})`,
          value: c
      }));
      allChoices.push({ name: '🔙 Back', value: 'BACK' });
      const sub = await inquirer.prompt([{
          type: 'rawlist',
          name: 'c',
          message: 'Select Chain (Top 50 shown, or use Search):',
          choices: allChoices
      }]);
      if (sub.c === 'BACK') return await selectNetwork(includeBack);
      return sub.c;
  }

  return answer.selected;
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

  let provider;
  try {
      provider = await getWorkingProvider(network.chainId);
  } catch (e) {
      provider = getProvider(network.chainId);
  }

  console.log(`\n⏳ Fetching balances on ${network.name} (Chain ID: ${network.chainId})...`);
  
  // 1. Native balance & live price
  let nativeBalance = 0;
  try {
      const nativeBalanceWei = await provider.getBalance(selectedWalletData.address);
      nativeBalance = parseFloat(ethers.formatEther(nativeBalanceWei));
  } catch (e) {
      console.log(`⚠️  Could not fetch native balance: ${e.message}`);
  }

  let nativeValue = "0.00";
  try {
      const nativePrice = await getPriceCore(network.currency, USER_SETTINGS.currency);
      nativeValue = (nativeBalance * nativePrice).toFixed(2);
  } catch (e) {}
  
  console.log(`\n💰 Native: ${nativeBalance} ${network.currency} (≈ ${nativeValue} ${USER_SETTINGS.currency})`);

  // 2. Discover & check all tokens on this chain dynamically (zero hardcoding)
  const chainId = Number(network.chainId);
  const candidateTokens = [];
  const seenAddresses = new Set();

  const addToken = (t) => {
      if (!t || !t.address) return;
      try {
          const raw = t.address.toLowerCase();
          if (raw === '0x0000000000000000000000000000000000000000') return;
          const checkAddr = ethers.getAddress(raw);
          if (!seenAddresses.has(raw)) {
              seenAddresses.add(raw);
              candidateTokens.push({
                  address: checkAddr,
                  symbol: t.symbol || 'TOKEN',
                  decimals: t.decimals != null ? Number(t.decimals) : 18,
                  name: t.name || t.symbol || 'Token',
                  coingeckoId: t.coingeckoId || null,
                  priceUSD: t.priceUSD != null ? parseFloat(t.priceUSD) : null
              });
          }
      } catch (e) {}
  };

  process.stdout.write(`📡 Auto-discovering verified tokens for ${network.name}... `);
  try {
      const dynamicTokens = await getTokensForChain(chainId);
      if (Array.isArray(dynamicTokens)) {
          dynamicTokens.forEach(addToken);
      }
      process.stdout.write(`(${candidateTokens.length} tokens found)\n`);
  } catch (e) {
      process.stdout.write(`(using local token catalog)\n`);
  }

  // Add curated common tokens for this chain (fallback / supplement)
  if (COMMON_TOKENS_BY_CHAIN[chainId]) {
      COMMON_TOKENS_BY_CHAIN[chainId].forEach(addToken);
  }

  // Add legacy predefined tokens
  if (network.key && PREDEFINED_TOKENS[network.key]) {
      PREDEFINED_TOKENS[network.key].forEach(addToken);
  }

  // Add user saved custom tokens for this network
  if (USER_SETTINGS.savedTokens) {
      USER_SETTINGS.savedTokens
          .filter(t => t.network === network.key || t.network === String(chainId) || t.chainId === chainId)
          .forEach(addToken);
  }

  if (candidateTokens.length > 0) {
      console.log(`🔎 Checking ${candidateTokens.length} tokens on ${network.name} via Multicall3...`);
      
      const foundTokens = [];
      const multicall3Addr = network.multicall3 || "0xca11bde05977b3631167028862be2a173976ca11";
      let usedMulticall = false;

      try {
          const mc3Abi = ["function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"];
          const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
          const mc3 = new ethers.Contract(multicall3Addr, mc3Abi, provider);

          const CHUNK_SIZE = 250;
          const chunks = [];
          for (let i = 0; i < candidateTokens.length; i += CHUNK_SIZE) {
              chunks.push(candidateTokens.slice(i, i + CHUNK_SIZE));
          }

          await Promise.all(chunks.map(async (chunk) => {
              const calls = chunk.map(t => ({
                  target: t.address,
                  allowFailure: true,
                  callData: erc20.encodeFunctionData("balanceOf", [selectedWalletData.address])
              }));

              try {
                  const results = await Promise.race([
                      mc3.aggregate3(calls),
                      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
                  ]);

                  results.forEach((r, idx) => {
                      if (r.success && r.returnData && r.returnData !== '0x') {
                          const balWei = BigInt(r.returnData);
                          if (balWei > 0n) {
                              const token = chunk[idx];
                              const formatted = ethers.formatUnits(balWei, token.decimals);
                              if (parseFloat(formatted) > 0.000001) {
                                  foundTokens.push({ ...token, balance: formatted, balanceRaw: balWei.toString() });
                              }
                          }
                      }
                  });
              } catch (err) {}
          }));
          usedMulticall = true;
      } catch (e) {}

      if (!usedMulticall || (foundTokens.length === 0 && candidateTokens.length > 0 && !usedMulticall)) {
          // Parallel fallback for top tokens
          const fallbackTokens = candidateTokens.slice(0, 30);
          for (let i = 0; i < fallbackTokens.length; i += 5) {
              const batch = fallbackTokens.slice(i, i + 5);
              await Promise.all(batch.map(async (token) => {
                  try {
                      const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
                      const balWei = await contract.balanceOf(selectedWalletData.address);
                      if (balWei > 0n) {
                          const formatted = ethers.formatUnits(balWei, token.decimals);
                          if (parseFloat(formatted) > 0.000001) {
                              foundTokens.push({ ...token, balance: formatted });
                          }
                      }
                  } catch (err) {}
              }));
          }
      }

      if (foundTokens.length > 0) {
          // Calculate fiat values
          let fiatRate = 1;
          try {
              fiatRate = await getFiatRate(USER_SETTINGS.currency);
          } catch (e) {}

          for (const t of foundTokens) {
              if (t.priceUSD) {
                  t.fiatPrice = t.priceUSD * fiatRate;
                  t.fiatValue = parseFloat(t.balance) * t.fiatPrice;
              }
          }
          foundTokens.sort((a, b) => (b.fiatValue || 0) - (a.fiatValue || 0));

          console.log(`\n💎 Tokens with Balance (${foundTokens.length} found):`);
          for (const token of foundTokens) {
              let valStr = "";
              try {
                  let p = token.fiatPrice || 0;
                  if (!p) {
                      p = await getPriceCore(token.coingeckoId || token.symbol, USER_SETTINGS.currency);
                  }
                  if (p > 0) {
                      const val = (parseFloat(token.balance) * p).toFixed(2);
                      valStr = ` (≈ ${val} ${USER_SETTINGS.currency})`;
                  }
              } catch (e) {}
              console.log(`   ✨ ${token.balance} ${token.symbol}${valStr} [${token.name}] (${token.address})`);
          }
      } else {
          console.log(`\n💎 Tokens: No ERC-20 tokens with a positive balance found on ${network.name}.`);
          console.log(`   (Scanned ${candidateTokens.length} verified tokens dynamically across ${network.name})`);
      }
  }
}

async function checkPortfolio() {
    const wallets = await listWallets();
    if (wallets.length === 0) return;

    const wChoices = wallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.address }));
    wChoices.push({ name: '🌐 Scan ALL Wallets in Vault', value: 'ALL' });
    wChoices.push({ name: '🔙 Back', value: 'BACK' });

    const walletChoice = await inquirer.prompt([{
        type: 'rawlist',
        name: 'addr',
        message: 'Select Wallet to scan for portfolio:',
        choices: wChoices
    }]);

    if (walletChoice.addr === 'BACK') return;

    const scanMode = await inquirer.prompt([{
        type: 'rawlist',
        name: 'type',
        message: 'Select Scan Depth:',
        choices: [
            '⚡ Lightning Fast Scan (Active Holdings & Major Chains - ~3s - Recommended)',
            '🔬 Deep Full Scan (All 260+ EVM Chains Network Sweep - ~12s)',
            '🔙 Back'
        ]
    }]);

    if (scanMode.type.startsWith('🔙')) return;
    const isDeep = scanMode.type.includes('Deep Full Scan');

    const walletsToScan = walletChoice.addr === 'ALL' 
        ? wallets 
        : wallets.filter(w => w.address === walletChoice.addr);

    console.log(`\n📊 Scanning Multi-Chain Portfolio (Auto-detecting all tokens held)...`);

    let grandNetWorth = 0;
    const allReports = [];

    for (const w of walletsToScan) {
        console.log(`\n🔍 Scanning wallet: ${w.name} (${w.address})`);
        
        const scanRes = await scanPortfolio(w.address, {
            deep: isDeep,
            savedTokens: USER_SETTINGS.savedTokens || [],
            onProgress: (p) => {
                process.stdout.write(`\r   Scanning: ${p.scanned}/${p.total} (${p.currentChain}) - Found ${p.foundCount} assets... `);
            }
        });
        console.log(`\r   ✅ Scan complete! Found ${scanRes.totalAssets} assets across ${scanRes.activeChainsCount} chains.            \n`);

        grandNetWorth += parseFloat(scanRes.grandTotalUSD);
        allReports.push({ wallet: w, result: scanRes });

        if (scanRes.chainSummaries.length > 0) {
            console.log(`--- Active Chains for ${w.name} ---`);
            console.table(scanRes.chainSummaries.map(c => ({
                Chain: c.chainName,
                'Tokens Held': c.assetCount,
                'Total Value': `$${c.totalUSDFormatted} USD`,
                'Portfolio Share': c.pctOfTotal
            })));
        }

        if (scanRes.assets.length > 0) {
            console.log(`--- Auto-Detected Tokens & Balances for ${w.name} ---`);
            console.table(scanRes.assets.slice(0, 30).map(a => ({
                Asset: a.symbol,
                Network: a.chainName,
                Balance: parseFloat(a.balance).toFixed(4),
                'Price (USD)': a.priceUSD ? `$${a.priceUSD.toFixed(2)}` : '$0.00',
                'Value (USD)': `$${a.valueFormatted}`
            })));
        }
    }

    console.log("\n" + "=".repeat(50));
    console.log(`💰 GRAND TOTAL NET WORTH: $${grandNetWorth.toFixed(2)} USD`);
    console.log("=".repeat(50));
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
    
    let provider;
    try {
        provider = await getWorkingProvider(network.chainId);
    } catch (e) {
        provider = getProvider(network.chainId);
    }

    process.stdout.write(`\n⏳ Scanning available assets in wallet on ${network.name}... `);

    // A. Native balance
    let nativeBal = 0;
    try {
        const balWei = await provider.getBalance(signer.address);
        nativeBal = parseFloat(ethers.formatEther(balWei));
    } catch (e) {}

    // B. Discover all tokens on this chain dynamically (zero hardcoding)
    const chainId = Number(network.chainId);
    const candidateTokens = [];
    const seenAddrs = new Set();

    const addToken = (t) => {
        if (!t || !t.address) return;
        try {
            const raw = t.address.toLowerCase();
            if (raw === '0x0000000000000000000000000000000000000000') return;
            const checkAddr = ethers.getAddress(raw);
            if (!seenAddrs.has(raw)) {
                seenAddrs.add(raw);
                candidateTokens.push({
                    address: checkAddr,
                    symbol: t.symbol || 'TOKEN',
                    name: t.name || t.symbol || 'Token',
                    decimals: t.decimals != null ? Number(t.decimals) : 18,
                    priceUSD: t.priceUSD != null ? parseFloat(t.priceUSD) : null
                });
            }
        } catch (e) {}
    };

    let allChainTokens = [];
    try {
        allChainTokens = await getTokensForChain(chainId);
        if (Array.isArray(allChainTokens)) allChainTokens.forEach(addToken);
    } catch (e) {}

    if (COMMON_TOKENS_BY_CHAIN[chainId]) COMMON_TOKENS_BY_CHAIN[chainId].forEach(addToken);
    if (USER_SETTINGS.savedTokens) {
        USER_SETTINGS.savedTokens.filter(t => t.chainId === chainId || t.network === String(chainId)).forEach(addToken);
    }

    // C. Multicall3 query for sender wallet balance
    const heldTokens = [];
    const multicall3Addr = network.multicall3 || "0xca11bde05977b3631167028862be2a173976ca11";
    try {
        const mc3Abi = ["function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"];
        const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
        const mc3 = new ethers.Contract(multicall3Addr, mc3Abi, provider);

        const CHUNK_SIZE = 250;
        const chunks = [];
        for (let i = 0; i < candidateTokens.length; i += CHUNK_SIZE) {
            chunks.push(candidateTokens.slice(i, i + CHUNK_SIZE));
        }

        await Promise.all(chunks.map(async (chunk) => {
            const calls = chunk.map(t => ({
                target: t.address,
                allowFailure: true,
                callData: erc20.encodeFunctionData("balanceOf", [signer.address])
            }));
            try {
                const res = await Promise.race([
                    mc3.aggregate3(calls),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 7000))
                ]);
                res.forEach((r, idx) => {
                    if (r.success && r.returnData && r.returnData !== '0x') {
                        const balWei = BigInt(r.returnData);
                        if (balWei > 0n) {
                            const token = chunk[idx];
                            const formatted = ethers.formatUnits(balWei, token.decimals);
                            if (parseFloat(formatted) > 0.000001) {
                                heldTokens.push({ ...token, balance: formatted, balanceRaw: balWei.toString() });
                            }
                        }
                    }
                });
            } catch (e) {}
        }));
    } catch (e) {}

    process.stdout.write(`Done!\n`);

    // 3. Select Asset
    const assetOptions = [];

    // Native option
    assetOptions.push({
        name: `💰 Native ${network.currency} (Balance: ${nativeBal} ${network.currency})`,
        value: { type: 'native', symbol: network.currency, decimals: 18, balance: nativeBal.toString() }
    });

    // All auto-detected held tokens
    if (heldTokens.length > 0) {
        for (const tok of heldTokens) {
            assetOptions.push({
                name: `💎 ${tok.symbol} (Balance: ${tok.balance}) - ${tok.name} [${tok.address.slice(0, 8)}...]`,
                value: { type: 'token', ...tok }
            });
        }
    }

    // Search verified catalog
    if (candidateTokens.length > 0) {
        assetOptions.push({
            name: `🔍 Search Other Verified Tokens on ${network.name} (${candidateTokens.length} available)`,
            value: { type: 'search' }
        });
    }

    assetOptions.push({ name: '✏️  Enter Custom Token Contract Address', value: { type: 'custom' } });
    assetOptions.push({ name: '🔙 Back', value: { type: 'BACK' } });

    const assetChoice = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'selected',
            message: 'Select Asset to Send:',
            choices: assetOptions
        }
    ]);

    let selectedAsset = assetChoice.selected;
    if (selectedAsset.type === 'BACK') return;

    if (selectedAsset.type === 'search') {
        const searchPrompt = await inquirer.prompt([{
            type: 'input',
            name: 'q',
            message: 'Search token by Symbol or Name (e.g. USDC, DAI, PUSD):'
        }]);
        const q = searchPrompt.q.trim().toLowerCase();
        const matches = candidateTokens.filter(t => 
            t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
        ).slice(0, 25);

        if (matches.length === 0) {
            console.log(`❌ No tokens found matching "${searchPrompt.q}".`);
            return;
        }

        const pickSearch = await inquirer.prompt([{
            type: 'rawlist',
            name: 'tok',
            message: `Matching Tokens (${matches.length} found):`,
            choices: [
                ...matches.map(m => ({ name: `${m.symbol} - ${m.name} (${m.address.slice(0, 10)}...)`, value: m })),
                { name: '🔙 Cancel', value: 'BACK' }
            ]
        }]);
        if (pickSearch.tok === 'BACK') return;
        selectedAsset = { type: 'token', ...pickSearch.tok };
        
        try {
            const c = new ethers.Contract(selectedAsset.address, ERC20_ABI, provider);
            const b = await c.balanceOf(signer.address);
            selectedAsset.balance = ethers.formatUnits(b, selectedAsset.decimals);
        } catch (e) {
            selectedAsset.balance = '0.0';
        }
    } else if (selectedAsset.type === 'custom') {
        const addrInput = await inquirer.prompt([{
            type: 'input',
            name: 'addr',
            message: 'Enter Token Contract Address:',
            validate: (val) => ethers.isAddress(val.trim()) ? true : "Invalid address"
        }]);
        const cAddr = ethers.getAddress(addrInput.addr.trim());
        try {
            const c = new ethers.Contract(cAddr, ERC20_ABI, provider);
            const [sym, dec, balWei] = await Promise.all([
                c.symbol().catch(() => 'TOKEN'),
                c.decimals().catch(() => 18),
                c.balanceOf(signer.address).catch(() => 0n)
            ]);
            selectedAsset = {
                type: 'token',
                address: cAddr,
                symbol: sym,
                name: sym,
                decimals: Number(dec),
                balance: ethers.formatUnits(balWei, Number(dec))
            };
        } catch (e) {
            console.log("❌ Could not read ERC-20 contract details.");
            return;
        }
    }

    console.log(`\nSelected: ${selectedAsset.symbol} ${selectedAsset.name ? `(${selectedAsset.name})` : ''}`);
    console.log(`Available Balance: ${selectedAsset.balance || '0.0'} ${selectedAsset.symbol}`);

    // 4. Amount Selection
    const avail = parseFloat(selectedAsset.balance || '0');
    const amtModePrompt = await inquirer.prompt([{
        type: 'rawlist',
        name: 'mode',
        message: 'How much do you want to send?',
        choices: [
            ...(avail > 0 ? [`⚡ Send MAX (${selectedAsset.balance} ${selectedAsset.symbol})`] : []),
            `🔢 Enter Token Amount (${selectedAsset.symbol})`,
            `💵 Enter Fiat Value (${USER_SETTINGS.currency})`,
            `🔙 Back`
        ]
    }]);

    if (amtModePrompt.mode === '🔙 Back') return;

    let finalAmount = '0';
    if (amtModePrompt.mode.startsWith('⚡ Send MAX')) {
        finalAmount = selectedAsset.balance;
    } else if (amtModePrompt.mode.startsWith('🔢 Enter Token Amount')) {
        const amtInput = await inquirer.prompt([{
            type: 'input',
            name: 'val',
            message: `Enter amount in ${selectedAsset.symbol}:`,
            validate: (v) => {
                const n = parseFloat(v);
                if (isNaN(n) || n <= 0) return "Please enter a valid positive number";
                return true;
            }
        }]);
        finalAmount = amtInput.val.trim();
    } else {
        // Fiat mode
        let unitPrice = 0;
        if (selectedAsset.priceUSD) {
            const fiatRate = await getFiatRate(USER_SETTINGS.currency);
            unitPrice = selectedAsset.priceUSD * fiatRate;
        } else {
            unitPrice = await getPriceCore(selectedAsset.symbol, USER_SETTINGS.currency);
        }
        if (!unitPrice || unitPrice <= 0) {
            console.log(`⚠️  Could not resolve live price for ${selectedAsset.symbol}. Please enter token amount manually.`);
            const amtInput = await inquirer.prompt([{
                type: 'input',
                name: 'val',
                message: `Enter amount in ${selectedAsset.symbol}:`
            }]);
            finalAmount = amtInput.val.trim();
        } else {
            console.log(`ℹ️  Current price: 1 ${selectedAsset.symbol} ≈ ${unitPrice.toFixed(4)} ${USER_SETTINGS.currency}`);
            const fiatInput = await inquirer.prompt([{
                type: 'input',
                name: 'fiat',
                message: `Enter amount in ${USER_SETTINGS.currency}:`,
                validate: (v) => parseFloat(v) > 0 ? true : "Must be > 0"
            }]);
            const valToken = parseFloat(fiatInput.fiat) / unitPrice;
            finalAmount = valToken.toFixed(selectedAsset.decimals > 6 ? 6 : selectedAsset.decimals);
            console.log(`💱 ${fiatInput.fiat} ${USER_SETTINGS.currency} ≈ ${finalAmount} ${selectedAsset.symbol}`);
        }
    }

    // 5. Recipient Selection
    let recipientAddress = null;
    const otherWallets = DECRYPTED_WALLETS.filter(w => w.wallet.address.toLowerCase() !== signer.address.toLowerCase());

    if (otherWallets.length > 0) {
        const destChoice = await inquirer.prompt([{
            type: 'rawlist',
            name: 'dest',
            message: 'Send to:',
            choices: ['Manual Address Entry', 'My Other Wallets in Vault']
        }]);

        if (destChoice.dest === 'My Other Wallets in Vault') {
            const targetChoice = await inquirer.prompt([{
                type: 'rawlist',
                name: 'wallet',
                message: 'Select Recipient Wallet:',
                choices: otherWallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.wallet.address }))
            }]);
            recipientAddress = targetChoice.wallet;
        }
    }

    if (!recipientAddress) {
        const manualInput = await inquirer.prompt([{
            type: 'input',
            name: 'to',
            message: 'Enter Recipient 0x Address:',
            validate: (val) => {
                if (!val || !ethers.isAddress(val.trim())) {
                    return "Invalid EVM address. Please enter a valid 42-character 0x address.";
                }
                return true;
            }
        }]);
        recipientAddress = ethers.getAddress(manualInput.to.trim());
    }

    // 6. Review & Confirmation
    console.log("\n" + "=".repeat(50));
    console.log("📋 TRANSACTION SUMMARY");
    console.log("=".repeat(50));
    console.log(`• Network:    ${network.name} (Chain ID: ${network.chainId})`);
    console.log(`• Sender:     ${senderWalletData.name} (${signer.address})`);
    console.log(`• Recipient:  ${recipientAddress}`);
    console.log(`• Asset:      ${selectedAsset.symbol} ${selectedAsset.type === 'token' ? `[Contract: ${selectedAsset.address}]` : '(Native)'}`);
    console.log(`• Amount:     ${finalAmount} ${selectedAsset.symbol}`);
    console.log("=".repeat(50));

    const confirm = await inquirer.prompt([{
        type: 'confirm',
        name: 'ok',
        message: `Are you sure you want to send ${finalAmount} ${selectedAsset.symbol}?`,
        default: true
    }]);

    if (!confirm.ok) {
        console.log("🚫 Transfer cancelled.");
        return;
    }

    // 7. Execute Transaction
    console.log(`\n⏳ Broadcasting transaction on ${network.name}...`);
    try {
        let txResponse;
        const connectedSigner = signer.connect(provider);

        if (selectedAsset.type === 'token') {
            const contract = new ethers.Contract(selectedAsset.address, ERC20_ABI, connectedSigner);
            const amountWei = ethers.parseUnits(finalAmount, selectedAsset.decimals);
            txResponse = await contract.transfer(recipientAddress, amountWei);
        } else {
            const amountWei = ethers.parseEther(finalAmount);
            const txRequest = {
                to: recipientAddress,
                value: amountWei
            };
            if (USER_SETTINGS.gasLimitBuffer && USER_SETTINGS.gasLimitBuffer !== '0') {
                const estimatedGas = await connectedSigner.estimateGas(txRequest);
                txRequest.gasLimit = estimatedGas + BigInt(USER_SETTINGS.gasLimitBuffer);
            }
            txResponse = await connectedSigner.sendTransaction(txRequest);
        }

        console.log(`\n🎉 Transaction Broadcast Successfully!`);
        console.log(`🔗 Tx Hash: ${txResponse.hash}`);
        const exp = network.explorer || (network.explorers && network.explorers[0]?.url) || '';
        if (exp) {
            console.log(`🌐 Explorer: ${exp}/tx/${txResponse.hash}`);
        }
    } catch (e) {
        console.error(`❌ Transaction Failed: ${e.message}`);
    }
}

async function swapAndBridge() {
    console.log("\n🔄 Swap & Cross-Chain Bridge Engine");
    console.log("⚡ Powered by Multi-DEX & Multi-Bridge Routing across 70+ Chains\n");

    const wallets = await listWallets();
    if (wallets.length === 0) return;

    // 1. Select Wallet
    const wChoices = wallets.map(w => ({ name: `${w.name} (${w.address})`, value: w.address }));
    wChoices.push({ name: '🔙 Back', value: 'BACK' });

    const walletChoice = await inquirer.prompt([{ type: 'rawlist', name: 'addr', message: 'Select Wallet:', choices: wChoices }]);
    if (walletChoice.addr === 'BACK') return;

    const selectedWalletData = DECRYPTED_WALLETS.find(w => w.wallet.address === walletChoice.addr);
    const signer = selectedWalletData.wallet;

    // 2. Select Mode
    const modeChoice = await inquirer.prompt([{
        type: 'rawlist',
        name: 'mode',
        message: 'Select Operation Mode:',
        choices: [
            '🌉 Cross-Chain Bridge (e.g. Ethereum -> Polygon / Base -> Arbitrum)',
            '🔄 Same-Chain Token Swap (e.g. ETH -> USDT)',
            '🔙 Back'
        ]
    }]);

    if (modeChoice.mode.startsWith('🔙')) return;
    const isBridge = modeChoice.mode.startsWith('🌉');

    // 3. Select Source Chain
    console.log("\n📍 Select SOURCE Chain:");
    const fromNetwork = await selectNetwork(true);
    if (fromNetwork === 'BACK') return;

    // 4. Select Source Token
    process.stdout.write(`\n⏳ Scanning tokens & balances on ${fromNetwork.name}... `);
    const fromTokens = await getTokensForChain(fromNetwork.chainId);
    
    // Check if user holds any tokens on source network
    const heldSourceTokens = [];
    try {
        const fromProvider = await getWorkingProvider(fromNetwork.chainId).catch(() => getProvider(fromNetwork.chainId));
        const mc3 = new ethers.Contract(fromNetwork.multicall3 || "0xca11bde05977b3631167028862be2a173976ca11", [
            "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"
        ], fromProvider);
        const erc20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
        const nonNativeFrom = fromTokens.filter(t => !t.isNative && t.address);
        const CHUNK = 250;
        const chunks = [];
        for (let i = 0; i < nonNativeFrom.length; i += CHUNK) chunks.push(nonNativeFrom.slice(i, i + CHUNK));
        await Promise.all(chunks.map(async chunk => {
            const calls = chunk.map(t => ({
                target: t.address,
                allowFailure: true,
                callData: erc20.encodeFunctionData("balanceOf", [signer.address])
            }));
            try {
                const res = await Promise.race([mc3.aggregate3(calls), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
                res.forEach((r, idx) => {
                    if (r.success && r.returnData && r.returnData !== '0x') {
                        const bal = BigInt(r.returnData);
                        if (bal > 0n) {
                            const tok = chunk[idx];
                            heldSourceTokens.push({ ...tok, balance: ethers.formatUnits(bal, tok.decimals) });
                        }
                    }
                });
            } catch (e) {}
        }));
    } catch (e) {}
    process.stdout.write(`Done!\n`);

    const fromTokenChoices = [];
    if (heldSourceTokens.length > 0) {
        for (const ht of heldSourceTokens) {
            fromTokenChoices.push({
                name: `💎 ${ht.symbol} (Balance: ${ht.balance}) - ${ht.name}`,
                value: ht
            });
        }
    }
    const nativeFrom = fromTokens.find(t => t.isNative) || { address: '0x0000000000000000000000000000000000000000', symbol: fromNetwork.currency, name: `${fromNetwork.name} Native`, decimals: 18, isNative: true };
    fromTokenChoices.push({
        name: `💰 ${nativeFrom.symbol} - ${nativeFrom.name} (Native Coin)`,
        value: nativeFrom
    });

    const popularFrom = fromTokens.filter(t => !t.isNative && !heldSourceTokens.some(h => h.address.toLowerCase() === t.address.toLowerCase())).slice(0, 15);
    popularFrom.forEach(t => {
        fromTokenChoices.push({
            name: `${t.symbol} - ${t.name} (${t.address.slice(0, 8)}...)`,
            value: t
        });
    });

    fromTokenChoices.push({ name: `🔍 Search All ${fromTokens.length} Tokens on ${fromNetwork.name}`, value: 'search' });
    fromTokenChoices.push({ name: '✏️  Enter Custom Token Address', value: 'custom' });
    fromTokenChoices.push({ name: '🔙 Back', value: 'BACK' });

    const fromTokenChoice = await inquirer.prompt([{
        type: 'rawlist',
        name: 'token',
        message: 'Select Token to Pay:',
        choices: fromTokenChoices
    }]);

    if (fromTokenChoice.token === 'BACK') return;
    let selectedFromToken = fromTokenChoice.token;
    if (selectedFromToken === 'search') {
        const qInput = await inquirer.prompt([{ type: 'input', name: 'q', message: 'Enter Token Symbol or Name to Search:' }]);
        const q = qInput.q.trim().toLowerCase();
        const matches = fromTokens.filter(t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)).slice(0, 25);
        if (matches.length === 0) { console.log(`❌ No tokens matching "${qInput.q}"`); return; }
        const pick = await inquirer.prompt([{
            type: 'rawlist',
            name: 'tok',
            message: `Matching Tokens (${matches.length} found):`,
            choices: [...matches.map(m => ({ name: `${m.symbol} - ${m.name} (${m.address.slice(0, 8)}...)`, value: m })), { name: '🔙 Cancel', value: 'BACK' }]
        }]);
        if (pick.tok === 'BACK') return;
        selectedFromToken = pick.tok;
    } else if (selectedFromToken === 'custom') {
        const customAddr = await inquirer.prompt([{ type: 'input', name: 'addr', message: 'Contract Address:' }]);
        selectedFromToken = { address: customAddr.addr.trim(), symbol: 'TOKEN', decimals: 18, isNative: false };
    }

    // 5. Select Destination Chain & Token
    let toNetwork = fromNetwork;
    if (isBridge) {
        console.log("\n🎯 Select DESTINATION Chain:");
        toNetwork = await selectNetwork(true);
        if (toNetwork === 'BACK') return;
    }

    console.log(`\n⏳ Fetching verified tokens on ${toNetwork.name}...`);
    const toTokens = await getTokensForChain(toNetwork.chainId);
    const toTokenChoices = [];
    const nativeTo = toTokens.find(t => t.isNative) || { address: '0x0000000000000000000000000000000000000000', symbol: toNetwork.currency, name: `${toNetwork.name} Native`, decimals: 18, isNative: true };
    toTokenChoices.push({
        name: `💰 ${nativeTo.symbol} - ${nativeTo.name} (Native Coin)`,
        value: nativeTo
    });

    const popularTo = toTokens.filter(t => !t.isNative).slice(0, 15);
    popularTo.forEach(t => {
        toTokenChoices.push({
            name: `${t.symbol} - ${t.name} (${t.address.slice(0, 8)}...)`,
            value: t
        });
    });

    toTokenChoices.push({ name: `🔍 Search All ${toTokens.length} Tokens on ${toNetwork.name}`, value: 'search' });
    toTokenChoices.push({ name: '✏️  Enter Custom Token Address', value: 'custom' });
    toTokenChoices.push({ name: '🔙 Back', value: 'BACK' });

    const toTokenChoice = await inquirer.prompt([{
        type: 'rawlist',
        name: 'token',
        message: 'Select Token to Receive:',
        choices: toTokenChoices
    }]);

    if (toTokenChoice.token === 'BACK') return;
    let selectedToToken = toTokenChoice.token;
    if (selectedToToken === 'search') {
        const qInput = await inquirer.prompt([{ type: 'input', name: 'q', message: 'Enter Token Symbol or Name to Search:' }]);
        const q = qInput.q.trim().toLowerCase();
        const matches = toTokens.filter(t => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)).slice(0, 25);
        if (matches.length === 0) { console.log(`❌ No tokens matching "${qInput.q}"`); return; }
        const pick = await inquirer.prompt([{
            type: 'rawlist',
            name: 'tok',
            message: `Matching Tokens (${matches.length} found):`,
            choices: [...matches.map(m => ({ name: `${m.symbol} - ${m.name} (${m.address.slice(0, 8)}...)`, value: m })), { name: '🔙 Cancel', value: 'BACK' }]
        }]);
        if (pick.tok === 'BACK') return;
        selectedToToken = pick.tok;
    } else if (selectedToToken === 'custom') {
        const customAddr = await inquirer.prompt([{ type: 'input', name: 'addr', message: 'Contract Address:' }]);
        selectedToToken = { address: customAddr.addr.trim(), symbol: 'TOKEN', decimals: 18, isNative: false };
    }

    // 6. Specify Amount
    const amtInput = await inquirer.prompt([{
        type: 'input',
        name: 'val',
        message: `Enter Amount of ${selectedFromToken.symbol} to ${isBridge ? 'Bridge' : 'Swap'}:`
    }]);

    const amountIn = amtInput.val.trim();
    if (!amountIn || isNaN(parseFloat(amountIn)) || parseFloat(amountIn) <= 0) {
        console.log("❌ Invalid amount.");
        return;
    }

    // 7. Slippage
    const slipChoice = await inquirer.prompt([{
        type: 'rawlist',
        name: 'slip',
        message: 'Slippage Tolerance:',
        choices: ['0.5% (Recommended)', '1.0%', '2.0%', 'Custom']
    }]);

    let slippage = 0.005;
    if (slipChoice.slip === '1.0%') slippage = 0.01;
    if (slipChoice.slip === '2.0%') slippage = 0.02;
    if (slipChoice.slip === 'Custom') {
        const cust = await inquirer.prompt([{ type: 'input', name: 'v', message: 'Enter slippage % (e.g. 0.8):' }]);
        slippage = parseFloat(cust.v) / 100;
    }

    // 8. Fetch Route & Estimate
    console.log(`\n⏳ Fetching optimal routing across bridges & DEXs...`);
    let quote;
    try {
        quote = await getQuote({
            fromChainId: fromNetwork.chainId,
            toChainId: toNetwork.chainId,
            fromTokenAddress: selectedFromToken.address,
            toTokenAddress: selectedToToken.address,
            fromAmount: amountIn,
            fromAddress: signer.address,
            slippage: slippage
        });
    } catch (e) {
        console.log(`❌ Quote Failed: ${e.message}`);
        return;
    }

    // 9. Display Live Estimation Breakdown
    console.log("\n" + "=".repeat(60));
    console.log(`  ⚡ LIVE ESTIMATION & ROUTE BREAKDOWN`);
    console.log("=".repeat(60));
    console.log(`  Route Tool:            ${quote.provider.toUpperCase()} (${quote.isCrossChain ? 'Cross-Chain Bridge' : 'DEX Aggregator'})`);
    console.log(`  You Pay:               ${quote.fromAmount} ${quote.fromToken.symbol} on ${quote.fromChain.name}`);
    console.log(`  Estimated Output:      ${quote.toAmount} ${quote.toToken.symbol} on ${quote.toChain.name}`);
    console.log(`  Guaranteed Minimum:    ${quote.toAmountMin} ${quote.toToken.symbol}`);
    console.log(`  Exchange Rate:         ${quote.exchangeRate}`);
    console.log(`  Estimated Duration:    ${quote.durationFormatted}`);
    console.log(`  Estimated Gas Cost:    ${quote.gasCostUSD ? '$' + quote.gasCostUSD + ' USD' : 'N/A'}`);
    console.log(`  Protocol/Bridge Fee:   ${quote.feeCostUSD ? '$' + quote.feeCostUSD + ' USD' : '$0.00 USD'}`);
    console.log(`  Total Route Fees:      $${quote.totalFeesUSD} USD`);
    console.log(`  Max Slippage:          ${quote.slippagePct}`);
    console.log("=".repeat(60) + "\n");

    // 10. User Confirmation
    const confirm = await inquirer.prompt([{
        type: 'confirm',
        name: 'ok',
        message: `Execute this ${quote.isCrossChain ? 'Bridge transfer' : 'Swap'} now?`,
        default: true
    }]);

    if (!confirm.ok) {
        console.log("Cancelled.");
        return;
    }

    // 11. Execute
    console.log("\n🚀 Initiating transaction...");
    try {
        const provider = await getWorkingProvider(quote.fromChain.id);
        const connectedSigner = signer.connect(provider);

        const execRes = await executeQuote(connectedSigner, quote, (st) => {
            console.log(`   ⚙️ ${st.message}`);
        });

        console.log(`\n✅ Transaction Confirmed in block ${execRes.blockNumber}!`);
        console.log(`   Tx Hash: ${execRes.hash}`);
        if (fromNetwork.explorer) {
            console.log(`   Explorer: ${fromNetwork.explorer}/tx/${execRes.hash}`);
        }

        if (execRes.isCrossChain) {
            console.log(`\n🌉 Tracking cross-chain bridge progress...`);
            let attempts = 0;
            const poll = setInterval(async () => {
                attempts++;
                if (attempts > 20) {
                    clearInterval(poll);
                    console.log("   Transfer is still processing in background. Funds will arrive shortly.");
                    return;
                }
                const st = await checkTransferStatus(execRes.hash, quote.fromChain.id, quote.toChain.id);
                if (st && st.status === 'DONE') {
                    console.log("   🎉 Cross-Chain Transfer Successfully Completed!");
                    clearInterval(poll);
                }
            }, 6000);
        }
    } catch (e) {
        console.log(`❌ Execution failed: ${e.message}`);
    }
}

async function exploreChainsCLI() {
    console.log("\n🌐 260+ EVM Chains Explorer");
    const popular = getPopularChains();
    
    const action = await inquirer.prompt([{
        type: 'rawlist',
        name: 'do',
        message: 'Chain Explorer Options:',
        choices: [
            '🔍 Search Chains (by Name, Symbol, or Chain ID)',
            '⚡ View Popular Chains & Swap Compatibility',
            '📡 Test RPC Latency / Ping',
            '🔙 Back'
        ]
    }]);

    if (action.do.startsWith('🔙')) return;

    if (action.do.startsWith('🔍 Search')) {
        const query = await inquirer.prompt([{ type: 'input', name: 'q', message: 'Enter Chain Name, Symbol, or Chain ID:' }]);
        const results = searchChains(query.q);
        if (results.length === 0) {
            console.log("❌ No chains found.");
            return;
        }
        console.table(results.slice(0, 25).map(c => ({
            Name: c.name,
            'Chain ID': c.chainId,
            Currency: c.currency,
            'Swap/Bridge': c.hasSwapBridge ? '✅ Yes' : 'DEX Only',
            RPC: c.rpc
        })));
    } else if (action.do.startsWith('⚡ View Popular')) {
        console.table(popular.map(c => ({
            Name: c.name,
            'Chain ID': c.chainId,
            Currency: c.currency,
            'Swap/Bridge': c.hasSwapBridge ? '✅ Yes' : 'DEX Only',
            Explorer: c.explorer || 'N/A'
        })));
    } else if (action.do.startsWith('📡 Test RPC')) {
        const net = await selectNetwork(true);
        if (net === 'BACK') return;
        console.log(`📡 Pinging ${net.name} (${net.rpc})...`);
        const latency = await testRpcLatency(net);
        if (latency.ok) {
            console.log(`✅ Success! Latency: ${latency.latency}ms | Current Block: ${latency.block}`);
        } else {
            console.log(`❌ Failed: ${latency.error} (${latency.latency}ms)`);
        }
    }
}


// --- WalletConnect Logic ---

async function main() {
  console.log("\n🚀 Multi-Wallet CLI Manager");

  // Check if no local wallets exist, and check if a cloud backup is available to restore
  if (loadWalletsRaw().length === 0) {
      try {
          const cloud = await checkCloudBackupAvailable(USER_SETTINGS);
          if (cloud.available) {
              console.log(`\n☁️  No local wallets found, but a cloud backup was detected on ${cloud.method === 'rclone' ? `Rclone ('${cloud.remote}')` : 'Google Drive'}!`);
              const answer = await inquirer.prompt([{
                  type: 'confirm',
                  name: 'restore',
                  message: 'Would you like to automatically import and restore your wallet vault from the cloud backup?',
                  default: true
              }]);
              if (answer.restore) {
                  const res = await restoreFromCloud(USER_SETTINGS, { remote: cloud.remote, method: cloud.method, restoreSettings: true });
                  if (res.success) {
                      console.log(`✅ Restored ${res.count} wallet(s) from cloud backup: ${(res.wallets || []).join(', ')}`);
                      loadPublicWallets();
                  } else {
                      console.log(`⚠️  Cloud restore failed: ${res.error}`);
                  }
              }
          }
      } catch (e) {}
  }
  
  // Check for direct WC URI in args
  const wcArg = process.argv.find(arg => arg.startsWith('wc:'));
  if (wcArg) {
      console.log("🔗 Direct Connection Mode detected.");
      await ensureWalletsUnlocked();
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
          'Show Private Key',
          'Delete Wallet',
          'Check Balance',
          'Portfolio Overview (Auto-Scan Tokens & Chains)',
          'Launch Web Analytics Dashboard (No Password Needed)',
          'Transfer Assets (Tokens/Native)',
          'Swap & Bridge Assets (Cross-Chain & Same-Chain)',
          'Explore 260+ EVM Chains',
          'Connect to dApp (WalletConnect)',
          'Settings',
          new inquirer.Separator(),
          'Exit'
        ]
      }
    ]);

    try {
        switch (answer.action) {
          case 'Create New Wallet':
            await ensureWalletsUnlocked();
            await createNewWallet();
            break;
          case 'Import Wallet':
            await ensureWalletsUnlocked();
            await importWallet();
            break;
          case 'List Wallets':
            const w = await listWallets();
            console.table(w.map(w => ({ Name: w.name, Address: w.address })));
            break;
          case 'Rename Wallet':
            await ensureWalletsUnlocked();
            await renameWallet();
            break;
          case 'Show Private Key':
            await ensureWalletsUnlocked();
            await showPrivateKey();
            break;
          case 'Delete Wallet':
            await ensureWalletsUnlocked();
            await deleteWallet();
            break;
          case 'Check Balance':
            await checkBalance();
            break;
          case 'Portfolio Overview (Auto-Scan Tokens & Chains)':
            await checkPortfolio();
            break;
          case 'Launch Web Analytics Dashboard (No Password Needed)':
            console.log("\n🌐 Launching Web Analytics Dashboard...");
            console.log("👉 Dashboard URL: http://localhost:3000");
            console.log("🔒 Security: 100% Read-Only Mode (Private Keys NEVER loaded)\n");
            await import('./web.js');
            break;
          case 'Transfer Assets (Tokens/Native)':
            await ensureWalletsUnlocked();
            await transferAsset();
            break;
          case 'Swap & Bridge Assets (Cross-Chain & Same-Chain)':
            await ensureWalletsUnlocked();
            await swapAndBridge();
            break;
          case 'Explore 260+ EVM Chains':
            await exploreChainsCLI();
            break;
          case 'Connect to dApp (WalletConnect)':
            await ensureWalletsUnlocked();
            await connectWallet();
            break;
          case 'Settings':
            await changeSettings();
            break;
          case 'Exit':
            console.log("Bye! 👋");
            process.exit(0);
        }
    } catch (e) {
        console.error("❌ Error:", e.message);
    }
    console.log(""); 
  }
}

main();
