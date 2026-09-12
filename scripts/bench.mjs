// Runs a handful of real-size batches on every GPU the pool discovers
// (no wallet, no network, nothing on-chain) so you can see your actual
// per-GPU and combined hashrate — and confirm your drivers handle the
// configured batch size — before trusting `npm start` to run unattended
// with a funded wallet.
import { buildPool } from '../src/pool.mjs';

const BATCHES = Number(process.env.BENCH_BATCHES || 6);

console.log('Detecting GPUs...');
const pool = await buildPool(console.log);

const done = new Set();
await Promise.all(
  pool.map(
    ({ label, miner }) =>
      new Promise((resolve) => {
        let seen = 0;
        miner.callbacks = {
          onProgress: (p) => {
            seen++;
            console.log(
              `[${label}] batch ${seen}/${BATCHES}: ${(p.hashrate / 1e6).toFixed(2)} MH/s | ` +
              `${p.totalHashes.toLocaleString()} hashes | best ${p.bestBits} bits`
            );
            if (seen >= BATCHES) {
              miner.stop();
              done.add(label);
            }
          },
          onFound: () => console.log(`[${label}] (found a matching proof early — the dummy target is easy on purpose)`),
          onError: (error) => {
            console.error(`[${label}] GPU error: ${error.message}`);
            resolve();
          }
        };
        miner.setJob({
          address: '0x1111111111111111111111111111111111111111',
          challenge: '0x' + '42'.repeat(32),
          difficulty: 30 // arbitrary — only used to exercise the pipeline, not a real target
        });
        miner.start().then(resolve).catch((error) => {
          console.error(`[${label}] GPU error: ${error.message}`);
          resolve();
        });
      })
  )
);

console.log(`\n${done.size}/${pool.length} GPU(s) completed without crashing.`);
console.log('If the hashrates above look sane for your hardware, you\'re good to run "npm start".');
process.exit(done.size === pool.length ? 0 : 1);
