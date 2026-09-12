import 'dotenv/config';
import { buildPool, mineWithPool } from './pool.mjs';
import { getProvider, getWallet, readState, submitMine } from './chain.mjs';
import { CONFIG } from './config.mjs';

const POLL_MS = 8000; // matches the official site's own refresh interval
const PROGRESS_LOG_MS = 5000;

let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  console.log('\nStopping after the current batch... (press Ctrl+C again to force quit)');
});

function formatRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return '0 H/s';
  if (rate >= 1e9) return `${(rate / 1e9).toFixed(2)} GH/s`;
  if (rate >= 1e6) return `${(rate / 1e6).toFixed(1)} MH/s`;
  if (rate >= 1e3) return `${(rate / 1e3).toFixed(1)} KH/s`;
  return `${Math.round(rate)} H/s`;
}

function formatEther(wei) {
  if (wei === 0n) return 'FREE';
  return `${Number(wei) / 1e18} ETH`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

let lastStatusLog = 0;
function logStatus(perGpu, job, immediateMessage) {
  if (immediateMessage) console.log(`  ${immediateMessage}`);
  const now = Date.now();
  if (!immediateMessage && now - lastStatusLog < PROGRESS_LOG_MS) return;
  lastStatusLog = now;

  let totalRate = 0;
  let totalHashes = 0;
  let bestBits = 0;
  const lines = [];
  for (const [label, p] of perGpu) {
    totalRate += p.hashrate;
    totalHashes += p.totalHashes;
    bestBits = Math.max(bestBits, p.bestBits);
    lines.push(`${label} ${formatRate(p.hashrate)}`);
  }
  if (lines.length === 0) return;
  const meanSeconds = totalRate > 0 ? 2 ** job.difficulty / totalRate : Infinity;
  console.log(
    `  ${lines.join(' | ')} | total ${formatRate(totalRate)} | best ${bestBits}/${job.difficulty} bits | ` +
    `${totalHashes.toLocaleString()} hashes | expected wait ${formatDuration(meanSeconds)}`
  );
}

async function main() {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const balance = await provider.getBalance(wallet.address);

  console.log(`Wallet:   ${wallet.address}`);
  console.log(`Balance:  ${formatEther(balance)} (gas token on ${CONFIG.RPC_URL})`);
  console.log(`Contract: ${CONFIG.CONTRACT_ADDRESS} (chain ${CONFIG.CHAIN_ID_DECIMAL})\n`);

  console.log('Detecting GPUs...');
  let pool = await buildPool(console.log);

  let mintedThisSession = 0;

  while (!shuttingDown) {
    if (pool.length === 0) {
      console.log('All GPUs in the pool have failed. Re-running discovery...');
      pool = await buildPool(console.log);
    }

    const state = await readState(provider);
    if (state.totalSupply >= CONFIG.MAX_SUPPLY) {
      console.log(`Supply cap reached (${state.totalSupply}/${CONFIG.MAX_SUPPLY}). Nothing left to mine.`);
      break;
    }

    console.log(
      `Challenge ${state.challenge.slice(0, 14)}… | difficulty ${state.difficulty} bits | ` +
      `price ${formatEther(state.mintPriceWei)} | supply ${state.totalSupply}/${CONFIG.MAX_SUPPLY} | ` +
      `pool: ${pool.map((e) => e.label).join(', ')}`
    );

    const job = { address: wallet.address, challenge: state.challenge, difficulty: state.difficulty };
    lastStatusLog = 0;
    const result = await mineWithPool(pool, provider, job, {
      readState,
      pollMs: POLL_MS,
      onStatus: logStatus,
      isShuttingDown: () => shuttingDown
    });

    if (result.status === 'stopped') break;
    if (result.status === 'error') {
      console.log(`  All GPUs failed (${result.error.message}). Will retry discovery next round.\n`);
      pool = [];
      continue;
    }
    if (result.status === 'stale') {
      console.log('  Challenge changed before we found a proof (someone else likely won it). Retrying...');
      continue;
    }

    console.log(`  [${result.label}] found a proof (nonce ${result.nonce}). Submitting mint transaction...`);
    try {
      // Re-read price/challenge right before submitting: price can step up
      // as supply grows, and we want the freshest possible quote.
      const fresh = await readState(provider);
      const receipt = await submitMine(wallet, {
        nonce: result.nonce,
        challenge: job.challenge,
        mintPriceWei: fresh.mintPriceWei
      });
      mintedThisSession += 1;
      console.log(`  Minted! tx ${receipt.hash} (session total: ${mintedThisSession})\n`);
    } catch (error) {
      console.log(`  Mint failed or reverted: ${error.message}. Refreshing and retrying.\n`);
    }
  }

  console.log(`Stopped. Minted ${mintedThisSession} broker(s) this session.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error.message || error);
  process.exit(1);
});
