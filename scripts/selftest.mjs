// Verifies the WGSL shader's SHA-256 implementation and message layout
// against Node's own crypto module for a known input, before any real
// mining/minting happens. Run with: npm run selftest
import { create, globals } from 'webgpu';
import crypto from 'node:crypto';
import { buildShader } from '../src/shader.mjs';

const { GPUBufferUsage, GPUMapMode } = globals;

function hexWords(hex, expectedWords) {
  const clean = hex.toLowerCase().replace(/^0x/, '');
  const words = [];
  for (let i = 0; i < expectedWords; i++) words.push(parseInt(clean.slice(i * 8, i * 8 + 8), 16) >>> 0);
  return words;
}

const gpu = create([]);
const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) {
  console.error('No WebGPU adapter found. Mining requires a working GPU/driver.');
  process.exit(1);
}
const device = await adapter.requestDevice();
console.log(`Adapter: ${JSON.stringify(adapter.info || {})}`);

const module = device.createShaderModule({ code: buildShader({ workgroupSize: 1, iterations: 1 }) });
const compilation = await module.getCompilationInfo();
const errors = compilation.messages.filter((m) => m.type === 'error');
if (errors.length) {
  console.error('Shader compilation failed:', errors);
  process.exit(1);
}

const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
const paramsBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
const resultBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
const readBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: paramsBuffer } },
    { binding: 1, resource: { buffer: resultBuffer } }
  ]
});

const address = '0x' + '11'.repeat(20);
const challenge = '0x' + '42'.repeat(32);
const params = new Uint32Array(16);
params.set([...hexWords(address, 5), ...hexWords(challenge, 8)], 0);
params[13] = 0; // nonceLo
params[14] = 0; // nonceHi
device.queue.writeBuffer(paramsBuffer, 0, params);
device.queue.writeBuffer(resultBuffer, 0, new Uint32Array(12));

const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(pipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(1);
pass.end();
encoder.copyBufferToBuffer(resultBuffer, 0, readBuffer, 0, 48);
device.queue.submit([encoder.finish()]);
await readBuffer.mapAsync(GPUMapMode.READ);
const result = new Uint32Array(readBuffer.getMappedRange().slice(0));
readBuffer.unmap();

const gpuHash = Array.from(result.slice(4, 12), (w) => w.toString(16).padStart(8, '0')).join('');

const message = Buffer.concat([
  Buffer.from('11'.repeat(20), 'hex'),
  Buffer.alloc(24, 0),
  Buffer.from([0, 0, 0, 0]), // nonceHi
  Buffer.from([0, 0, 0, 0]), // nonceLo
  Buffer.from('42'.repeat(32), 'hex')
]);
const cpuHash = crypto.createHash('sha256').update(message).digest('hex');

console.log('GPU hash:', gpuHash);
console.log('CPU hash:', cpuHash);
if (gpuHash !== cpuHash) {
  console.error('MISMATCH — do not mine for real until this passes.');
  process.exit(1);
}
console.log('OK: shader matches SHA-256 reference implementation.');
