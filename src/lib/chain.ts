import { defineChain } from "viem";

export const ROBINHOOD_CHAIN_ID = 4_663;
export const ROBINHOOD_CHAIN_RPC =
  "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_CHAIN_EXPLORER =
  "https://robinhoodchain.blockscout.com";
export const ROBINHOOD_CHAIN_DOCS =
  "https://docs.robinhood.com/chain/connecting/";

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: [ROBINHOOD_CHAIN_RPC] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: ROBINHOOD_CHAIN_EXPLORER,
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 0,
    },
  },
  testnet: false,
});
