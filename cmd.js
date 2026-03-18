#!/usr/bin/env node
/**
 * cmd.js  –  Scriptable, non-interactive entry-point for my-wallet
 *
 * Usage:
 *   my-wallet <command> [options]
 *
 * When called WITHOUT a command it falls through to the interactive CLI.
 *
 * Global flags (accepted before OR after the command):
 *   --pass  <password>   Vault password (avoid shell history; use WALLET_PASS env var instead)
 *   --json               Output machine-readable JSON
 *   --yes                Skip confirmation prompts (where applicable)
 *   --help               Show help and exit
 *
 * Commands:
 *   list                            List all wallets
 *   balance  [--wallet <name>]      Show ETH balance(s)
 *   create   --name <name>          Create a new wallet
 *   import   --name <name>          Import wallet (reads private-key from stdin or --pk flag)
 *   show-key --wallet <name>        Print private key for wallet
 *   recovery setup-shamir           Interactive Shamir SSS setup wizard
 *   recovery setup-guardian         Interactive guardian-key setup wizard
 *   recovery recover-shamir         Reconstruct vault password from shares
 *   recovery recover-guardian       Reconstruct vault password from mnemonic
 */

import { parseArgs }  from 'node:util';
import { createInterface } from 'node:readline';
import { spawnSync }  from 'node:child_process';
import path           from 'node:path';
import { fileURLToPath } from 'node:url';
import fs             from 'node:fs';
import os             from 'node:os';

// ── Load ethers + recovery helpers (lazy, only when needed) ──────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Argument parsing ──────────────────────────────────────────────────────────
const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
        pass:    { type: 'string' },
        wallet:  { type: 'string' },
        name:    { type: 'string' },
        pk:      { type: 'string' },   // --pk <privateKey>
        shares:  { type: 'string' },   // --shares "hex1,hex2,..."
        threshold: { type: 'string' }, // --threshold 2
        total:   { type: 'string' },   // --total 3
        json:    { type: 'boolean', default: false },
        yes:     { type: 'boolean', default: false },
        help:    { type: 'boolean', default: false },
    },
});

const command      = positionals[0];
const subcommand   = positionals[1];
const jsonMode     = flags.json;
const skipConfirm  = flags.yes;
const vaultPass    = flags.pass ?? process.env.WALLET_PASS ?? null;

const CONFIG_DIR   = path.join(os.homedir(), '.my-cli-wallet');
const WALLETS_FILE = path.join(CONFIG_DIR, 'my_wallets.json');

// ── Helpers ───────────────────────────────────────────────────────────────────
function out(data) {
    if (jsonMode) {
        console.log(JSON.stringify(data, null, 2));
    } else if (typeof data === 'string') {
        console.log(data);
    } else {
        console.table(data);
    }
}

function die(msg, code = 1) {
    if (jsonMode) {
        console.error(JSON.stringify({ error: msg }));
    } else {
        console.error('❌  ' + msg);
    }
    process.exit(code);
}

function loadRaw() {
    if (!fs.existsSync(WALLETS_FILE)) return [];
    return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
}

async function unlockWallets(password) {
    const { ethers } = await import('ethers');
    const raw = loadRaw();
    if (raw.length === 0) return [];

    if (raw[0].privateKey) {
        // Unencrypted
        return raw.map(w => ({ name: w.name, wallet: new ethers.Wallet(w.privateKey) }));
    }

    if (!password) die('Vault is encrypted. Provide --pass <password> or set WALLET_PASS env var.');

    const wallets = [];
    for (const w of raw) {
        let wallet;
        try {
            wallet = await ethers.Wallet.fromEncryptedJson(w.data, password);
        } catch {
            die('Wrong vault password.');
        }
        wallets.push({ name: w.name, wallet });
    }
    return wallets;
}

function stdinLine(prompt) {
    return new Promise(resolve => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        rl.question(prompt, answer => { rl.close(); resolve(answer.trim()); });
    });
}

function showHelp() {
    console.log(`
my-wallet – multi-chain CLI wallet manager

Usage:
  my-wallet [command] [options]

Global flags:
  --pass <password>          Vault password (or set WALLET_PASS env var)
  --json                     Machine-readable JSON output
  --yes                      Skip confirmation prompts
  --help                     Show this help

Commands:
  (none)                     Launch interactive menu
  list                       List all wallets
  balance                    Show ETH balance for all wallets
  balance  --wallet <name>   Show ETH balance for one wallet
  create   --name <name>     Create a new wallet (interactive encryption)
  import   --name <name>     Import wallet via --pk or stdin
  show-key --wallet <name>   Print private key

Recovery commands:
  recovery setup-shamir      Set up Shamir secret-sharing recovery
  recovery setup-guardian    Set up BIP-39 guardian-key recovery
  recovery recover-shamir    Recover vault password from Shamir shares
  recovery recover-guardian  Recover vault password from guardian mnemonic

Examples:
  WALLET_PASS=secret my-wallet list --json
  my-wallet show-key --wallet "Main" --pass secret
  my-wallet recovery setup-shamir
`);
    process.exit(0);
}

// ── Recovery wizard helpers (interactive) ─────────────────────────────────────
async function wizardSetupShamir() {
    const { setupShamirRecovery } = await import('./recovery.js');
    const inquirer = (await import('inquirer')).default;

    const { threshold, total } = await inquirer.prompt([
        { type: 'number', name: 'threshold', message: 'Minimum shares required to recover (threshold):', default: 2, validate: v => v >= 2 || 'Must be ≥ 2' },
        { type: 'number', name: 'total',     message: 'Total shares to generate:', default: 3,
            validate: (v, { threshold }) => v >= threshold || `Must be ≥ threshold (${threshold})` }
    ]);

    const { password } = await inquirer.prompt([
        { type: 'password', name: 'password', message: 'Enter vault password to split:', mask: '*' }
    ]);

    const { shares } = setupShamirRecovery(password, threshold, total);

    console.log('\n🔑  Shamir shares generated — distribute these to your guardians:\n');
    shares.forEach((s, i) => console.log(`  Share ${i + 1}/${total}:\n  ${s}\n`));
    console.log(`⚠️   You need any ${threshold} of ${total} shares to recover.\n`);
    console.log('✅  Recovery metadata saved.');
}

async function wizardSetupGuardian() {
    const { setupGuardianKey } = await import('./recovery.js');
    const inquirer = (await import('inquirer')).default;

    const { password } = await inquirer.prompt([
        { type: 'password', name: 'password', message: 'Enter vault password to wrap:', mask: '*' }
    ]);

    const { mnemonic } = await setupGuardianKey(password);
    console.log('\n🔐  Guardian phrase (24 words) — write this down and keep it SAFE:\n');
    const words = mnemonic.split(' ');
    for (let i = 0; i < words.length; i += 4) {
        console.log(`  ${words.slice(i, i + 4).map((w, j) => `${i + j + 1}. ${w}`).join('   ')}`);
    }
    console.log('\n✅  Encrypted guardian blob saved. Phrase is NOT stored anywhere.\n');
}

async function wizardRecoverShamir() {
    const { recoverFromShares } = await import('./recovery.js');
    const inquirer = (await import('inquirer')).default;

    const { rawShares } = await inquirer.prompt([
        { type: 'editor', name: 'rawShares', message: 'Paste your shares (one hex string per line):' }
    ]);
    const shares = rawShares.trim().split('\n').map(s => s.trim()).filter(Boolean);

    try {
        const { password } = recoverFromShares(shares);
        console.log('\n✅  Vault password recovered:');
        out(jsonMode ? { password } : `   ${password}`);
    } catch (e) {
        die(e.message);
    }
}

async function wizardRecoverGuardian() {
    const { recoverFromGuardian } = await import('./recovery.js');
    const mnemonic = await stdinLine('Enter your 24-word guardian phrase: ');
    try {
        const { password } = await recoverFromGuardian(mnemonic);
        console.log('\n✅  Vault password recovered:');
        out(jsonMode ? { password } : `   ${password}`);
    } catch (e) {
        die(e.message);
    }
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function main() {
    if (flags.help || command === 'help') return showHelp();

    // ── No command → fall through to interactive CLI ──────────────────────────
    if (!command) {
        // Re-exec cli.js with the original argv (skip ourselves)
        const cliPath = path.join(__dirname, 'cli.js');
        const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
            stdio: 'inherit',
            env: { ...process.env, ...(vaultPass ? { WALLET_PASS: vaultPass } : {}) }
        });
        process.exit(result.status ?? 0);
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (command === 'list') {
        const wallets = await unlockWallets(vaultPass);
        out(wallets.map(w => ({ name: w.name, address: w.wallet.address })));
        return;
    }

    // ── balance ───────────────────────────────────────────────────────────────
    if (command === 'balance') {
        const { ethers } = await import('ethers');
        const provider = new ethers.JsonRpcProvider('https://eth.llamarpc.com');
        const wallets  = await unlockWallets(vaultPass);
        const target   = flags.wallet ? wallets.filter(w => w.name === flags.wallet) : wallets;
        if (target.length === 0) die(`Wallet "${flags.wallet}" not found.`);

        const results = await Promise.all(target.map(async w => {
            const bal = await provider.getBalance(w.wallet.address);
            return { name: w.name, address: w.wallet.address, eth: ethers.formatEther(bal) };
        }));
        out(results);
        return;
    }

    // ── show-key ──────────────────────────────────────────────────────────────
    if (command === 'show-key') {
        if (!flags.wallet) die('--wallet <name> is required.');
        const wallets = await unlockWallets(vaultPass);
        const found   = wallets.find(w => w.name === flags.wallet);
        if (!found) die(`Wallet "${flags.wallet}" not found.`);
        if (!skipConfirm) {
            const yn = await stdinLine('⚠️  Are you sure you want to display the private key? [y/N] ');
            if (!yn.match(/^y(es)?$/i)) { console.log('Aborted.'); return; }
        }
        out(jsonMode ? { name: found.name, privateKey: found.wallet.privateKey }
                     : `Private key for ${found.name}:\n${found.wallet.privateKey}`);
        return;
    }

    // ── recovery ──────────────────────────────────────────────────────────────
    if (command === 'recovery') {
        if (!subcommand) die('Specify a recovery sub-command. Run --help for details.');
        switch (subcommand) {
            case 'setup-shamir':      await wizardSetupShamir();    break;
            case 'setup-guardian':    await wizardSetupGuardian();  break;
            case 'recover-shamir':    await wizardRecoverShamir();  break;
            case 'recover-guardian':  await wizardRecoverGuardian(); break;
            default: die(`Unknown recovery sub-command: ${subcommand}`);
        }
        return;
    }

    // ── create / import – fall through to interactive for encryption wizard ───
    if (command === 'create' || command === 'import') {
        console.log(`ℹ️  "${command}" requires interactive prompts. Launching full CLI…`);
        const cliPath = path.join(__dirname, 'cli.js');
        const result  = spawnSync(process.execPath, [cliPath], { stdio: 'inherit' });
        process.exit(result.status ?? 0);
        return;
    }

    die(`Unknown command: "${command}". Run --help for usage.`);
}

main().catch(e => die(e.message));
