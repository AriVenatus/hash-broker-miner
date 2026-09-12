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
tail -f /root/hash-broker-miner/miner.log
```

You should see the GPU discovery log, then per-round challenge/hashrate
lines. If it instead shows a software-adapter warning or keeps restarting,
stop and check `npm run bench` output in that same log — don't leave it
mining unattended until that looks right (see the main README's "Tuning /
hardware notes" for what a healthy vs. broken GPU backend looks like).

## Updating

Re-running the same on-start script's `git pull --ff-only` step handles
picking up new commits, but vast.ai on-start scripts only run at container
boot — to update a *running* instance without restarting it:

```bash
cd /root/hash-broker-miner
git pull --ff-only
./setup.sh --yes
pkill -f "npm start" || true   # the restart loop in vast-onstart.sh brings it back
```
