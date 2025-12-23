# 🚀 Multi-Wallet CLI Manager

A powerful, secure, and headless CLI tool to manage multiple crypto wallets, connect to dApps via WalletConnect, and perform token swaps directly from your terminal.

## ✨ Features

*   **🔐 Secure Storage**: Wallets are encrypted with a vault password and stored locally in `~/.my-cli-wallet/`.
*   **🔌 WalletConnect v2**: Connect to any dApp (Uniswap, PancakeSwap, OpenSea, etc.) by pasting a `wc:` URI.
*   **⛓️ Multi-Chain Support**: Native support for **Ethereum**, **Binance Smart Chain (BSC)**, **Polygon**, and **Celo**.
*   **💸 Asset Management**:
    *   Check Balances (Native & Tokens).
    *   Transfer Assets (ETH, BNB, USDT, JMPT, etc.).
    *   Fiat Values (Real-time prices via CoinGecko).
*   **🔄 Built-in Swaps**: Swap tokens (e.g., JMPT -> BNB) directly in the CLI (beta).
*   **⚙️ Customizable**: Set default networks, gas buffers, and add custom tokens.

## 🛠️ Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/yourusername/multi-wallet-cli.git
    cd multi-wallet-cli
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    ```

3.  **Link Global Command** (Optional):
    This allows you to run `my-wallet` from anywhere.
    ```bash
    npm link
    ```

## 🚀 Usage

Run the tool:
```bash
# If linked:
my-wallet

# Or directly:
node cli.js
```

### First Run
1.  The tool will ask you to create a **Vault Password**.
2.  **Remember this password!** It encrypts your private keys.
3.  You can then **Create New Wallets** or **Import** existing ones (Private Key or Mnemonic).

### Connecting to a dApp
1.  Go to a dApp (e.g., PancakeSwap) on your browser.
2.  Click **Connect Wallet** -> **WalletConnect**.
3.  Copy the URI (starts with `wc:...`).
4.  In the CLI, select **Connect to dApp**.
5.  Choose your wallet and paste the URI.
6.  Approve the connection and sign requests directly from the terminal!

## 📂 Configuration

Your data is stored securely in your home directory:
*   **Linux/Mac/Termux**: `~/.my-cli-wallet/`
*   **Windows**: `C:\Users\You\.my-cli-wallet\`

**Files:**
*   `my_wallets.json`: Encrypted wallet data.
*   `settings.json`: Your preferences (Currency, Default Network, Saved Tokens).

## 🛡️ Security Note

*   **Self-Custody**: You control your private keys. They never leave your device.
*   **Encryption**: Keys are encrypted using AES (via `ethers.js`).
*   **Safety**: Always back up your recovery phrases offline. If you lose your Vault Password, your CLI data cannot be recovered.

## 📜 License

ISC
