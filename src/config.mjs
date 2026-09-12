// Mirrors https://www.hashbroker.fun/config.js and the selectors used by
// its app.js, read directly from the live site's own bundles. Overridable
// via env vars in case the project redeploys the contract.

export const CONFIG = Object.freeze({
  RPC_URL: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com/',
  CHAIN_ID_DECIMAL: Number(process.env.CHAIN_ID_DECIMAL || 4663),
  CHAIN_NAME: 'robinhood-chain',
  CONTRACT_ADDRESS: process.env.CONTRACT_ADDRESS || '0x4272D6f51771839F596082eF48fa84D35239Bab3',
  EXPLORER_URL: process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com',
  MAX_SUPPLY: 4444
});

// 4-byte selectors as used verbatim by the official front-end (app.js).
// Read directly rather than recomputed from guessed function signatures,
// so a naming mismatch can't silently produce the wrong selector.
export const SELECTORS = Object.freeze({
  totalSupply: '0x18160ddd',
  mintPrice: '0x6817c76c',
  challenge: '0xd2ef7398',
  currentDifficulty: '0x5c062d6c',
  mine: '0xe43e322c'
});
