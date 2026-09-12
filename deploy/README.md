# Deploying to vast.ai

One-time setup, then every future instance just needs two env vars and one
on-start script pasted into the vast.ai console.

## 1. Create a read-only deploy key (one-time)

This repo is private, so the rented instance needs its own scoped
credential to clone it — not your personal GitHub token.

```bash
ssh-keygen -t ed25519 -N "" -f ./hash-broker-deploy-key -C "vast.ai deploy key"
```

- Add the **public** key (`hash-broker-deploy-key.pub`) to the repo:
  GitHub -> this repo -> Settings -> Deploy keys -> Add deploy key.
  Leave "Allow write access" **unchecked** — it only needs to read.
- Keep the **private** key (`hash-broker-deploy-key`, no extension) — you'll
  paste its contents into vast.ai as the `DEPLOY_KEY` env var below. Don't
  commit either file; delete the local copies once they're pasted in.

## 2. Create the instance

- Image: `vastai/base-image`, tag `stock-ubuntu24.04-<latest date>` — its
  Dockerfile sets `NVIDIA_DRIVER_CAPABILITIES=all` and installs Vulkan
  runtime/tools unconditionally, which is what headless Chrome's WebGPU
  needs to reach the real GPU instead of falling back to a software one.
- Env Vars (vast.ai console -> instance config):
  - `PRIVATE_KEY` = your mining wallet's private key (`0x` + 64 hex chars)
  - `DEPLOY_KEY` = the full contents of `hash-broker-deploy-key` (the
    private half), newlines included
- On-start Script: paste the contents of [`vast-onstart.sh`](./vast-onstart.sh)
  as-is.

Launch the instance.

## 3. Verify it's actually mining

SSH into the instance (vast.ai gives you the command on the instance card),
then:

```bash
supervisorctl status hash-broker-miner   # RUNNING, and check the uptime
tail -f /root/hash-broker-miner/miner.log
```

You should see `GPU (via headless Chrome): <your GPU's name>`, then
per-round challenge/hashrate lines. If the GPU name looks like a software
renderer (`llvmpipe`, `SwiftShader`, etc.), or `supervisorctl status` shows
it flapping between STARTING/BACKOFF/FATAL, stop and bench-test it first
(see "Tuning the batch size" below) — don't leave it mining unattended
until that looks stable.

**Why Supervisor and not a background `nohup` job**: the first version of
this script backgrounded `npm start` in a `while true` restart loop with
`nohup ... &`. That survives the SSH session hanging up, but not the
on-start script's own process *group* being torn down — a GPU crash took
the whole loop down with it instead of being restarted. `vastai/base-image`
already runs Supervisor as the container's persistent process manager (it's
what runs Jupyter/Tensorboard/etc. too), so the miner is registered there
instead — it's the container's actual init-adjacent supervisor and
survives what a background job doesn't.

## Tuning the batch size for your GPU

The miner runs through headless Chrome now (see the main README's "Why
headless Chrome" section for why — a native Node GPU binding was tried
first and produced repeated, unresolvable crashes on real hardware).
Chrome's WebGPU is far more battle-tested than that binding was, but it's
still worth bench-testing your actual instance before trusting an
unattended run, since batch size vs. GPU/driver combinations are always
worth verifying rather than assuming:

```bash
cd /root/hash-broker-miner
BENCH_BATCHES=200 npm run bench                    # the default batch size (matches the site's own)
MINER_ITERATIONS=512 BENCH_BATCHES=200 npm run bench  # try larger if the default looks stable and you want more throughput per dispatch
```

Each runs 200 real dispatches at a difficulty high enough that it won't get
"found" early (so you actually get 200 dispatches' worth of stability
signal, not just one). If a value runs clean, set `MINER_ITERATIONS=<value>`
in the instance's Env Vars and restart the miner (`supervisorctl restart
hash-broker-miner`) — Supervisor programs inherit the container's env vars,
so no need to edit the conf file. `autorestart` is still there as a safety
net regardless of what you find.

## Updating

Re-running the same on-start script's `git pull --ff-only` step handles
picking up new commits, but vast.ai on-start scripts only run at container
boot — to update a *running* instance without restarting it:

```bash
cd /root/hash-broker-miner
git pull --ff-only
./setup.sh --yes
supervisorctl restart hash-broker-miner
```
