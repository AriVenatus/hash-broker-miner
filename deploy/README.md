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

- Image: `vastai/base-image`, tag `stock-ubuntu24.04-<latest date>` (see
  the [main README](../README.md#gpu-detection--multi-gpu) for why this
  template specifically — it has Vulkan + `NVIDIA_DRIVER_CAPABILITIES=all`
  baked in already).
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

You should see the GPU discovery log, then per-round challenge/hashrate
lines. If it instead shows a software-adapter warning, or `supervisorctl
status` shows it flapping between STARTING/BACKOFF/FATAL, stop and
bench-test it first (see "Tuning the batch size" below) — don't leave it
mining unattended until that looks stable (see the main README's "Tuning /
hardware notes" for what a healthy vs. broken GPU backend looks like).

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

The native `webgpu` (Dawn) Node addon has been observed to crash under
certain dispatch sizes/frequencies even on real hardware (see the main
README's caveats section) — this seems to depend on the specific GPU, so
it's worth bench-testing on the instance itself before trusting an
unattended run. **Known so far on one RTX 4090**: `ITERATIONS=128` (the
current default) ran but eventually hit a threading-related abort;
`ITERATIONS=2048` crashed immediately and repeatably — so don't jump
straight to a large value, step up gradually instead:

```bash
cd /root/hash-broker-miner
MINER_ITERATIONS=128 BENCH_BATCHES=200 npm run bench
MINER_ITERATIONS=256 BENCH_BATCHES=200 npm run bench
MINER_ITERATIONS=512 BENCH_BATCHES=200 npm run bench
# only keep going up if the previous value ran clean
```

Each runs 200 real dispatches per GPU at a difficulty high enough that it
won't get "found" early (so you actually get 200 dispatches' worth of
stability signal, not just one). Whichever value survives all 200 without
crashing, set `MINER_ITERATIONS=<value>` in the instance's Env Vars and
restart the miner (`supervisorctl restart hash-broker-miner`) — Supervisor
programs inherit the container's env vars, so no need to edit the conf file.
If even 128 doesn't survive 200 batches, don't keep raising it — that's the
unresolved threading bug, not a size problem, and the `autorestart` in
Supervisor is the mitigation for now, not a bigger batch size.

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
