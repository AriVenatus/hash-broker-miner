// Dawn (via the `webgpu` package) has no standard WebGPU API for listing
// every physical adapter — but asking it for an adapter name that doesn't
// exist makes it throw an error whose message contains the full list of
// what it *did* find. That's the only enumeration mechanism this binding
// exposes, so we use it deliberately rather than working around it.
//
// This probe runs in a short-lived child process rather than in-process:
// two live Dawn instances coexisting in one process (the throwaway probe
// instance plus the real mining one) were observed to abort the process
// with a native "std::system_error: Invalid argument" — a stability limit
// of this binding, not something we can fix from the JS side. Running the
// probe as its own process guarantees its Dawn instance is fully gone
// (the process exited) before the real one is created.
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROBE_SCRIPT = fileURLToPath(new URL('../scripts/_probe-adapters.mjs', import.meta.url));

export const SOFTWARE_ADAPTER_PATTERN = /llvmpipe|swiftshader|software|basic render|lavapipe/i;

// Returns an array of { backend, name } for every adapter Dawn can see on
// this machine, across every backend it supports on the current platform
// (vulkan on Linux, metal on macOS, d3d12 on Windows, etc.) — or null if
// the probe didn't return a usable list, in which case the caller should
// fall back to plain default adapter selection instead of assuming
// anything about what's installed.
export async function listAdapters() {
  try {
    const { stdout } = await execFileAsync(process.execPath, [PROBE_SCRIPT], { encoding: 'utf8' });
    const adapters = JSON.parse(stdout);
    return Array.isArray(adapters) && adapters.length ? adapters : null;
  } catch {
    return null;
  }
}

// Decides which discovered adapters to actually mine on: prefer real GPUs
// over software fallbacks, and drop adapters whose (backend, name) pair is
// a duplicate — this binding selects adapters by name string, so two
// identically-named entries (e.g. two identical GPU models) can't be told
// apart, and instantiating both would just run the same physical device
// twice rather than add throughput.
export function chooseAdapters(adapters, { log = () => {} } = {}) {
  if (!adapters || adapters.length === 0) {
    log('Could not enumerate adapters individually; falling back to the default WebGPU adapter selection.');
    return [{ backend: undefined, name: undefined }];
  }

  log(`Found ${adapters.length} WebGPU adapter(s) on this system:`);
  adapters.forEach((a, i) => {
    const flag = SOFTWARE_ADAPTER_PATTERN.test(a.name) ? '  [software]' : '';
    log(`  - backend=${a.backend} name="${a.name}"${flag}`);
  });

  const hardware = adapters.filter((a) => !SOFTWARE_ADAPTER_PATTERN.test(a.name));
  const pool = hardware.length > 0 ? hardware : adapters;
  if (hardware.length === 0) {
    log('WARNING: every adapter Dawn found looks like a software/CPU fallback — no real GPU was detected.');
  } else if (hardware.length < adapters.length) {
    log(`Ignoring ${adapters.length - hardware.length} software adapter(s); mining on the ${hardware.length} real GPU(s) only.`);
  }

  const seen = new Set();
  const selected = [];
  for (const a of pool) {
    const key = `${a.backend}::${a.name}`;
    if (seen.has(key)) {
      log(`  Skipping a duplicate "${a.name}" (backend ${a.backend}) — cannot be pinned separately from the one already selected.`);
      continue;
    }
    seen.add(key);
    selected.push(a);
  }
  return selected;
}
