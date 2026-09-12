// Diagnostic only: constructs GpuMiner exactly like scripts/selftest.mjs
// does (no backend/adapterName -> create([]) with no flags), bypassing
// src/pool.mjs's discovery-driven adapter pinning entirely. Used to
// isolate whether passing `adapter=<name>` (a string that can contain
// spaces, e.g. "NVIDIA GeForce RTX 4090") to Dawn's create() is the cause
// of a native crash reproduced on real hardware — see the README's
// caveats section for the full incident history.
import { GpuMiner } from '../src/gpuMiner.mjs';

const BATCHES = Number(process.env.BENCH_BATCHES || 1);

const miner = new GpuMiner({
  onProgress: (p) => {
    console.log(`batch ${p.totalHashes.toLocaleString()} hashes, best ${p.bestBits} bits`);
  },
  onFound: () => console.log('(found — harmless at this difficulty)'),
  onError: (error) => {
    console.error('GPU error:', error.message);
    process.exit(1);
  }
}); // <-- no options: this.backend/this.adapterName stay undefined, so
    //     init() calls create([]) with zero flags, same as selftest.mjs

const gpuName = await miner.init();
console.log('GPU (unpinned, default adapter selection):', gpuName);

let seen = 0;
miner.callbacks.onProgress = (p) => {
  seen++;
  console.log(`batch ${seen}/${BATCHES}: ${p.totalHashes.toLocaleString()} hashes, best ${p.bestBits} bits`);
  if (seen >= BATCHES) miner.stop();
};

miner.setJob({
  address: '0x1111111111111111111111111111111111111111',
  challenge: '0x' + '42'.repeat(32),
  difficulty: 62 // effectively unreachable, so BATCHES real dispatches always happen
});

await miner.start();
console.log(`Done: ${seen}/${BATCHES} batches completed without crashing.`);
process.exit(0);
