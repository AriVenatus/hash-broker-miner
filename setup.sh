#!/usr/bin/env bash
# One-shot setup for hash-broker-miner: installs deps, works around the
# WSL Windows-npm shadowing issue, checks for a real GPU, sets up .env
# (optionally generating a fresh wallet), then self-tests the shader.
#
# Usage:
#   ./setup.sh                    interactive
#   ./setup.sh --yes              non-interactive, sensible defaults, no prompts
#   ./setup.sh --generate-wallet  generate a fresh wallet into .env instead of asking
#   ./setup.sh --bench            also run `npm run bench` at the end
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

YES=0
GENERATE_WALLET=0
RUN_BENCH=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --generate-wallet) GENERATE_WALLET=1 ;;
    --bench) RUN_BENCH=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./setup.sh [--yes] [--generate-wallet] [--bench]
  --yes               Non-interactive: skip prompts, use defaults.
  --generate-wallet   Generate a fresh wallet into .env instead of prompting.
  --bench             Also run `npm run bench` once setup finishes.
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (see --help)" >&2
      exit 1
      ;;
  esac
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARNING:\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node 20+ (e.g. via https://nvm.sh) and re-run this script."
  exit 1
fi

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  warn "Node $(node -v) detected; Node 20+ is recommended (this project uses global crypto and top-level await)."
else
  info "Node $(node -v) OK ($(command -v node))"
fi

# ---------------------------------------------------------------------------
# 2. npm — work around Windows npm shadowing the Linux one under WSL
# ---------------------------------------------------------------------------
NPM_CMD="npm"
NPM_PATH="$(command -v npm 2>/dev/null || true)"
if [[ "$NPM_PATH" == /mnt/* ]] && command -v corepack >/dev/null 2>&1; then
  warn "npm on PATH looks like a Windows binary reached via WSL interop ($NPM_PATH)."
  warn "It can fail on this project's UNC-style working directory (cmd.exe / \"UNC paths are not supported\")."
  info "Using 'corepack npm' (runs through the Linux node binary) instead."
  NPM_CMD="corepack npm"
elif [ -z "$NPM_PATH" ] && command -v corepack >/dev/null 2>&1; then
  info "No npm on PATH; using 'corepack npm'."
  NPM_CMD="corepack npm"
elif [ -z "$NPM_PATH" ]; then
  err "Neither npm nor corepack is available. Install npm and re-run."
  exit 1
fi
info "Using: $NPM_CMD"
NPX_CMD="${NPM_CMD/npm/npx}"

# ---------------------------------------------------------------------------
# 3. Install dependencies
# ---------------------------------------------------------------------------
info "Installing dependencies..."
$NPM_CMD install

# ---------------------------------------------------------------------------
# 3b. Headless Chrome: system shared libraries + the actual browser binary
# ---------------------------------------------------------------------------
# npm's install-scripts safety gate blocks puppeteer's own postinstall
# (which normally downloads Chrome) unless explicitly approved, and that
# approval doesn't retroactively run a skipped script either — so this is
# done explicitly and unconditionally rather than relied on implicitly.
if command -v apt-get >/dev/null 2>&1; then
  CHROME_DEPS="ca-certificates fonts-liberation libasound2t64 libatk-bridge2.0-0 \
    libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
    libxtst6 lsb-release wget xdg-utils"
  info "Installing headless Chrome's system library dependencies..."
  if [ "$(id -u)" -eq 0 ]; then
    apt-get update -qq && apt-get install -y -qq $CHROME_DEPS \
      || warn "apt install failed — if Chrome fails to launch with a 'shared libraries' error, install these packages yourself: $CHROME_DEPS"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq $CHROME_DEPS \
      || warn "apt install failed — if Chrome fails to launch with a 'shared libraries' error, install these packages yourself: $CHROME_DEPS"
  else
    warn "Not root and no passwordless sudo available — skipping apt install. If Chrome fails to launch"
    warn "with a 'shared libraries' error, install these packages yourself (with sudo): $CHROME_DEPS"
  fi
else
  warn "apt-get not found (non-Debian system?) — make sure Chrome's shared library dependencies are"
  warn "installed some other way if 'npm run selftest' fails with a 'shared libraries' error."
fi

info "Downloading the Chrome build Puppeteer needs (skips if already cached)..."
$NPX_CMD puppeteer browsers install chrome

# ---------------------------------------------------------------------------
# 4. GPU sanity check (informational only — the app does its own detection)
# ---------------------------------------------------------------------------
if command -v nvidia-smi >/dev/null 2>&1; then
  info "nvidia-smi found:"
  nvidia-smi --query-gpu=name,driver_version --format=csv,noheader 2>/dev/null | sed 's/^/    /' || true
fi
if [ -d /usr/share/vulkan/icd.d ]; then
  HARDWARE_ICDS="$(ls /usr/share/vulkan/icd.d 2>/dev/null | grep -viE 'lvp|llvmpipe|swiftshader|gfxstream|virtio' || true)"
  if [ -z "$HARDWARE_ICDS" ]; then
    warn "No hardware Vulkan ICD found under /usr/share/vulkan/icd.d — headless Chrome's WebGPU may fall"
    warn "back to a slow, less stable software GPU. Install your GPU vendor's Vulkan driver package for"
    warn "real hardware acceleration."
  fi
fi

# ---------------------------------------------------------------------------
# 5. .env / wallet
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  info "Created .env from .env.example."
fi

# A real environment variable (e.g. set by vast.ai's instance "Env Vars"
# field) takes priority over .env and needs no file at all — dotenv never
# overrides an already-set process.env value, so chain.mjs picks it up
# either way. Only fall back to the .env file / prompts if it's absent.
HAS_VALID_KEY=0
if [ -n "${PRIVATE_KEY:-}" ] && [[ "$PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  info "PRIVATE_KEY already set via environment variable — skipping .env wallet setup."
  HAS_VALID_KEY=1
elif grep -qE '^PRIVATE_KEY=0x[0-9a-fA-F]{64}$' .env 2>/dev/null; then
  info ".env already has a PRIVATE_KEY set — leaving it alone."
  HAS_VALID_KEY=1
fi

if [ "$HAS_VALID_KEY" -eq 0 ]; then
  DO_GENERATE=0
  if [ "$GENERATE_WALLET" -eq 1 ]; then
    DO_GENERATE=1
  elif [ "$YES" -eq 0 ]; then
    read -r -p "No wallet configured yet. Generate a new one now? [Y/n] " REPLY
    case "$REPLY" in
      [nN]*) DO_GENERATE=0 ;;
      *) DO_GENERATE=1 ;;
    esac
  fi

  if [ "$DO_GENERATE" -eq 1 ]; then
    info "Generating a new wallet..."
    WALLET_OUTPUT="$(node -e "
      const { Wallet } = require('ethers');
      const w = Wallet.createRandom();
      console.log(w.address);
      console.log(w.privateKey);
    ")"
    WALLET_ADDRESS="$(printf '%s\n' "$WALLET_OUTPUT" | sed -n 1p)"
    WALLET_KEY="$(printf '%s\n' "$WALLET_OUTPUT" | sed -n 2p)"
    sed -i "s|^PRIVATE_KEY=.*|PRIVATE_KEY=${WALLET_KEY}|" .env
    unset WALLET_OUTPUT WALLET_KEY
    info "Wallet generated and saved to .env (the private key is never printed to this terminal)."
    info "Address: ${WALLET_ADDRESS}"
    warn "Fund this address with Robinhood Chain's native gas token before mining for real."
  elif [ "$YES" -eq 0 ]; then
    read -r -s -p "Paste an existing private key (0x..., input hidden), or press Enter to skip: " PASTED_KEY
    echo
    if [ -n "$PASTED_KEY" ]; then
      if node -e "try { new (require('ethers').Wallet)(process.argv[1]); process.exit(0); } catch { process.exit(1); }" "$PASTED_KEY"; then
        sed -i "s|^PRIVATE_KEY=.*|PRIVATE_KEY=${PASTED_KEY}|" .env
        info "Private key saved to .env."
      else
        err "That doesn't look like a valid private key — leaving .env untouched. Edit it manually."
      fi
    else
      warn "Skipped. Edit .env and set PRIVATE_KEY before running \"npm start\"."
    fi
    unset PASTED_KEY
  else
    warn "No PRIVATE_KEY set and running non-interactively — set it as an env var or edit .env manually before running \"npm start\"."
  fi
fi

# ---------------------------------------------------------------------------
# 6. Self-test
# ---------------------------------------------------------------------------
info "Running selftest (verifies the shader's SHA-256 against Node's crypto module)..."
if $NPM_CMD run selftest; then
  info "Selftest passed."
else
  err "Selftest failed — do not mine for real until this passes. See the output above."
  exit 1
fi

if [ "$RUN_BENCH" -eq 1 ]; then
  info "Running bench (measures real GPU hashrate)..."
  $NPM_CMD run bench || warn "Bench reported a problem — see output above before running \"npm start\" unattended."
fi

echo
info "Setup complete. Next steps:"
echo "    npm run bench   # measure your GPU(s) before an unattended run"
echo "    npm start       # mine continuously until Ctrl+C or the supply cap"
