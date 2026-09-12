// SHA-256 proof-of-work compute shader, copied verbatim (algorithm and
// message layout) from the official site's miner.js so proofs it finds are
// guaranteed to match what the on-chain contract verifies. Correctness is
// checked against Node's own crypto module in scripts/selftest.mjs.

// Same batch shape as the official site's own browser miner (miner.js).
//
// This value has moved around during development based on real-hardware
// crash reports (RTX 4090) in the `webgpu` (Dawn) Node addon, and the
// full story matters for whoever tunes this next:
//   - ITERATIONS=128 (this value): ran fine initially, but was observed to
//     abort after some time mining with a glibc
//     "pthread_mutex_lock.c:94 ... assertion failed: mutex->__data.__owner
//     == 0" — looked like a threading bug tied to sustained high-frequency
//     dispatch (~116 JS<->native round-trips/sec at ~977 MH/s).
//   - ITERATIONS=2048 (tried as a fix, reverted): raising ITERATIONS is a
//     loop entirely *inside* the shader, so the theory was fewer, bigger
//     dispatches per second would dodge the frequency-related bug for
//     free. Instead it crashed on the *first* dispatch, before any
//     progress was even reported — a difference kind of failure, and
//     immediate/reproducible rather than time-dependent. That rules out
//     the frequency theory and means larger dispatches hit a different,
//     apparently harder failure mode in this same native addon.
// Net: neither value is proven stable long-term on real hardware yet.
// Back to the site's original proven value pending real bench data (see
// deploy/README.md's "Tuning the batch size" — run `npm run bench` with
// BENCH_BATCHES=200 at a few values on your actual GPU) rather than
// guessing again without hardware to verify on. Supervisor's autorestart
// (see deploy/vast-onstart.sh) is the safety net either way.
export const WORKGROUP_SIZE = 256;
export const WORKGROUPS = 256;
export const ITERATIONS = 128;
export const HASHES_PER_BATCH = WORKGROUP_SIZE * WORKGROUPS * ITERATIONS;

export function buildShader({ workgroupSize = WORKGROUP_SIZE, iterations = ITERATIONS } = {}) {
  return /* wgsl */ `
const K: array<u32, 64> = array<u32, 64>(
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
);

struct Params { values: array<u32, 16> }
struct Result {
  found: atomic<u32>,
  nonceLo: atomic<u32>,
  nonceHi: atomic<u32>,
  bestBits: atomic<u32>,
  bestHash: array<atomic<u32>, 8>
}

@group(0) @binding(0) var<storage, read> params: Params;
@group(0) @binding(1) var<storage, read_write> result: Result;

fn rotr(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn ch(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ ((~x) & z); }
fn maj(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (x & z) ^ (y & z); }
fn big0(x: u32) -> u32 { return rotr(x,2u) ^ rotr(x,13u) ^ rotr(x,22u); }
fn big1(x: u32) -> u32 { return rotr(x,6u) ^ rotr(x,11u) ^ rotr(x,25u); }
fn small0(x: u32) -> u32 { return rotr(x,7u) ^ rotr(x,18u) ^ (x >> 3u); }
fn small1(x: u32) -> u32 { return rotr(x,17u) ^ rotr(x,19u) ^ (x >> 10u); }

fn compress(inputState: array<u32,8>, block: array<u32,16>) -> array<u32,8> {
  var w: array<u32,64>;
  for (var i=0u; i<16u; i=i+1u) { w[i] = block[i]; }
  for (var i=16u; i<64u; i=i+1u) {
    w[i] = small1(w[i-2u]) + w[i-7u] + small0(w[i-15u]) + w[i-16u];
  }
  var a=inputState[0]; var b=inputState[1]; var c=inputState[2]; var d=inputState[3];
  var e=inputState[4]; var f=inputState[5]; var g=inputState[6]; var h=inputState[7];
  for (var i=0u; i<64u; i=i+1u) {
    let t1 = h + big1(e) + ch(e,f,g) + K[i] + w[i];
    let t2 = big0(a) + maj(a,b,c);
    h=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }
  return array<u32,8>(
    inputState[0]+a,inputState[1]+b,inputState[2]+c,inputState[3]+d,
    inputState[4]+e,inputState[5]+f,inputState[6]+g,inputState[7]+h
  );
}

fn digest(nonceLo: u32, nonceHi: u32) -> array<u32,8> {
  var first: array<u32,16>;
  first[0]=params.values[0]; first[1]=params.values[1]; first[2]=params.values[2];
  first[3]=params.values[3]; first[4]=params.values[4];
  first[5]=0u; first[6]=0u; first[7]=0u; first[8]=0u; first[9]=0u; first[10]=0u;
  first[11]=nonceHi; first[12]=nonceLo;
  first[13]=params.values[5]; first[14]=params.values[6]; first[15]=params.values[7];

  var state = array<u32,8>(
    0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
    0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u
  );
  state = compress(state, first);

  var second: array<u32,16>;
  second[0]=params.values[8]; second[1]=params.values[9]; second[2]=params.values[10];
  second[3]=params.values[11]; second[4]=params.values[12]; second[5]=0x80000000u;
  second[6]=0u; second[7]=0u; second[8]=0u; second[9]=0u; second[10]=0u;
  second[11]=0u; second[12]=0u; second[13]=0u; second[14]=0u; second[15]=672u;
  return compress(state, second);
}

fn leadingZeros(hash: array<u32,8>) -> u32 {
  var count = 0u;
  for (var i=0u; i<8u; i=i+1u) {
    if (hash[i] == 0u) { count = count + 32u; }
    else { count = count + countLeadingZeros(hash[i]); return count; }
  }
  return 256u;
}

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let startLo = params.values[13];
  let startHi = params.values[14];
  let offsetBase = gid.x * ${iterations}u;
  for (var i=0u; i<${iterations}u; i=i+1u) {
    if (atomicLoad(&result.found) != 0u) { return; }
    let offset = offsetBase + i;
    let nonceLo = startLo + offset;
    let carry = select(0u, 1u, nonceLo < startLo);
    let nonceHi = startHi + carry;
    let hash = digest(nonceLo, nonceHi);
    let bits = leadingZeros(hash);
    let previousBest = atomicMax(&result.bestBits, bits);
    if (bits > previousBest) {
      for (var word = 0u; word < 8u; word = word + 1u) {
        atomicStore(&result.bestHash[word], hash[word]);
      }
    }
    if (bits >= params.values[15]) {
      let previous = atomicExchange(&result.found, 1u);
      if (previous == 0u) {
        atomicStore(&result.nonceLo, nonceLo);
        atomicStore(&result.nonceHi, nonceHi);
      }
      return;
    }
  }
}`;
}
