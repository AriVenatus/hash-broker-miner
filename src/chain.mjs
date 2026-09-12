import { ethers } from 'ethers';
import { CONFIG, SELECTORS } from './config.mjs';

export function getProvider() {
  return new ethers.JsonRpcProvider(CONFIG.RPC_URL, {
    chainId: CONFIG.CHAIN_ID_DECIMAL,
    name: CONFIG.CHAIN_NAME || 'robinhood-chain'
  });
}

export function getWallet(provider) {
  const key = process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'PRIVATE_KEY is not set. Export it in your shell or put it in a local .env file (see .env.example).'
    );
  }
  return new ethers.Wallet(key, provider);
}

async function contractCall(provider, selector) {
  const hex = await provider.call({ to: CONFIG.CONTRACT_ADDRESS, data: selector });
  if (!hex || hex === '0x') throw new Error('The contract returned an empty value.');
  return BigInt(hex);
}

// Mirrors app.js's refreshState(): reads supply, price, difficulty and the
// current challenge in one shot.
export async function readState(provider) {
  const [totalSupply, mintPriceWei, difficulty, challenge] = await Promise.all([
    contractCall(provider, SELECTORS.totalSupply),
    contractCall(provider, SELECTORS.mintPrice),
    contractCall(provider, SELECTORS.currentDifficulty),
    provider.call({ to: CONFIG.CONTRACT_ADDRESS, data: SELECTORS.challenge })
  ]);
  return {
    totalSupply: Number(totalSupply),
    mintPriceWei,
    difficulty: Number(difficulty),
    challenge
  };
}

function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}

// Builds the exact same calldata app.js sends for mine(uint256 nonce, bytes32 challenge).
export function buildMineCalldata(nonce, challengeHex) {
  return SELECTORS.mine + encodeUint256(nonce) + challengeHex.slice(2);
}

export async function submitMine(wallet, { nonce, challenge, mintPriceWei }) {
  const data = buildMineCalldata(nonce, challenge);
  const tx = await wallet.sendTransaction({
    to: CONFIG.CONTRACT_ADDRESS,
    value: mintPriceWei,
    data
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error('The mint transaction reverted.');
  return receipt;
}
