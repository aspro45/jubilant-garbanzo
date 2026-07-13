# Mintline Global Scanner

Mintline is a live NFT mint scanner for Robinhood Chain Mainnet. It follows the mainnet Blockscout transfer index for reliable discovery, then enriches the selected collection with lightweight on-chain contract reads.

It does **not** deploy a contract and it does **not** ask for a wallet connection.

## What counts as a mint?

Mintline watches standard token transfer events where the sender is the zero address:

- ERC-721 `Transfer(0x0, recipient, tokenId)`
- ERC-1155 `TransferSingle(..., 0x0, recipient, id, value)`
- ERC-1155 `TransferBatch(..., 0x0, recipient, ids, values)`

Each live feed item links to the exact transaction on the Robinhood Chain explorer. Collection names, images, descriptions, supply, and holder counts come from indexed token metadata when available. The selected collection also checks common `totalSupply` and max-supply contract methods so Mintline can show real mint progress.

## Run locally

```bash
npm.cmd install
npm.cmd run dev
```

Open the URL printed by Vite. The scanner starts automatically with a 150-event buffer and checks for fresh indexed mints every five seconds.

## Controls

- Search by collection name, symbol, contract, minter wallet, or token ID.
- Filter ERC-721 or ERC-1155 activity.
- Change the history buffer to 50, 150, or 300 mint events.
- Click a collection to inspect its artwork, supply progress, holders, minters, and recent mint transactions.
- Pause the stream or trigger a full rescan.

## Build

```bash
npm.cmd run build
```

## Network

- Chain ID: `4663`
- Public RPC: `https://rpc.mainnet.chain.robinhood.com`
- Explorer: `https://robinhoodchain.blockscout.com`
- Indexed mint stream: `https://robinhoodchain.blockscout.com/api/v2/token-transfers`

The public RPC is rate-limited, so it is not the primary event stream. If an optional contract read is rejected, the live explorer-indexed mints, token images, supply, and holder data continue working.
