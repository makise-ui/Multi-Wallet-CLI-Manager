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

async function checkRclone() {
    try {
        await execPromise('rclone version');
        return true;
    } catch (e) {
        return false;
    }
}

async function getRcloneRemotes() {
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