// Owns one BrowserMiner (headless Chrome instance) and runs it against
// the current mining job. Previously this discovered and pooled one
// native GpuMiner per physical GPU adapter -- that approach was dropped
// after repeated, distinct native crashes on real hardware (see README's
// caveats section). A single headless Chrome instance uses whatever GPU
// the system/driver exposes by default; there's no clean way to pin
// multiple Chrome instances to different physical GPUs, so multi-GPU
// support is out of scope for now. mineWithPool() below still operates
// on a generic list of {label, miner} entries, so it works unchanged
// whether that list has one entry or (in the future) several.
import { BrowserMiner } from './browserMiner.mjs';

export async function buildPool(log = console.log) {
  const label = 'GPU 0';
  const miner = new BrowserMiner({}, { label });
  const gpuName = await miner.init();
  log(`[${label}] ready: ${gpuName}`);
  log('Mining pool ready: 1 device (headless Chrome).\n');
  return [{ label, miner }];
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
          entry.miner.close?.().catch(() => {});
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
