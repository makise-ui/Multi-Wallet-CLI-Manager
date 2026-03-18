/**
 * recovery.js  –  Vault disaster-recovery helpers
 *
 * Path A  –  Shamir's Secret Sharing
 *   setupShamirRecovery(password, threshold, totalShares)
 *     → { shares: string[] }   (hex strings, one per guardian)
 *   recoverFromShares(shares)
 *     → { password: string }   (reconstructed vault password)
 *
 * Path B  –  BIP-39 Guardian Key  (wraps vault password with a mnemonic-derived key)
 *   setupGuardianKey(currentPassword)
 *     → { mnemonic: string }   (24-word phrase — user must write it down)
 *   recoverFromGuardian(mnemonic)
 *     → { password: string }   (decrypted vault password)
 *
 * Both paths store their artefacts in CONFIG_DIR.
 * Neither path stores the raw vault password on disk.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { ethers } from 'ethers';
import sss from 'shamirs-secret-sharing';

// ── Config paths ──────────────────────────────────────────────────────────────
const CONFIG_DIR   = path.join(os.homedir(), '.my-cli-wallet');
const SHAMIR_FILE  = path.join(CONFIG_DIR, 'shamir_meta.json');   // public metadata only
const GUARDIAN_FILE = path.join(CONFIG_DIR, 'guardian_blob.json'); // encrypted blob

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER: derive a 32-byte AES key from a BIP-39 mnemonic via PBKDF2
// ─────────────────────────────────────────────────────────────────────────────
async function mnemonicToAesKey(mnemonic) {
    // ethers v6: computeHmac / pbkdf2 not directly exposed simply, so use Node crypto
    const seed = Buffer.from(ethers.Mnemonic.fromPhrase(mnemonic).computeSeed(), 'hex');
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(seed, 'guardian-key-salt', 210_000, 32, 'sha512', (err, dk) => {
            if (err) reject(err); else resolve(dk);
        });
    });
}

function aesEncrypt(keyBuf, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('hex'),
        tag: tag.toString('hex'),
        data: enc.toString('hex'),
    };
}

function aesDecrypt(keyBuf, blob) {
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        keyBuf,
        Buffer.from(blob.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
    const dec = Buffer.concat([
        decipher.update(Buffer.from(blob.data, 'hex')),
        decipher.final(),
    ]);
    return dec.toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
//  PATH A – Shamir's Secret Sharing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split `password` into `totalShares` shares where any `threshold` of them
 * can reconstruct it.  The shares themselves are returned to the caller to
 * distribute; only *metadata* (threshold/total counts) is written to disk.
 *
 * @param {string} password
 * @param {number} threshold   – minimum shares required to reconstruct
 * @param {number} totalShares – total shares to generate
 * @returns {{ shares: string[] }}
 */
export function setupShamirRecovery(password, threshold, totalShares) {
    if (threshold < 2) throw new Error('Threshold must be at least 2.');
    if (totalShares < threshold) throw new Error('Total shares must be >= threshold.');

    const secret = Buffer.from(password, 'utf8');
    const rawShares = sss.split(secret, { shares: totalShares, threshold });

    // Store only non-sensitive metadata
    fs.writeFileSync(SHAMIR_FILE, JSON.stringify({ threshold, totalShares }, null, 2));

    return { shares: rawShares.map(s => s.toString('hex')) };
}

/**
 * Reconstruct the vault password from an array of hex share strings.
 * Requires at least `threshold` shares (as set during setup).
 *
 * @param {string[]} hexShares
 * @returns {{ password: string }}
 */
export function recoverFromShares(hexShares) {
    const buffers = hexShares.map(h => Buffer.from(h, 'hex'));
    const recovered = sss.combine(buffers);
    return { password: recovered.toString('utf8') };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PATH B – BIP-39 Guardian Key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a fresh BIP-39 mnemonic, derive an AES key from it, encrypt
 * `currentPassword`, and save the opaque blob to disk.
 * The mnemonic **must** be written down by the user — it is never stored.
 *
 * @param {string} currentPassword  – The vault master password
 * @returns {Promise<{ mnemonic: string }>}
 */
export async function setupGuardianKey(currentPassword) {
    const mnemonic = ethers.Mnemonic.entropyToPhrase(ethers.randomBytes(32)); // 24 words
    const key   = await mnemonicToAesKey(mnemonic);
    const blob  = aesEncrypt(key, currentPassword);

    fs.writeFileSync(GUARDIAN_FILE, JSON.stringify(blob, null, 2));
    return { mnemonic };
}

/**
 * Recover the vault password using the 24-word guardian mnemonic.
 *
 * @param {string} mnemonic  – The guardian mnemonic phrase
 * @returns {Promise<{ password: string }>}
 */
export async function recoverFromGuardian(mnemonic) {
    if (!fs.existsSync(GUARDIAN_FILE)) {
        throw new Error('Guardian blob not found. Run "Setup Vault Recovery" first.');
    }
    const blob = JSON.parse(fs.readFileSync(GUARDIAN_FILE, 'utf8'));
    const key  = await mnemonicToAesKey(mnemonic.trim());
    try {
        const password = aesDecrypt(key, blob);
        return { password };
    } catch {
        throw new Error('Invalid guardian phrase – decryption failed.');
    }
}

/**
 * Returns recovery status for display purposes.
 * @returns {{ shamir: boolean, guardian: boolean }}
 */
export function recoveryStatus() {
    return {
        shamir:   fs.existsSync(SHAMIR_FILE),
        guardian: fs.existsSync(GUARDIAN_FILE),
    };
}
