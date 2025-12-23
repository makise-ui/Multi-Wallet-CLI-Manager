import fs from 'fs';
import path from 'path';
import os from 'os';
import { google } from 'googleapis';
import inquirer from 'inquirer';

const CONFIG_DIR = path.join(os.homedir(), '.my-cli-wallet');
const TOKEN_PATH = path.join(CONFIG_DIR, 'gdrive_token.json');
const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'gdrive_credentials.json');
const BACKUP_FOLDER_NAME = 'Multi-Wallet-Backups';

// Scope for reading/writing files
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

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
    console.log("\n📂 Google Drive Backup Setup");
    console.log("To enable backups, you need a Google Cloud Project with Drive API enabled.");
    console.log("1. Go to https://console.cloud.google.com/");
    console.log("2. Create a project > Enable 'Google Drive API'.");
    console.log("3. Create Credentials > OAuth Client ID > Desktop App.");
    console.log("4. Download the JSON file.");

    // 1. Get Credentials
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
            // Validate JSON
            const json = JSON.parse(content);
            if (!json.installed && !json.web) throw new Error("Invalid structure");
            
            fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(json, null, 2));
            console.log("✅ Credentials saved.");
        } catch (e) {
            console.log(`❌ Invalid credentials: ${e.message}`);
            return;
        }
    }

    // 2. Authorize
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

    // Create
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
    
    if (!auth || !token) {
        // Not configured, silent return or log if verbose?
        // console.log("Drive backup skipped (not configured).");
        return;
    }

    console.log("☁️  Backing up to Google Drive...");
    const drive = google.drive({ version: 'v3', auth });

    try {
        const folderId = await findOrCreateFolder(drive, BACKUP_FOLDER_NAME);
        
        const filesToBackup = ['my_wallets.json', 'settings.json'];
        
        for (const fileName of filesToBackup) {
            const filePath = path.join(CONFIG_DIR, fileName);
            if (!fs.existsSync(filePath)) continue;

            // Check if file exists in folder
            const res = await drive.files.list({
                q: `name='${fileName}' and '${folderId}' in parents and trashed=false`,
                fields: 'files(id, name)',
            });

            const media = {
                mimeType: 'application/json',
                body: fs.createReadStream(filePath),
            };

            if (res.data.files.length > 0) {
                // Update
                const fileId = res.data.files[0].id;
                await drive.files.update({
                    fileId: fileId,
                    media: media,
                });
                // console.log(`   Updated ${fileName}`);
            } else {
                // Create
                await drive.files.create({
                    resource: {
                        name: fileName,
                        parents: [folderId],
                    },
                    media: media,
                    fields: 'id',
                });
                // console.log(`   Created ${fileName}`);
            }
        }
        console.log("✅ Backup complete.");
    } catch (e) {
        console.log(`⚠️  Backup failed: ${e.message}`);
    }
}
