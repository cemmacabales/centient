export const CELO_MAINNET = {
  id: 42220,
  name: "Celo",
  rpcUrl: "https://forno.celo.org",
  explorer: "https://celoscan.io",
};

export const CELO_SEPOLIA = {
  id: 11142220,
  name: "Celo Sepolia",
  rpcUrl: "https://forno.celo-sepolia.celo-testnet.org",
  explorer: "https://celo-sepolia.blockscout.com",
};

// cUSD on Celo Mainnet — 18 decimals.
export const CUSD_MAINNET = "0x765DE816845861e75A25fCA122bb6898B8B1282a" as const;

// USDC on Celo Mainnet — 6 decimals. Reference only; v1 pays in cUSD.
export const USDC_MAINNET = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;

export const REWARD_CUSD = process.env.REWARD_CUSD ?? "0.05";
