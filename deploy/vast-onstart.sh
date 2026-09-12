#!/usr/bin/env bash
# Paste this into vast.ai's "On-start Script" field when creating the
# instance (Instance Configuration -> On-start Script). It runs once as
# root when the container boots.
#
# Required instance Env Vars (set them in the vast.ai console, never in
# this script):
#   PRIVATE_KEY   - the mining wallet's private key (0x + 64 hex chars)
#   DEPLOY_KEY    - contents of a GitHub read-only deploy key for the repo
#                   (see deploy/README.md for how to generate one)
#
# Optional:
#   GIT_REPO      - defaults to the repo below
#   DEPLOY_DIR    - defaults to /root/hash-broker-miner
set -euo pipefail

: "${GIT_REPO:=git@github.com:AriVenatus/hash-broker-miner.git}"
: "${DEPLOY_DIR:=/root/hash-broker-miner}"

if [ -n "${DEPLOY_KEY:-}" ] && [ ! -f ~/.ssh/id_ed25519 ]; then
  mkdir -p ~/.ssh
  chmod 700 ~/.ssh
  printf '%s\n' "$DEPLOY_KEY" > ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
  ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null
fi

if [ -d "$DEPLOY_DIR/.git" ]; then
  git -C "$DEPLOY_DIR" pull --ff-only
else
  git clone "$GIT_REPO" "$DEPLOY_DIR"
fi

cd "$DEPLOY_DIR"
./setup.sh --yes

# PRIVATE_KEY is expected to already be set as an instance Env Var — see
# the header above. setup.sh detects that automatically and skips writing
# any wallet into .env.

# Run in the background so the on-start script can finish, restarting
# automatically if the miner process ever exits (crash, GPU device-lost,
# etc.) instead of silently going idle.
nohup bash -c '
  while true; do
    npm start
    code=$?
    echo "[$(date -u +%FT%TZ)] miner exited (code $code), restarting in 10s" >> '"$DEPLOY_DIR"'/miner.log
    sleep 10
  done
' > "$DEPLOY_DIR/miner.log" 2>&1 &

echo "Miner launched in the background. Tail logs with: tail -f $DEPLOY_DIR/miner.log"
