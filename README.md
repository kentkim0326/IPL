# IPL Holdem 🃏

> Anonymous · Crypto · Global Poker

## Architecture

```
index.html (GitHub Pages / Vercel)
    ↕ WalletConnect (Ethers.js)
    ↕ Socket.io
server/index.js (Railway)
    ↕
contract/IPLHoldem.sol (Base Sepolia → Mainnet)
```

## Deploy Steps

### 1. Smart Contract (Base Sepolia)
- Remix IDE: remix.ethereum.org
- Open `contract/IPLHoldem.sol`
- Compile: Solidity 0.8.20
- Deploy to Base Sepolia:
  - _usdc: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
  - _gameServer: your Railway server address
- Copy contract address → paste in `index.html` → `STATE.contractAddress`

### 2. Game Server (Railway)
```bash
cd server
railway init
railway up
```
Copy Railway URL → paste in `index.html` → `SOCKET_URL`

### 3. Frontend (GitHub Pages)
- Already deployed at: https://ipl-beta-khaki.vercel.app
- Update `index.html` with contract + server addresses
- Push to GitHub → auto deploy

## Fee Structure
- Cash Game Rake: 3% (cap $3)
- SNG: 10% of buy-in
- Referral L1: 1.5%
- Referral L2: 0.5%

## Tech Stack
| Layer | Tech |
|-------|------|
| Frontend | Vanilla HTML/JS (no framework) |
| Wallet | Ethers.js v6 |
| Realtime | Socket.io |
| Blockchain | Base Chain (Sepolia testnet) |
| Payment | USDC |
| Contract | Solidity 0.8.20 |
| Hosting | Vercel (free) |
| Server | Railway (free tier) |
