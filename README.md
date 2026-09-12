# hash-broker-miner

Standalone Node.js miner for [hashbroker.fun](https://www.hashbroker.fun/), a
proof-of-work NFT mint on Robinhood Chain (chain id 4663). This isn't scraping
or gaming anything: the site's own front-end runs a WebGPU brute-forcer in the
browser and mints on-chain — this drives a **headless Chrome instance
(via Puppeteer)** running that exact same mining algorithm, and handles the
chain reads/mint transaction from Node. Headless Chrome, not a standalone
Node GPU binding, is deliberate — see "Why headless Chrome" below.

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

1. Launches a headless Chrome instance and initializes WebGPU in it,
   printing the GPU it found (see "Why headless Chrome" below).
2. Reads `totalSupply`, `mintPrice`, `currentDifficulty` and `challenge`
   straight from the contract.
3. Runs the GPU search against your wallet address + that challenge.
4. Every 8s it polls the chain; if the challenge or difficulty changed
   (i.e. someone else won that round) it abandons the stale job and
   restarts on the new one instead of wasting time.
5. On a found proof, re-reads the current price (it can have stepped up)
   and submits the mint transaction, waits for the receipt, and loops.
6. Stops itself once `totalSupply` reaches 4,444, or on Ctrl+C (finishes the
   in-flight batch first).

First run: `setup.sh` also downloads a Chrome build for Puppeteer and (on
Debian/Ubuntu, as root or with passwordless sudo — true by default on a
fresh vast.ai instance) installs the shared libraries headless Chrome needs.
On any other setup, if `npm run selftest` fails with a `shared libraries`
error, install those packages yourself — the exact list `setup.sh` tries is
in its own source, right where that step happens.

Example output:

```
Wallet:   0xAbC...123
Balance:  0.05 ETH (gas token on https://rpc.mainnet.chain.robinhood.com/)
Contract: 0x4272D6f51771839F596082eF48fa84D35239Bab3 (chain 4663)

GPU (via headless Chrome): NVIDIA GeForce RTX 4090
Mining pool ready: 1 device (headless Chrome).

Challenge 0xeb00af47e587… | difficulty 50 bits | price 0.0001 ETH | supply 220/4444 | pool: GPU 0
  GPU 0 412.3 MH/s | total 412.3 MH/s | best 41/50 bits | 8,589,934,592 hashes | expected wait 43.7m
  [GPU 0] found a proof (nonce 8817281919123). Submitting mint transaction...
  Minted! tx 0xdead...beef (session total: 1)
```

## Why headless Chrome (and not a native Node GPU binding)

This started out using the `webgpu` npm package (Dawn's native Node
bindings) to talk to the GPU directly from Node, without a browser. That
approach was abandoned after extensive real-hardware debugging — the full
incident record, kept because whoever touches this next should know not to
re-attempt it without reading this first:

- On an RTX 4090, it ran fine briefly then aborted with a glibc
  `pthread_mutex_lock` assertion — looked like a threading bug under
  sustained high-frequency dispatch.
- Raising the batch size to reduce dispatch frequency (the seemingly
  reasonable fix) instead caused an immediate, repeatable `Segmentation
  fault` on the very first dispatch — a different, harder failure mode,
  which ruled out the frequency theory entirely.
- Pinning `webgpu` to a 6-months-mature version (`0.4.0`, vs. the `0.6.1`
  that had shipped hours before the crashes started) made no difference —
  same immediate crash.
- Removing a `device.lost` handler (a plausible source of native
  thread/callback machinery) made no difference.
- Removing GPU-adapter-selection-by-name (`adapter=<name>`, passed as a
  literal argument to Dawn's `create()`) made no difference.
- The crash reproduced even at the smallest possible dispatch
  (`workgroupSize=1, workgroups=1, iterations=1`, a single batch) run
  through the same class structure that always crashed — while an
  equivalent raw one-off script, with no class/callback indirection at
  all, never crashed once, on the same GPU, across the whole investigation.

That last point is the key one: the actual WebGPU calls being made were
identical in both cases. The only difference was the JS structure around
them (a class with async `init()`/`setJob()`/`start()` methods vs. a flat
top-level script). That points at something in the native addon's
Node.js/event-loop integration itself — not at anything tunable from
userland. Chrome's own WebGPU implementation is the one actually
battle-tested in production by this site's real users, so `src/browserMiner.mjs`
drives that instead of reimplementing GPU access.

`npm run selftest` and `npm run bench` still work the same way and mean the
same thing; they just launch a Chrome tab instead of talking to Dawn
directly. That tab isn't run in Chrome's *headless mode* specifically —
headless-mode GPU support hit two different Vulkan/GPU-process edge cases
in a row in testing (a `vkCreateInstance` extension failure, then a
`CreateCommandBuffer` transient failure), each fixable with its own
obscure flag. Rather than keep fighting headless-specific quirks one flag
at a time, `src/browserMiner.mjs` runs Chrome normally on a virtual (Xvfb)
display instead — the actually battle-tested pattern for GPU-accelerated
Chrome in CI/Docker (what Chrome's own GPU test bots and most
Puppeteer/Selenium GPU pipelines use). Nothing is visible to a human
either way; "headless" in this README means "no GUI a person watches,"
not literally Chrome's `--headless` flag.

**Confirmed working on real hardware**: an RTX 4090 (`lovelace` adapter),
`npm run selftest` passing, and `npm run bench` sustaining 200+ real
dispatches at ~920 MH/s with zero crashes — a meaningfully different
outcome from the native addon, which never got past intermittent crashes
at any batch size on the same GPU. `MINER_WORKGROUP_SIZE` / `MINER_WORKGROUPS` /
`MINER_ITERATIONS` still control batch shape (same defaults, matching the
site's own browser miner) and are still worth a quick `npm run bench`
check on hardware you haven't tried yet, just as ordinary due diligence
rather than because this approach is known-shaky.

**Known limitation**: a single Chrome instance uses whichever GPU the
system/driver exposes by default. There's no clean way to pin multiple
Chrome instances to different physical GPUs, so multi-GPU support (which
the native-binding version had) is out of scope for now — `src/pool.mjs`
always builds a pool of exactly one.

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
- Chrome is launched with `--no-sandbox` (needed to run as root in a
  container without a configured SUID sandbox — standard practice for
  headless Chrome in Docker). This is mitigated by the page only ever
  loading local, self-authored content via `page.setContent()` — it never
  navigates to a remote or untrusted URL.
