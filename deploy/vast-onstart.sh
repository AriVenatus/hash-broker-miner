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

# Belt-and-suspenders: write PRIVATE_KEY into .env too (in addition to
# whatever env var setup.sh already saw), so the miner can load it via
# dotenv no matter how Supervisor's own environment inheritance behaves.
if [ -n "${PRIVATE_KEY:-}" ]; then
  [ -f .env ] || cp .env.example .env
  if grep -q '^PRIVATE_KEY=' .env; then
    sed -i "s|^PRIVATE_KEY=.*|PRIVATE_KEY=${PRIVATE_KEY}|" .env
  else
    echo "PRIVATE_KEY=${PRIVATE_KEY}" >> .env
  fi
fi

# vastai/base-image already runs Supervisor as the container's own
# always-on process manager (its other bundled apps — Jupyter, Tensorboard,
# etc. — are Supervisor programs under /etc/supervisor/conf.d/). Register
# the miner there instead of a hand-rolled `nohup ... &` background loop:
# a plain background job's process group can get reaped when the on-start
# script's own shell session ends, which is what happened the first time
# (a crash killed the loop along with it, instead of being restarted).
# Supervisor is the container's actual init-adjacent supervisor and
# survives that.
cat > /etc/supervisor/conf.d/hash-broker-miner.conf <<EOF
[program:hash-broker-miner]
directory=${DEPLOY_DIR}
command=npm start
autostart=true
autorestart=true
startretries=1000000
stdout_logfile=${DEPLOY_DIR}/miner.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=3
redirect_stderr=true
; HOME must be set explicitly: Puppeteer looks under \$HOME/.cache/puppeteer
; for the Chrome build setup.sh already downloaded there as root, and
; Supervisor's own child-process environment isn't guaranteed to match an
; interactive root shell's.
environment=HOME="${HOME:-/root}"
EOF

supervisorctl reread
supervisorctl update
supervisorctl restart hash-broker-miner 2>/dev/null || supervisorctl start hash-broker-miner

echo "Miner registered with Supervisor and started."
echo "Status: supervisorctl status hash-broker-miner"
echo "Logs:   tail -f ${DEPLOY_DIR}/miner.log"
