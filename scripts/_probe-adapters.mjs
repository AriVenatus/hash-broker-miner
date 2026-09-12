// Internal helper, not meant to be run directly: prints the adapter list
// as JSON and exits immediately. Run as a short-lived child process (see
// listAdapters() in src/gpuDiscovery.mjs) so the throwaway Dawn instance
// used only to trigger the "Available adapters" error is fully torn down
// (by process exit) before the real mining process creates its own — two
// live Dawn instances in one process were observed to crash intermittently.
import { create } from 'webgpu';

const PROBE_ADAPTER_NAME = '__hash_broker_probe__';
const LIST_LINE = /backend:\s*'([^']+)',\s*name:\s*'([^']*)'/;

const gpu = create([`adapter=${PROBE_ADAPTER_NAME}`]);
try {
  await gpu.requestAdapter();
  process.stdout.write(JSON.stringify([]));
} catch (error) {
  const adapters = [];
  for (const line of String(error?.message || '').split('\n')) {
    const match = line.match(LIST_LINE);
    if (match) adapters.push({ backend: match[1], name: match[2] });
  }
  process.stdout.write(JSON.stringify(adapters));
}
process.exit(0);
