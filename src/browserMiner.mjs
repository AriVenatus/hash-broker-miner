// Drives a headless Chrome tab (via Puppeteer) running the exact same
// mining algorithm as the official site's own browser miner, instead of
// the standalone `webgpu` (Dawn) Node addon. That addon was ruled out as
// the cause of repeated, distinct native crashes reproduced on real GPU
// hardware (see README's "Caveats from building this" for the full
// incident history) even at the smallest possible dispatch. Chrome's own
// WebGPU implementation is the one actually battle-tested in production
// by this site's real users, so we drive that instead of reimplementing
// GPU access ourselves.
import puppeteer from 'puppeteer';
import { buildShader, WORKGROUP_SIZE, WORKGROUPS, ITERATIONS } from './shader.mjs';

function hexWords(hex, expectedWords) {
  const clean = hex.toLowerCase().replace(/^0x/, '');
  if (clean.length !== expectedWords * 8) throw new Error(`Unexpected hex length for ${hex}`);
  const words = [];
  for (let i = 0; i < expectedWords; i++) words.push(parseInt(clean.slice(i * 8, i * 8 + 8), 16) >>> 0);
  return words;
}

// The in-page miner is a direct port of the official site's own
// HashBrokerMiner (miner.js): same shader, same buffer layout, same
// batch loop. It reports progress/found/error back to Node via
// `window.__report`, exposed through Puppeteer's exposeFunction, and is
// driven through `window.__minerControl` instead of a constructor
// callbacks object (there's no "Node callbacks" concept inside the page).
function buildPageHtml({ workgroupSize, workgroups, iterations }) {
  const shaderSource = buildShader({ workgroupSize, iterations });
  const hashesPerBatch = workgroupSize * workgroups * iterations;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>hash-broker headless miner</title></head><body>
<script>
const SHADER_SOURCE = ${JSON.stringify(shaderSource)};
const WORKGROUPS = ${workgroups};
const HASHES_PER_BATCH = ${hashesPerBatch};

function hexWords(hex, expectedWords) {
  const clean = hex.toLowerCase().replace(/^0x/, '');
  const words = [];
  for (let i = 0; i < expectedWords; i++) words.push(parseInt(clean.slice(i * 8, i * 8 + 8), 16) >>> 0);
  return words;
}

class HashBrokerMiner {
  constructor() {
    this.running = false;
    this.totalHashes = 0;
    this.bestBits = 0;
    this.rateSamples = [];
  }

  async init() {
    if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser.');
    this.adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!this.adapter) throw new Error('No compatible GPU adapter was found.');
    this.device = await this.adapter.requestDevice();

    const module = this.device.createShaderModule({ code: SHADER_SOURCE });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((m) => m.type === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.message).join('\\n'));

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

    const info = this.adapter.info || {};
    return info.description || info.architecture || info.device || info.vendor || 'WebGPU device';
  }

  setJob({ address, challenge, difficulty }) {
    const addressWords = hexWords(address, 5);
    const challengeWords = hexWords(challenge, 8);
    const random = crypto.getRandomValues(new Uint32Array(2));
    this.nonceLo = random[0] >>> 0;
    this.nonceHi = random[1] >>> 0;
    this.difficulty = Number(difficulty);
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

  stop() { this.running = false; }

  async runBatch() {
    const dispatchNonceLo = this.nonceLo;
    const dispatchNonceHi = this.nonceHi;

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
    pass.dispatchWorkgroups(WORKGROUPS);
    pass.end();
    encoder.copyBufferToBuffer(this.resultBuffer, 0, this.readBuffer, 0, 48);

    const started = performance.now();
    this.device.queue.submit([encoder.finish()]);
    await this.readBuffer.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(this.readBuffer.getMappedRange().slice(0));
    this.readBuffer.unmap();
    const seconds = Math.max((performance.now() - started) / 1000, 0.001);

    this.totalHashes += HASHES_PER_BATCH;
    const batchHashWords = result.slice(4, 12);
    const currentHash = '0x' + Array.from(batchHashWords, (w) => w.toString(16).padStart(8, '0')).join('');
    const batchBestBits = Array.from(batchHashWords).reduce((count, word) => {
      if (count % 32 !== 0) return count;
      return word === 0 ? count + 32 : count + Math.clz32(word);
    }, 0);
    if (batchBestBits > this.bestBits) {
      this.bestBits = batchBestBits;
      this.bestHash = currentHash;
    }
    const instantRate = HASHES_PER_BATCH / seconds;
    this.rateSamples.push(instantRate);
    if (this.rateSamples.length > 12) this.rateSamples.shift();
    const hashrate = this.rateSamples.reduce((s, r) => s + r, 0) / this.rateSamples.length;

    window.__report('progress', {
      totalHashes: this.totalHashes,
      bestBits: this.bestBits,
      bestHash: this.bestHash,
      hashrate,
      // Always this batch's own hash/nonce (unlike bestHash, which only
      // updates when it improves on the historical best and can
      // otherwise stay null on the very first batch). Only meaningful for
      // reconstructing the exact preimage when workgroups=workgroupSize=
      // iterations=1 (one hash per batch) -- that's what
      // scripts/selftest.mjs uses these for.
      currentHash,
      nonceLo: dispatchNonceLo,
      nonceHi: dispatchNonceHi
    });

    if (result[0] === 1) {
      this.running = false;
      const nonce = ((BigInt(result[2]) << 32n) | BigInt(result[1])).toString();
      window.__report('found', { nonce, challenge: this.challenge });
      return;
    }

    const next = BigInt(this.nonceLo) + BigInt(HASHES_PER_BATCH);
    this.nonceLo = Number(next & 0xffffffffn);
    this.nonceHi = (this.nonceHi + Number(next >> 32n)) >>> 0;

    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let miner = null;

window.__minerControl = {
  async init() {
    miner = new HashBrokerMiner();
    return await miner.init();
  },
  setJob(job) {
    miner.setJob(job);
  },
  start() {
    miner.start()
      .catch((error) => window.__report('error', { message: error.message }))
      .finally(() => window.__report('stopped', {}));
    return true;
  },
  stop() {
    miner?.stop();
  }
};
</script>
</body></html>`;
}

export class BrowserMiner {
  constructor(callbacks = {}, options = {}) {
    this.callbacks = callbacks;
    this.label = options.label || 'GPU';
    this.workgroupSize = options.workgroupSize ?? Number(process.env.MINER_WORKGROUP_SIZE || WORKGROUP_SIZE);
    this.workgroups = options.workgroups ?? Number(process.env.MINER_WORKGROUPS || WORKGROUPS);
    this.iterations = options.iterations ?? Number(process.env.MINER_ITERATIONS || ITERATIONS);
  }

  async init() {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        // Running as root in a container without a configured SUID
        // sandbox: standard, documented trade-off for headless Chrome in
        // Docker. Mitigated by only ever loading our own local content
        // via page.setContent() -- this page never navigates to a
        // remote/untrusted URL.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--use-gl=angle',
        '--ignore-gpu-blocklist',
        '--disable-gpu-sandbox'
      ]
    });
    this.page = await this.browser.newPage();
    this.page.on('pageerror', (error) => this.callbacks.onError?.(new Error(`[${this.label}] page error: ${error.message}`)));
    await this.page.exposeFunction('__report', (type, payload) => this._onReport(type, payload));

    const html = buildPageHtml({
      workgroupSize: this.workgroupSize,
      workgroups: this.workgroups,
      iterations: this.iterations
    });
    await this.page.setContent(html, { waitUntil: 'load' });

    const gpuName = await this.page.evaluate(() => window.__minerControl.init());
    this.gpuName = gpuName;
    return gpuName;
  }

  _onReport(type, payload) {
    if (type === 'progress') {
      this.callbacks.onProgress?.(payload);
    } else if (type === 'found') {
      this._settleStart();
      this.callbacks.onFound?.({ nonce: BigInt(payload.nonce), challenge: payload.challenge });
    } else if (type === 'error') {
      this._settleStart();
      this.callbacks.onError?.(new Error(payload.message));
    } else if (type === 'stopped') {
      this._settleStart();
    }
  }

  _settleStart() {
    this._resolveStart?.();
    this._resolveStart = null;
  }

  setJob({ address, challenge, difficulty }) {
    hexWords(address, 5); // validate shape early, same as the native miner did
    hexWords(challenge, 8);
    this._job = { address, challenge, difficulty: Number(difficulty) };
  }

  // Mirrors the native GpuMiner's start(): resolves only once mining has
  // actually stopped (found a proof, hit an error, or was told to stop),
  // not merely once the in-page loop has been kicked off -- pool.mjs and
  // bench.mjs both depend on that to know when a round is really over.
  async start() {
    if (!this._job) throw new Error('Mining job is not configured.');
    const donePromise = new Promise((resolve) => {
      this._resolveStart = resolve;
    });
    await this.page.evaluate(
      (job) => {
        window.__minerControl.setJob(job);
        window.__minerControl.start();
      },
      this._job
    );
    return donePromise;
  }

  stop() {
    this.page?.evaluate(() => window.__minerControl.stop())?.catch(() => {});
  }

  async close() {
    await this.browser?.close();
  }
}
