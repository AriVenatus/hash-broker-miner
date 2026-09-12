// Node.js port of the official site's HashBrokerMiner (miner.js), using the
// `webgpu` package (Dawn's native WebGPU implementation) instead of a
// browser's navigator.gpu. Same shader, same job/callback shape.

import { create, globals } from 'webgpu';
import { buildShader, WORKGROUP_SIZE, WORKGROUPS, ITERATIONS } from './shader.mjs';
import { SOFTWARE_ADAPTER_PATTERN } from './gpuDiscovery.mjs';

const { GPUBufferUsage, GPUMapMode } = globals;

function hexWords(hex, expectedWords) {
  const clean = hex.toLowerCase().replace(/^0x/, '');
  if (clean.length !== expectedWords * 8) throw new Error(`Unexpected hex length for ${hex}`);
  const words = [];
  for (let i = 0; i < expectedWords; i++) words.push(parseInt(clean.slice(i * 8, i * 8 + 8), 16) >>> 0);
  return words;
}

export class GpuMiner {
  constructor(callbacks = {}, options = {}) {
    this.callbacks = callbacks;
    this.running = false;
    this.totalHashes = 0;
    this.bestBits = 0;
    this.rateSamples = [];
    // Batch shape is configurable (env vars, falling back to the site's own
    // proven defaults) because dispatch sizes that are safe on real GPU
    // hardware are not guaranteed safe on every backend — see README's
    // "Tuning / hardware notes" section.
    this.workgroupSize = options.workgroupSize ?? Number(process.env.MINER_WORKGROUP_SIZE || WORKGROUP_SIZE);
    this.workgroups = options.workgroups ?? Number(process.env.MINER_WORKGROUPS || WORKGROUPS);
    this.iterations = options.iterations ?? Number(process.env.MINER_ITERATIONS || ITERATIONS);
    this.hashesPerBatch = this.workgroupSize * this.workgroups * this.iterations;
    // Pins this instance to one physical adapter (see src/gpuDiscovery.mjs)
    // so multiple GpuMiners can each own a different GPU. Leave both unset
    // to fall back to Dawn's own default adapter selection.
    this.backend = options.backend;
    this.adapterName = options.adapterName;
    this.label = options.label || 'GPU';
  }

  async init() {
    const flags = [];
    if (this.backend) flags.push(`backend=${this.backend}`);
    if (this.adapterName) flags.push(`adapter=${this.adapterName}`);
    const gpu = create(flags);
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error(`[${this.label}] No compatible GPU adapter was found (Dawn/WebGPU).`);
    this.device = await adapter.requestDevice();
    // NOTE: a `device.lost.then(...)` handler used to be registered here.
    // It was removed as the prime suspect for a native crash (mutex
    // assertion / segfault / "std::system_error: Invalid argument" —
    // classic native-thread-API misuse symptoms) reproduced on a real
    // RTX 4090 even at the smallest possible dispatch, while
    // scripts/selftest.mjs's raw script — which never touches
    // `device.lost` — never crashed. Bridging a *real* GPU driver's
    // device-loss event back into JS plausibly needs native background
    // thread/callback machinery that a software adapter (where this
    // never crashed) never actually exercises. If device-loss detection
    // is needed again, don't re-add a `.then()` here without confirming
    // this addon's `device.lost` implementation is actually safe first.

    const module = this.device.createShaderModule({
      code: buildShader({ workgroupSize: this.workgroupSize, iterations: this.iterations })
    });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === 'error');
    if (errors.length) throw new Error(errors.map((error) => error.message).join('\n'));

    this.pipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.paramsBuffer = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.resultBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.readBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.resultBuffer } }
      ]
    });

    const info = adapter.info || {};
    this.gpuName = info.description || info.architecture || info.device || info.vendor || 'WebGPU device';
    this.isLikelySoftware = SOFTWARE_ADAPTER_PATTERN.test(this.gpuName);
    if (this.isLikelySoftware) {
      console.warn(
        `[${this.label}] WARNING: "${this.gpuName}" looks like a software/CPU WebGPU fallback, not a real ` +
        'GPU. Mining will be extremely slow, and large batch sizes have been observed to crash the ' +
        'process on software backends. Fix your GPU/Vulkan driver setup before mining for real, ' +
        'or lower MINER_WORKGROUPS / MINER_ITERATIONS if you must run on this backend.'
      );
    }
    return this.gpuName;
  }

  setJob({ address, challenge, difficulty }) {
    const addressWords = hexWords(address, 5);
    const challengeWords = hexWords(challenge, 8);
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    this.nonceLo = random[0] >>> 0;
    this.nonceHi = random[1] >>> 0;
    this.difficulty = Number(difficulty);
    this.address = address;
    this.challenge = challenge;
    this.baseParams = [...addressWords, ...challengeWords];
    this.totalHashes = 0;
    this.bestBits = 0;
    this.bestHash = null;
    this.rateSamples = [];
  }

  async start() {
    if (this.running) return;
    if (!this.baseParams) throw new Error('Mining job is not configured.');
    this.running = true;
    while (this.running) await this.runBatch();
  }

  stop() {
    this.running = false;
  }

  async runBatch() {
    const params = new Uint32Array(16);
    params.set(this.baseParams, 0);
    params[13] = this.nonceLo;
    params[14] = this.nonceHi;
    params[15] = this.difficulty;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, params);
    this.device.queue.writeBuffer(this.resultBuffer, 0, new Uint32Array(12));

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(this.workgroups);
    pass.end();
    encoder.copyBufferToBuffer(this.resultBuffer, 0, this.readBuffer, 0, 48);

    const started = performance.now();
    this.device.queue.submit([encoder.finish()]);
    await this.readBuffer.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(this.readBuffer.getMappedRange().slice(0));
    this.readBuffer.unmap();
    const seconds = Math.max((performance.now() - started) / 1000, 0.001);

    this.totalHashes += this.hashesPerBatch;
    const batchHashWords = result.slice(4, 12);
    const batchBestBits = Array.from(batchHashWords).reduce((count, word) => {
      if (count % 32 !== 0) return count;
      return word === 0 ? count + 32 : count + Math.clz32(word);
    }, 0);
    if (batchBestBits > this.bestBits) {
      this.bestBits = batchBestBits;
      this.bestHash = `0x${Array.from(batchHashWords, (word) => word.toString(16).padStart(8, '0')).join('')}`;
    }
    const instantRate = this.hashesPerBatch / seconds;
    this.rateSamples.push(instantRate);
    if (this.rateSamples.length > 12) this.rateSamples.shift();
    const hashrate = this.rateSamples.reduce((sum, rate) => sum + rate, 0) / this.rateSamples.length;
    this.callbacks.onProgress?.({ totalHashes: this.totalHashes, bestBits: this.bestBits, bestHash: this.bestHash, hashrate });

    if (result[0] === 1) {
      this.running = false;
      const nonce = (BigInt(result[2]) << 32n) | BigInt(result[1]);
      this.callbacks.onFound?.({ nonce, challenge: this.challenge });
      return;
    }

    const next = BigInt(this.nonceLo) + BigInt(this.hashesPerBatch);
    this.nonceLo = Number(next & 0xffffffffn);
    this.nonceHi = (this.nonceHi + Number(next >> 32n)) >>> 0;

    // The official browser miner.js yields here too (there, to avoid
    // blocking the tab's UI thread). Keeping that yield gives the native
    // addon's own worker threads a scheduling gap between dispatches
    // instead of hammering it back-to-back — see the note in shader.mjs
    // on the native pthread abort this combines with ITERATIONS to avoid.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
