# hash-broker-miner

Standalone Node.js miner for [hashbroker.fun](https://www.hashbroker.fun/), a
proof-of-work NFT mint on Robinhood Chain (chain id 4663). This isn't scraping
or gaming anything: the site's own front-end runs a WebGPU brute-forcer in the
browser and mints on-chain — this script does the exact same computation and
submission outside the browser, GPU-accelerated via [Dawn](https://dawn.googlesource.com/dawn)
(the same WebGPU engine Chrome uses) through the `webgpu` npm package.

The mining rule: find a `nonce` such that
`SHA256(yourAddress ‖ zero-pad ‖ nonce ‖ currentChallenge)` has at least
`currentDifficulty` leading zero bits, then submit `mine(nonce, challenge)` to
the contract with the current mint price as `value`. All contract addresses,
selectors and the exact hash layout in `src/config.mjs` / `src/shader.mjs`
were read directly out of the live site's `config.js` / `app.js` / `miner.js`.

## Setup

```bash
./setup.sh
```

This installs dependencies (working around the Windows-npm-shadowing-Linux-npm
issue some WSL setups hit — see below), checks for a real GPU driver, creates
`.env`, and walks you through either generating a fresh wallet or pasting an
existing private key — then runs the self-test automatically.

Flags:

```bash
./setup.sh --yes               # non-interactive, skip prompts (CI/scripted use)
./setup.sh --generate-wallet   # generate a fresh wallet into .env without asking
./setup.sh --bench             # also run `npm run bench` at the end
```

A generated wallet's private key is written straight to `.env` and never
printed to the terminal — only its address is, so you know what to fund.

Fund that wallet with a small amount of Robinhood Chain's native gas token —
mints are free until Hash Broker #101 and then rise (0.0001 ETH per 200
mints, capping at 0.0022 ETH), but every mint still costs gas regardless of
price.

Then:

```bash
npm run bench      # measure your GPU(s) for a few real-size batches, reports MH/s
npm start          # mines continuously until Ctrl+C or the 4,444 supply cap
```

(Prefer to do it by hand instead of running `setup.sh`? `npm install`, then
`cp .env.example .env` and edit in your `PRIVATE_KEY`, then `npm run selftest`.)

**Deploying to a rented GPU (vast.ai, etc.)?** See [`deploy/README.md`](deploy/README.md)
for a private-repo-friendly on-start script instead of an interactive setup.

## What `npm start` does

1. Detects every GPU on the machine (see "GPU detection & multi-GPU" below)
   and initializes one miner per device, printing what it found.
2. Reads `totalSupply`, `mintPrice`, `currentDifficulty` and `challenge`
   straight from the contract.
3. Runs the GPU search against your wallet address + that challenge, on
   every detected GPU at once — whichever one finds a valid proof first
   wins that round.
4. Every 8s it polls the chain; if the challenge or difficulty changed (i.e.
   someone else won that round) it abandons the stale job on every GPU and
   restarts them on the new one instead of wasting time.
5. On a found proof, re-reads the current price (it can have stepped up)
   and submits the mint transaction, waits for the receipt, and loops.
6. Stops itself once `totalSupply` reaches 4,444, or on Ctrl+C (finishes the
   in-flight batch first).

Example output:

```
Wallet:   0xAbC...123
Balance:  0.05 ETH (gas token on https://rpc.mainnet.chain.robinhood.com/)
Contract: 0x4272D6f51771839F596082eF48fa84D35239Bab3 (chain 4663)

Detecting GPUs...
Found 2 WebGPU adapter(s) on this system:
  - backend=vulkan name="NVIDIA GeForce RTX 4090"
  - backend=vulkan name="NVIDIA GeForce RTX 3080"
[GPU 0] ready: NVIDIA GeForce RTX 4090
[GPU 1] ready: NVIDIA GeForce RTX 3080
Mining pool ready: 2 device(s).

Challenge 0xeb00af47e587… | difficulty 50 bits | price 0.0001 ETH | supply 220/4444 | pool: GPU 0, GPU 1
  GPU 0 412.3 MH/s | GPU 1 268.1 MH/s | total 680.4 MH/s | best 41/50 bits | 8,589,934,592 hashes | expected wait 26.4m
  [GPU 0] found a proof (nonce 8817281919123). Submitting mint transaction...
  Minted! tx 0xdead...beef (session total: 1)
```

## GPU detection & multi-GPU

On startup (and in `npm run bench`), `src/gpuDiscovery.mjs` asks Dawn for
every adapter it can see — across whatever backends your platform supports
(`vulkan` on Linux, `metal` on macOS, `d3d12` on Windows) — and:

- drops adapters that look like a software/CPU fallback (`llvmpipe`,
  `lavapipe`, `swiftshader`, etc.) whenever at least one real GPU is present
- drops duplicate `(backend, name)` entries, since this WebGPU binding
  selects an adapter by name string and can't tell two identically-named
  entries apart
- spins up one `GpuMiner` per remaining adapter, each pinned to that device,
  and mines every job on all of them concurrently

**Known limitation**: if you have two or more *identical* GPU models (a
common case for dedicated mining rigs), Dawn may report them with the exact
same name string, and this package only exposes name-based adapter
selection (no PCI/bus-id or index selector) — see the `adapter=` option in
`node_modules/webgpu/README.md`. When that happens this tool logs a
"skipping duplicate" warning and only mines on one of them, rather than
silently double-mining the same physical card under two different labels.
If your setup hits this, check whether a newer version of the `webgpu`
package exposes index-based selection.

Override the pool with:

- `MINER_MAX_GPUS=1` — cap how many detected GPUs are actually used
- `MINER_WORKGROUP_SIZE` / `MINER_WORKGROUPS` / `MINER_ITERATIONS` — batch
  shape per GPU (same knobs as before, applied to every device in the pool)

If discovery can't parse an adapter list at all (unexpected Dawn output),
it logs that and falls back to Dawn's own default single-adapter selection
rather than failing outright.

## Tuning / hardware notes

Batch shape (`MINER_WORKGROUP_SIZE` × `MINER_WORKGROUPS` × `MINER_ITERATIONS`
hashes per GPU dispatch) defaults to the same numbers the live site's own
browser miner uses. Override via env vars if needed.

**Caveats from building this**: the sandbox this was developed in has no real
GPU Vulkan driver registered (only Mesa's software Lavapipe/llvmpipe), and
under that software backend, large dispatches intermittently crashed the
Node process (`SIGSEGV`/`SIGABRT` from inside Dawn's native code) — not a bug
in the mining logic itself (`npm run selftest` still passes: the hash
algorithm is bit-for-bit correct), but a stability limitation of running
WebGPU compute on a software rasterizer. On a real GPU with a proper
Vulkan/Metal/D3D12 driver — which is what this is meant to run on — Dawn is
the same production-grade engine Chrome ships, so this should not occur. If
`npm run bench` ever crashes on your machine, lower `MINER_WORKGROUPS` /
`MINER_ITERATIONS` first and check your GPU drivers second.

Separately: two live Dawn instances open in the same Node process at once
(e.g. the adapter-discovery probe plus a real mining device) were observed
to abort the process (`std::system_error: Invalid argument`). That's why GPU
discovery (`scripts/_probe-adapters.mjs`) runs as its own short-lived child
process instead of in-process — its Dawn instance is fully gone by the time
the real one is created. Don't merge that probe back into the main process.

## Troubleshooting: `npm` fails with a UNC path / `cmd.exe` error

`setup.sh` detects and works around this automatically, but if you're
installing by hand: on some WSL2 setups, `npm`/`npx` on `PATH` resolve to the
**Windows** npm (`/mnt/.../nodejs/npm`) even though `node` resolves to the
Linux binary. That Windows npm can't run scripts from a `\\wsl.localhost\...`
working directory and fails with errors mentioning `cmd.exe` / `UNC paths are
not supported`. If you hit this, run npm through the Linux node via corepack
instead:

```bash
corepack npm install
corepack npm run bench
```

(or fix your `PATH` so the Linux npm/node directory comes first).

## Security notes

- `PRIVATE_KEY` is read from the environment only; it's never written to
  disk by this script. Keep `.env` out of version control (already in
  `.gitignore`).
- This sends real transactions from that wallet. Only fund it with what
  you're willing to spend on gas + mint price.
- `RPC_URL` / `CONTRACT_ADDRESS` / `CHAIN_ID_DECIMAL` are overridable via env
  vars in case the project ever redeploys.
