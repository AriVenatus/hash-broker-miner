// Owns one GpuMiner per physical GPU and runs them all against the same
// mining job concurrently — whichever one finds a valid proof first wins.
import { GpuMiner } from './gpuMiner.mjs';
import { listAdapters, chooseAdapters } from './gpuDiscovery.mjs';

export async function buildPool(log = console.log) {
  let adapters = null;
  try {
    adapters = await listAdapters();
  } catch (error) {
    log(`Adapter discovery failed (${error.message}); falling back to the default adapter.`);
  }

  let selections = chooseAdapters(adapters, { log });
  const maxGpus = Number(process.env.MINER_MAX_GPUS || 0);
  if (maxGpus > 0 && selections.length > maxGpus) {
    log(`MINER_MAX_GPUS=${maxGpus}: using the first ${maxGpus} of ${selections.length} selected adapter(s).`);
    selections = selections.slice(0, maxGpus);
  }

  const entries = [];
  for (let i = 0; i < selections.length; i++) {
    const sel = selections[i];
    const label = `GPU ${i}`;
    const miner = new GpuMiner({}, { backend: sel.backend, adapterName: sel.name, label });
    try {
      const gpuName = await miner.init();
      log(`[${label}] ready: ${gpuName}`);
      entries.push({ label, miner });
    } catch (error) {
      log(`[${label}] failed to initialize (${error.message}); skipping it.`);
    }
  }

  if (entries.length === 0) throw new Error('No usable GPU adapter could be initialized.');
  log(`Mining pool ready: ${entries.length} device(s).\n`);
  return entries;
}

// Runs `job` on every entry in the pool concurrently until one finds a
// proof, the chain state moves out from under us, or we're asked to stop.
// A GPU that errors mid-run is dropped from `entries` in place so future
// rounds don't retry a device that's already known to be broken.
export function mineWithPool(entries, provider, job, { readState, pollMs, onStatus, isShuttingDown }) {
  return new Promise((resolve) => {
    let settled = false;
    const perGpu = new Map();

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      for (const { miner } of entries) miner.stop();
      resolve(result);
    };

    const report = () => onStatus?.(perGpu, job);

    for (const entry of entries) {
      entry.miner.callbacks = {
        onProgress: (progress) => {
          perGpu.set(entry.label, progress);
          report();
        },
        onFound: ({ nonce }) => finish({ status: 'found', nonce, label: entry.label }),
        onError: (error) => {
          onStatus?.(perGpu, job, `[${entry.label}] error: ${error.message} — dropping this GPU from the pool.`);
          entry.miner.stop();
          const index = entries.indexOf(entry);
          if (index !== -1) entries.splice(index, 1);
          if (entries.length === 0) finish({ status: 'error', error });
        }
      };
    }

    const poller = setInterval(async () => {
      if (isShuttingDown?.()) {
        finish({ status: 'stopped' });
        return;
      }
      try {
        const state = await readState(provider);
        if (state.challenge !== job.challenge || state.difficulty !== job.difficulty) {
          finish({ status: 'stale', state });
        }
      } catch {
        // transient RPC hiccup — ignore, the next poll retries
      }
    }, pollMs);

    for (const entry of entries) {
      entry.miner.setJob({ address: job.address, challenge: job.challenge, difficulty: job.difficulty });
      entry.miner.start().catch((error) => entry.miner.callbacks.onError(error));
    }
  });
}
