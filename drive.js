import fs from 'fs';
import path from 'path';
import os from 'os';
import { google } from 'googleapis';
import inquirer from 'inquirer';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

const CONFIG_DIR = path.join(os.homedir(), '.my-cli-wallet');
const TOKEN_PATH = path.join(CONFIG_DIR, 'gdrive_token.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'gdrive_credentials.json');
const BACKUP_FOLDER_NAME = 'Multi-Wallet-Backups';

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

// --- Rclone Logic ---

export async function checkRclone() {
    try {
        await execPromise('rclone version');
        return true;
    } catch (e) {
        return false;
    }
}

export async function getRcloneRemotes() {
    try {
        const { stdout } = await execPromise('rclone listremotes');
        return stdout.split('\n').filter(r => r.trim() !== '').map(r => r.replace(':', ''));
    } catch (e) {
        return [];
    }
}

export async function setupRclone() {
    console.log("\n📂 Rclone Backup Setup");
    
    if (!await checkRclone()) {
        console.log("❌ Rclone is not installed. Please install it first:");
        console.log("   Termux: pkg install rclone");
        console.log("   Linux/Mac: curl https://rclone.org/install.sh | sudo bash");
        return null;
    }

    const remotes = await getRcloneRemotes();
    if (remotes.length === 0) {
        console.log("⚠️  No Rclone remotes found. Please run 'rclone config' to set one up.");
        return null;
    }

    const answer = await inquirer.prompt([
        {
            type: 'rawlist',
            name: 'remote',
            message: 'Select Rclone Remote for Backup:',
            choices: remotes
        }
    ]);

    return answer.remote;
}

async function backupWithRclone(remoteName) {
    const remotes = await getRcloneRemotes();
    if (!remotes.includes(remoteName)) {
        console.log(`☁️  Rclone remote '${remoteName}' not found in rclone config.`);
        console.log(`   👉 Run 'rclone config' in terminal to configure it, or disable backups in [Settings].`);
        return;
    }

    console.log(`☁️  Backing up via Rclone (${remoteName})...`);
    try {
        const dest = `${remoteName}:${BACKUP_FOLDER_NAME}`;
        
        const files = ['my_wallets.json', 'settings.json'];
        for (const file of files) {
            const filePath = path.join(CONFIG_DIR, file);
            if (fs.existsSync(filePath)) {
                await execPromise(`rclone copy "${filePath}" "${dest}"`);
            }
        }
        console.log("✅ Backup complete.");
    } catch (e) {
        console.log(`⚠️  Rclone backup failed: ${e.message}`);
    }
}

// --- Google Drive API Logic ---

function loadCredentials() {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
}

function loadToken() {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_PATH));
}

function getAuthClient() {
    const creds = loadCredentials();
    if (!creds) return null;
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const token = loadToken();
    if (token) {
        oAuth2Client.setCredentials(token);
    }
    return oAuth2Client;
}

export async function setupDrive() {
    console.log("\n📂 Google Drive API Setup");
    console.log("To enable native backups, you need a Google Cloud Project with Drive API enabled.");
    
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        const answer = await inquirer.prompt([{ 
            type: 'input',
            name: 'path',
            message: 'Path to your downloaded credentials.json (or paste content):'
        }]);

        let content;
        try {
            if (fs.existsSync(answer.path)) {
                content = fs.readFileSync(answer.path, 'utf8');
            } else {
                content = answer.path;
            }
            const json = JSON.parse(content);
            if (!json.installed && !json.web) throw new Error("Invalid structure");
            
            fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(json, null, 2));
            console.log("✅ Credentials saved.");
        } catch (e) {
            console.log(`❌ Invalid credentials: ${e.message}`);
            return;
        }
    }

    const oAuth2Client = getAuthClient();
    if (!oAuth2Client) return;

    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });

    console.log('\n🔗 Authorize this app by visiting this url:');
    console.log(authUrl);

    const codeAnswer = await inquirer.prompt([{ 
        type: 'input',
        name: 'code',
        message: 'Enter the code from that page:'
    }]);

    try {
        const { tokens } = await oAuth2Client.getToken(codeAnswer.code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log("✅ Drive authorized & Token stored.");
    } catch (e) {
        console.error('❌ Error retrieving access token:', e.message);
    }
}

async function findOrCreateFolder(drive, folderName) {
    const res = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive',
    });

    if (res.data.files.length > 0) {
        return res.data.files[0].id;
    }

    const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
    };
    const folder = await drive.files.create({
        resource: fileMetadata,
        fields: 'id',
    });
    return folder.data.id;
}

export async function backupToDrive() {
    const auth = getAuthClient();
    const token = loadToken();
    
    if (!auth || !token) return;

    console.log("☁️  Backing up to Google Drive (Native)...");
    const drive = google.drive({ version: 'v3', auth });

    try {
        const folderId = await findOrCreateFolder(drive, BACKUP_FOLDER_NAME);
        const filesToBackup = ['my_wallets.json', 'settings.json'];
        
        for (const fileName of filesToBackup) {
            const filePath = path.join(CONFIG_DIR, fileName);
            if (!fs.existsSync(filePath)) continue;

            const res = await drive.files.list({
                q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
                fields: 'files(id, name)',
            });

            const media = {
                mimeType: 'application/json',
                body: fs.createReadStream(filePath),
            };

            if (res.data.files.length > 0) {
                await drive.files.update({
                    fileId: res.data.files[0].id,
                    media: media,
                });
            } else {
                await drive.files.create({
                    resource: { name: fileName, parents: [folderId] },
                    media: media,
                    fields: 'id',
                });
            }
        }
        console.log("✅ Backup complete.");
    } catch (e) {
        console.log(`⚠️  Native Backup failed: ${e.message}`);
    }
}

// --- Unified Export ---

export async function triggerBackup(settings) {
    if (settings.backupMethod === 'rclone' && settings.rcloneRemote) {
        await backupWithRclone(settings.rcloneRemote);
    } else if (settings.backupMethod === 'gapi') {
        await backupToDrive();
    }
}

// --- Restore & Cloud Import Logic ---

export async function checkCloudBackupAvailable(settings = {}) {
    // 1. Check Rclone remotes
    if (await checkRclone()) {
        const remotes = await getRcloneRemotes();
        const candidateRemotes = [];
        if (settings.rcloneRemote && remotes.includes(settings.rcloneRemote)) {
            candidateRemotes.push(settings.rcloneRemote);
        }
        for (const r of remotes) {
            if (!candidateRemotes.includes(r)) candidateRemotes.push(r);
        }

        for (const remote of candidateRemotes) {
            try {
                const { stdout } = await execPromise(`rclone lsf "${remote}:${BACKUP_FOLDER_NAME}"`);
                if (stdout.includes('my_wallets.json')) {
                    const files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
                    return {
                        available: true,
                        method: 'rclone',
                        remote: remote,
                        files: files
                    };
                }
            } catch (e) {}
        }
    }

    // 2. Check Google Drive Native API
    const auth = getAuthClient();
    const token = loadToken();
    if (auth && token) {
        try {
            const drive = google.drive({ version: 'v3', auth });
            const res = await drive.files.list({
                q: `mimeType='application/vnd.google-apps.folder' and name='${BACKUP_FOLDER_NAME}' and trashed=false`,
                fields: 'files(id, name)',
                spaces: 'drive',
            });
            if (res.data.files && res.data.files.length > 0) {
                const folderId = res.data.files[0].id;
                const fileRes = await drive.files.list({
                    q: `name='my_wallets.json' and '${folderId}' in parents and trashed=false`,
                    fields: 'files(id, name)',
                });
                if (fileRes.data.files && fileRes.data.files.length > 0) {
                    return {
                        available: true,
                        method: 'gapi',
                        remote: 'Google Drive Native API',
                        files: ['my_wallets.json']
                    };
                }
            }
        } catch (e) {}
    }

    return { available: false };
}

export async function restoreWithRclone(remoteName, options = { merge: false }) {
    const remotes = await getRcloneRemotes();
    if (!remotes.includes(remoteName)) {
        return { success: false, error: `Rclone remote '${remoteName}' not found.` };
    }

    console.log(`☁️  Fetching cloud backup from Rclone (${remoteName}:${BACKUP_FOLDER_NAME})...`);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-restore-'));
    try {
        await execPromise(`rclone copy "${remoteName}:${BACKUP_FOLDER_NAME}/my_wallets.json" "${tempDir}"`);
        const tempWalletFile = path.join(tempDir, 'my_wallets.json');
        if (!fs.existsSync(tempWalletFile)) {
            return { success: false, error: 'my_wallets.json was not found in remote backup folder.' };
        }

        const cloudWallets = JSON.parse(fs.readFileSync(tempWalletFile, 'utf8'));
        if (!Array.isArray(cloudWallets)) {
            return { success: false, error: 'Invalid wallet data format in cloud backup.' };
        }

        const localWalletFile = path.join(CONFIG_DIR, 'my_wallets.json');
        let finalWallets = cloudWallets;

        if (fs.existsSync(localWalletFile)) {
            // Safety backup of existing local file
            const bakFile = path.join(CONFIG_DIR, `my_wallets.json.bak-${Date.now()}`);
            fs.copyFileSync(localWalletFile, bakFile);

            if (options.merge) {
                const localWallets = JSON.parse(fs.readFileSync(localWalletFile, 'utf8'));
                const getAddr = (w) => {
                    if (w.privateKey) return w.privateKey.toLowerCase();
                    if (w.data) {
                        try {
                            const parsed = typeof w.data === 'string' ? JSON.parse(w.data) : w.data;
                            return (parsed.address || '').toLowerCase();
                        } catch (e) {}
                    }
                    return w.name.toLowerCase();
                };

                const existingAddrs = new Set(localWallets.map(getAddr));
                let addedCount = 0;
                for (const cw of cloudWallets) {
                    const addr = getAddr(cw);
                    if (!existingAddrs.has(addr)) {
                        localWallets.push(cw);
                        existingAddrs.add(addr);
                        addedCount++;
                    }
                }
                finalWallets = localWallets;
                console.log(`🔄 Merged ${addedCount} new wallet(s) from cloud into local vault.`);
            }
        }

        fs.writeFileSync(localWalletFile, JSON.stringify(finalWallets, null, 2));

        // Restore settings if requested or if missing locally
        const localSettingsFile = path.join(CONFIG_DIR, 'settings.json');
        if (!fs.existsSync(localSettingsFile) || options.restoreSettings) {
            try {
                await execPromise(`rclone copy "${remoteName}:${BACKUP_FOLDER_NAME}/settings.json" "${tempDir}"`);
                const tempSettings = path.join(tempDir, 'settings.json');
                if (fs.existsSync(tempSettings)) {
                    fs.copyFileSync(tempSettings, localSettingsFile);
                    console.log("⚙️  Restored user settings from cloud backup.");
                }
            } catch (e) {}
        }

        return { 
            success: true, 
            count: finalWallets.length, 
            wallets: finalWallets.map(w => w.name),
            method: 'rclone', 
            remote: remoteName 
        };
    } catch (e) {
        return { success: false, error: e.message };
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    }
}

export async function restoreWithDriveAPI(options = { merge: false }) {
    const auth = getAuthClient();
    const token = loadToken();
    if (!auth || !token) {
        return { success: false, error: 'Google Drive credentials or token not configured.' };
    }

    console.log("☁️  Fetching cloud backup from Google Drive (Native API)...");
    const drive = google.drive({ version: 'v3', auth });

    try {
        const folderId = await findOrCreateFolder(drive, BACKUP_FOLDER_NAME);
        const res = await drive.files.list({
            q: `name='my_wallets.json' and '${folderId}' in parents and trashed=false`,
            fields: 'files(id, name)',
        });

        if (!res.data.files || res.data.files.length === 0) {
            return { success: false, error: 'my_wallets.json not found in Google Drive backup folder.' };
        }

        const fileId = res.data.files[0].id;
        const fileRes = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'text' });
        const cloudWallets = typeof fileRes.data === 'string' ? JSON.parse(fileRes.data) : fileRes.data;

        if (!Array.isArray(cloudWallets)) {
            return { success: false, error: 'Invalid wallet data in Google Drive backup.' };
        }

        const localWalletFile = path.join(CONFIG_DIR, 'my_wallets.json');
        let finalWallets = cloudWallets;

        if (fs.existsSync(localWalletFile)) {
            const bakFile = path.join(CONFIG_DIR, `my_wallets.json.bak-${Date.now()}`);
            fs.copyFileSync(localWalletFile, bakFile);

            if (options.merge) {
                const localWallets = JSON.parse(fs.readFileSync(localWalletFile, 'utf8'));
                const getAddr = (w) => {
                    if (w.privateKey) return w.privateKey.toLowerCase();
                    if (w.data) {
                        try {
                            const parsed = typeof w.data === 'string' ? JSON.parse(w.data) : w.data;
                            return (parsed.address || '').toLowerCase();
                        } catch (e) {}
                    }
                    return w.name.toLowerCase();
                };

                const existingAddrs = new Set(localWallets.map(getAddr));
                let addedCount = 0;
                for (const cw of cloudWallets) {
                    const addr = getAddr(cw);
                    if (!existingAddrs.has(addr)) {
                        localWallets.push(cw);
                        existingAddrs.add(addr);
                        addedCount++;
                    }
                }
                finalWallets = localWallets;
                console.log(`🔄 Merged ${addedCount} new wallet(s) from cloud into local vault.`);
            }
        }

        fs.writeFileSync(localWalletFile, JSON.stringify(finalWallets, null, 2));

        // Restore settings if requested or missing
        const localSettingsFile = path.join(CONFIG_DIR, 'settings.json');
        if (!fs.existsSync(localSettingsFile) || options.restoreSettings) {
            try {
                const sRes = await drive.files.list({
                    q: `name='settings.json' and '${folderId}' in parents and trashed=false`,
                    fields: 'files(id, name)',
                });
                if (sRes.data.files && sRes.data.files.length > 0) {
                    const sFileRes = await drive.files.get({ fileId: sRes.data.files[0].id, alt: 'media' }, { responseType: 'text' });
                    const sData = typeof sFileRes.data === 'string' ? sFileRes.data : JSON.stringify(sFileRes.data, null, 2);
                    fs.writeFileSync(localSettingsFile, sData);
                    console.log("⚙️  Restored user settings from Google Drive.");
                }
            } catch (e) {}
        }

        return { 
            success: true, 
            count: finalWallets.length, 
            wallets: finalWallets.map(w => w.name),
            method: 'gapi' 
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

export async function restoreFromCloud(settings = {}, options = {}) {
    const method = options.method || settings.backupMethod || 'rclone';
    if (method === 'rclone') {
        let remote = options.remote || settings.rcloneRemote;
        if (!remote) {
            const remotes = await getRcloneRemotes();
            if (remotes.length === 0) return { success: false, error: 'No Rclone remotes configured.' };
            remote = remotes[0];
        }
        return await restoreWithRclone(remote, options);
    } else if (method === 'gapi') {
        return await restoreWithDriveAPI(options);
    }
    return { success: false, error: 'Unknown backup method' };
}