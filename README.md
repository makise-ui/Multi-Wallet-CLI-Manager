# 🚀 Multi-Wallet CLI Manager Pro

A powerful, institutional-grade, headless terminal workstation to securely manage multiple crypto wallets, auto-detect tokens across **260+ EVM chains**, bridge & swap assets with live in/out estimation, interact with dApps via WalletConnect v2, and navigate a brand new high-performance **Terminal User Interface (TUI)**.

---

## ✨ Key Features

*   **🌐 260+ EVM Chains Supported**:
    *   Pre-curated registry of 260+ EVM networks (Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, Avalanche, Linea, Blast, Scroll, zkSync Era, Mantle, Celo, Gnosis, Sonic, Berachain, Monad, HyperEVM, etc.).
    *   High-availability public RPCs with automatic failover and latency testing.
    *   Live search by chain name, native symbol, or chain ID.
*   **📊 Automatic Multi-Chain Token Discovery & Neat Portfolio**:
    *   Auto-detects tokens held on any chain using open explorer indexers (Blockscout v2) and high-speed **Multicall3** batch scanning.
    *   Enriches all balances with real-time USD prices via **DefiLlama** without requiring any paid API keys.
    *   Neat portfolio breakdowns: Grand Total Net Worth ($), active chain share %, and asset-by-asset holdings.
*   **🔄 Advanced Swap & Cross-Chain Bridge Engine**:
    *   Aggregates 36 DEXs and 36 cross-chain bridges (Across, Stargate, Uniswap, 1inch, Nordstern, etc.) via LI.FI & smart routing.
    *   **Live Route Estimation**:
        *   Input vs. Estimated Output Amount
        *   Guaranteed Minimum Received (after slippage)
        *   Real-time Exchange Rate
        *   Estimated Gas Cost (USD) & Protocol/Bridge Fees (USD)
        *   Estimated Execution Duration (e.g., `~45 seconds`)
        *   Customizable slippage tolerance (0.5%, 1.0%, custom)
    *   One-click approval & execution with live on-chain status tracking.
*   **🖥️ Brand New Professional Terminal UI (TUI)**:
    *   A completely redesigned, responsive terminal dashboard built from scratch.
    *   Tabbed navigation:
        *   `[1] Portfolio`: KPI summary cards, active chain allocations, auto-detected asset tables.
        *   `[2] Swap & Bridge`: Interactive configuration with live route quote card and bridge tracker.
        *   `[3] 260+ Chains`: Searchable chain directory, network specs, and live RPC ping test.
        *   `[4] Transfer`: Clean guided asset sender.
        *   `[5] Wallets`: Vault security status, switch active wallet, copy address.
        *   `[6] Logs`: Real-time system activity and transaction logs.
*   **🔐 Local Vault Encryption**:
    *   Private keys and mnemonics are encrypted with AES-GCM (ethers.js Keystore standard) in `~/.my-cli-wallet/`.
    *   Never leaves your device unencrypted.
*   **🔌 WalletConnect v2 Integration**:
    *   Connect to web3 dApps (Uniswap, PancakeSwap, Aave, OpenSea) directly from the CLI via `wc:...` pairing URIs.
*   **☁️ Automated Cloud Backups**:
    *   Seamless backup to Google Drive or Rclone remote on wallet updates.

---

## 🛠️ Installation

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/multi-wallet-cli.git
cd multi-wallet-cli

# 2. Install dependencies
npm install

# 3. (Optional) Link binaries globally
npm link
```

---

## 🚀 Running the Application

### 1. Interactive Command Line Interface (CLI)
```bash
my-wallet
# or
node cli.js
```
*   **Direct dApp Pairing**: `my-wallet "wc:..."`
*   **Verbose Debugging**: `my-wallet -v`

### 2. Brand New Professional Terminal Dashboard (TUI)
```bash
my-wallet-tui
# or
node tui.js
```

#### TUI Keyboard Shortcuts:
*   `[Tab]` / `[Shift+Tab]`: Cycle through views
*   `[1]` to `[6]`: Instant jump to tab (Portfolio, Swap/Bridge, Chains, Transfer, Wallets, Logs)
*   `[r]`: Refresh / Auto-scan multi-chain portfolio
*   `[s]`: Quick jump to Swap & Bridge
*   `[f]`: Change source chain & token (in Swap tab)
*   `[t]`: Change destination chain & token (in Swap tab)
*   `[a]`: Set input amount (in Swap tab)
*   `[q]`: Fetch live quote (in Swap tab)
*   `[x]`: Execute swap / bridge transaction
*   `[p]`: Test RPC ping latency (in Chains tab)
*   `[Escape]` / `[Ctrl+C]`: Exit application

---

## 📂 Project Architecture

```
├── chains.js         # 260+ EVM chains registry, search, RPC failover & latency tester
├── portfolio.js      # Automatic token discovery (Blockscout + Multicall3) & DefiLlama pricing
├── swapBridge.js     # Multi-chain swap & cross-chain bridge engine with live estimation
├── core.js           # Shared state, backwards-compatible NETWORKS map, wallet crypto
├── cli.js            # Inquirer-based CLI entry point with multi-chain & swap/bridge upgrades
├── tui.js            # Brand new professional blessed-based Terminal User Interface
├── drive.js          # Google Drive & Rclone automated vault backup integration
├── data/
│   └── chains.json   # High-performance local database of 260 curated EVM chains
└── package.json
```

---

## 🛡️ Security

*   **Zero Server Dependency**: Operates entirely client-side on your local machine / Termux.
*   **Encrypted Storage**: Uses industry-standard PBKDF2/scrypt key derivation and AES encryption.
*   **Self-Custodial**: Your keys, your crypto.

---

## 📜 License

ISC
