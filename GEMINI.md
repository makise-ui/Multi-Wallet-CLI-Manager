# Multi-Wallet CLI Manager Pro

## Project Overview
The **Multi-Wallet CLI Manager Pro** is a modern Node.js-based terminal workstation designed to securely manage multiple cryptocurrency wallets. It provides a headless environment to perform blockchain operations across **260+ EVM chains**, execute multi-chain swaps and cross-chain bridges with live route & output estimations, auto-detect tokens across networks, interact with dApps via WalletConnect v2, and monitor portfolio balances directly from the terminal.

The project features two distinct user interfaces:
- A standard interactive command-line interface (`cli.js`) built with `inquirer`.
- A brand new, highly professional terminal user interface (TUI) (`tui.js`) built from the ground up with `blessed` and `blessed-contrib`.

**Key Features:**
- **260+ EVM Chains Support:** Bundled with a verified registry (`data/chains.json` & `chains.js`) covering Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, Avalanche, Linea, Blast, Scroll, zkSync Era, Mantle, Celo, Gnosis, Sonic, Berachain, and 240+ more with high-availability fallback RPCs and search.
- **Automated Portfolio & Token Detection:** Auto-discovers ERC-20 token holdings via Blockscout v2 indexers and Multicall3 batch queries, enriched with real-time USD pricing from DefiLlama.
- **Swap & Cross-Chain Bridge Engine:** Aggregates 36 DEXs and 36 cross-chain bridges via LI.FI & smart routing. Computes live input/output estimates, minimum received, exchange rates, gas costs, bridge fees, and estimated execution duration.
- **Local Secure Storage:** Wallets are encrypted using AES (via `ethers.js`) and stored locally in the `~/.my-cli-wallet/` directory.
- **WalletConnect v2 Integration:** Allows connecting to web3 dApps and approving/signing transactions directly from the CLI.
- **Cloud Backups:** Integration with Google Drive Native API and `rclone` for automated secure vault backups.

## Building and Running

### Prerequisites
- Node.js installed.
- A WalletConnect Project ID (from cloud.walletconnect.com) to use dApp connections. Stored in `~/.my-cli-wallet/.env`.

### Installation
1. Install project dependencies:
   ```bash
   npm install
   ```
2. (Optional) Link the commands globally:
   ```bash
   npm link
   ```

### Running the Application
The package defines two binaries, which can be run if globally linked or directly via node:

- **Standard CLI:**
  ```bash
  my-wallet
  # or
  node cli.js
  ```
- **Brand New Web Analytics Dashboard:**
  ```bash
  my-wallet-web
  # or
  node web.js
  # opens http://localhost:3000
  ```

### Password Security & Read-Only Policy
- **No Password Required for Read-Only Operations:** Scanning portfolios, checking balances, exploring 260+ chains, listing wallets, getting swap/bridge quotes, and opening the Web Dashboard or TUI **never** prompt for a password. Public addresses are extracted directly from keystore metadata without decrypting.
- **Password Required ONLY for Mutating Actions:** Master password is only prompted when signing on-chain transactions (Transfers, Swaps, Bridges), revealing private keys, or creating/importing wallets.
- **Web Dashboard is 100% Read-Only:** Private keys are never loaded into memory by the web server.

## Development Conventions

- **Module System:** The project uses modern ES Modules (`"type": "module"` in `package.json`).
- **Dependencies:** Heavily relies on `ethers.js` (v6) for cryptography, wallet generation, and RPC interactions. `inquirer` is used for the CLI flow, `blessed`/`blessed-contrib` for TUI, and `@walletconnect/sign-client` for session management.
- **State Management:** Wallet encrypted states and user settings are persisted in `.json` files inside the user's home directory (`~/.my-cli-wallet/my_wallets.json` and `settings.json`).
- **Separation of Concerns:**
  - `chains.js`: 260+ EVM chains catalog, dynamic search, provider caching with fallback RPCs, and ping latency testing.
  - `portfolio.js`: Multi-chain automated token discovery (RouteScan + Multicall3), DefiLlama pricing engine, and persistent SWR cache.
  - `swapBridge.js`: Cross-chain bridge & swap routing, live quote estimations, ERC-20 allowances, and transaction broadcasting.
  - `cli.js`: Main interactive CLI entry point with multi-chain selection, portfolio scanner, and swap/bridge workflows.
  - `tui.js`: Highly responsive terminal dashboard with tabbed views (Portfolio, Swap/Bridge, Chains, Transfer, Wallets, Logs).
  - `web.js` / `public/`: Web Analytics Dashboard with interactive charts, network breakdown, and CSV export.
  - `core.js`: Backwards-compatible network definitions, shared encryption wrappers, settings, and public wallet helpers.
  - `drive.js`: Cloud backup and restore/import logic for Google Drive and Rclone integrations, with automatic cloud backup detection on launch.

Always preserve the vault encryption mechanisms when modifying wallet handling logic.
