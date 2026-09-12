// Verifies the mining algorithm's SHA-256 output against Node's own
// crypto module for a real (randomized) nonce, run through the actual
// production code path -- headless Chrome via BrowserMiner -- rather
// than a separate hand-rolled check. Run with: npm run selftest
import crypto from 'node:crypto';
import { BrowserMiner } from '../src/browserMiner.mjs';

const address = '0x' + '11'.repeat(20);
const challenge = '0x' + '42'.repeat(32);

let settled = false;
const miner = new BrowserMiner(
  {
    onProgress: (p) => {
      if (settled) return;
      settled = true;
      miner.stop();
      verify(p);
    },
    onError: (error) => {
      console.error('Error:', error.message);
      process.exit(1);
    }
  },
  { workgroupSize: 1, workgroups: 1, iterations: 1 } // one hash per batch -> nonceLo/nonceHi unambiguously identify it
);

function verify({ currentHash, nonceLo, nonceHi }) {
  const message = Buffer.concat([
    Buffer.from(address.slice(2), 'hex'),
    Buffer.alloc(24, 0),
    Buffer.from([(nonceHi >>> 24) & 0xff, (nonceHi >>> 16) & 0xff, (nonceHi >>> 8) & 0xff, nonceHi & 0xff]),
    Buffer.from([(nonceLo >>> 24) & 0xff, (nonceLo >>> 16) & 0xff, (nonceLo >>> 8) & 0xff, nonceLo & 0xff]),
    Buffer.from(challenge.slice(2), 'hex')
  ]);
  const cpuHash = '0x' + crypto.createHash('sha256').update(message).digest('hex');

  console.log('GPU hash:', currentHash);
  console.log('CPU hash:', cpuHash);
  miner
    .close()
    .catch(() => {})
    .finally(() => {
      if (currentHash !== cpuHash) {
        console.error('MISMATCH — do not mine for real until this passes.');
        process.exit(1);
      }
      console.log('OK: mining algorithm matches SHA-256 reference implementation.');
      process.exit(0);
    });
}

const gpuName = await miner.init();
console.log('GPU (via headless Chrome):', gpuName);

// difficulty 0 matches on the very first (only, since workgroups=
// workgroupSize=iterations=1) hash unconditionally -- deterministic,
// rather than relying on this specific random hash happening to improve
// on a "best so far" that starts at 0 (a coin flip, since a hash whose
// own leading-zero count is exactly 0 would otherwise never get written
// to the GPU-side buffer this reads back -- see the shader.mjs comment
// on the found-branch's unconditional bestHash write).
miner.setJob({ address, challenge, difficulty: 0 });
miner.start().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
