#!/usr/bin/env sh
# bootstrap.sh - Set up local code-server+omp toolchain environment
# Source this to load env, or run with --flags to install tools.
set -eu

_BOOTSTRAP_ARGS="$@"

BUILDER_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_BASE="${CONFIG_BASE:-/config}"

# ── Directory layout ───────────────────────────────────────────────────────
XDG_CONFIG_HOME="${CONFIG_BASE}/.config"
XDG_CACHE_HOME="${CONFIG_BASE}/.cache"
XDG_DATA_HOME="${CONFIG_BASE}/.local/share"
XDG_STATE_HOME="${CONFIG_BASE}/.local/state"
AGENT_CODE_SERVER_CONFIG_CACHE_DIR="${XDG_STATE_HOME}/agent-code-server/config"
AGENT_CODE_SERVER_TMPDIR="${XDG_STATE_HOME}/agent-code-server/tmp"

NPM_CONFIG_PREFIX="${CONFIG_BASE}/.npm-global"
MANAGED_NPM_PREFIX="${CONFIG_BASE}/.npm-global"
NPM_CONFIG_CACHE="${CONFIG_BASE}/.npm"
BUN_INSTALL="${CONFIG_BASE}/.bun"
CARGO_HOME="${CONFIG_BASE}/.cargo"
MANAGED_CARGO_HOME="${CONFIG_BASE}/.cargo"
GOPATH="${CONFIG_BASE}/.go"
GOBIN="${CONFIG_BASE}/.go/bin"
MANAGED_GO_ROOT="${CONFIG_BASE}/.local/go"
PYTHONUSERBASE="${CONFIG_BASE}/.local/pip"
MANAGED_RELEASE_BIN_DIR="${CONFIG_BASE}/.local/bin"
RUSTUP_HOME="${CONFIG_BASE}/.rustup"
MANAGED_RUSTUP_HOME="${CONFIG_BASE}/.rustup"

export PATH="${MANAGED_RELEASE_BIN_DIR}:${MANAGED_NPM_PREFIX}/bin:${MANAGED_GO_ROOT}/bin:${GOBIN}:${CARGO_HOME}/bin:${PYTHONUSERBASE}/bin:${BUN_INSTALL}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

export CONFIG_BASE
export XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
export AGENT_CODE_SERVER_CONFIG_CACHE_DIR AGENT_CODE_SERVER_TMPDIR
export NPM_CONFIG_PREFIX MANAGED_NPM_PREFIX NPM_CONFIG_CACHE BUN_INSTALL CARGO_HOME MANAGED_CARGO_HOME
export GOPATH GOBIN MANAGED_GO_ROOT
export PYTHONUSERBASE MANAGED_RELEASE_BIN_DIR
export RUSTUP_HOME MANAGED_RUSTUP_HOME
export AGENT_CODE_SERVER_CONFIG_SOURCE="baked"

# ── Ensure directories exist ───────────────────────────────────────────────
mkdir -p \
  "${BUN_INSTALL}" \
  "${XDG_CACHE_HOME}" \
  "${CARGO_HOME}/bin" \
  "${XDG_CONFIG_HOME}" \
  "${GOBIN}" \
  "${MANAGED_RELEASE_BIN_DIR}" \
  "${MANAGED_GO_ROOT}/bin" \
  "${PYTHONUSERBASE}/bin" \
  "${XDG_DATA_HOME}" \
  "${XDG_STATE_HOME}/agent-code-server" \
  "${MANAGED_NPM_PREFIX}" \
  "${CONFIG_BASE}/.ssh" \
  "${CONFIG_BASE}/workspaces" 2>/dev/null || true

npm config set prefix "${MANAGED_NPM_PREFIX}" 2>/dev/null || true

# ── Functions ──────────────────────────────────────────────────────────────
install_opencode() {
  if command -v opencode >/dev/null 2>&1; then
    echo "[bootstrap] opencode already available: $(opencode --version 2>&1)"
    return 0
  fi
  echo "[bootstrap] Installing opencode-ai..."
  npm install -g opencode-ai 2>&1
  echo "[bootstrap] opencode-ai installed: $(opencode --version 2>&1)"
}

install_omp() {
  echo "[bootstrap] Installing oh-my-pi (omp) via managed npm tools..."
  cd "${BUILDER_DIR}" && node scripts/managed-npm-tools.mjs init omp
  echo "[bootstrap] omp installed: $(omp --version 2>&1)"
}
install_paseo_skills() {
  echo "[bootstrap] Installing managed Paseo skills..."
  cd "${BUILDER_DIR}" && node scripts/managed-paseo-skills.mjs init
}

init_npm_tools() {
  echo "[bootstrap] Installing managed npm tools..."
  cd "${BUILDER_DIR}" && node scripts/managed-npm-tools.mjs init
}

init_go_tools() {
  echo "[bootstrap] Installing Go toolchain..."
  cd "${BUILDER_DIR}" && node scripts/managed-go-tools.mjs init
}

init_mounted_tools() {
  echo "[bootstrap] Installing managed release binaries..."
  cd "${BUILDER_DIR}" && node scripts/managed-mounted-tools.mjs init
}

# ── Parse flags ───────────────────────────────────────────────────────────
DO_NPM=false
DO_GO=false
DO_MOUNTED=false
DO_ALL=false
DO_OPENCODE=false
DO_OMP=false
DO_PASEO_SKILLS=false

for arg in ${_BOOTSTRAP_ARGS:-}; do
  case "${arg}" in
    --npm-init) DO_NPM=true ;;
    --go-init) DO_GO=true ;;
    --mounted-init) DO_MOUNTED=true ;;
    --all) DO_ALL=true ;;
    --opencode) DO_OPENCODE=true ;;
    --omp) DO_OMP=true ;;
    --paseo-skills) DO_PASEO_SKILLS=true ;;
    --help|-h)
      echo "Usage: source bootstrap.sh  |  bash bootstrap.sh [flags]"
      echo ""
      echo "  --npm-init      Install npm-managed language servers/tools"
      echo "  --go-init       Install Go toolchain + Go tools"
      echo "  --mounted-init  Install release binaries (gh, yq, rg, ...)"
      echo "  --omp           Install oh-my-pi (omp) via managed npm tools"
      echo "  --opencode      Install opencode-ai CLI"
      echo "  --paseo-skills  Install Paseo skills for managed agent CLIs"
      echo "  --all           Install everything above"
      exit 0
      ;;
  esac
done
unset _BOOTSTRAP_ARGS

if [ "${DO_ALL}" = "true" ]; then
  DO_NPM=true; DO_GO=true; DO_MOUNTED=true; DO_OPENCODE=true; DO_OMP=true; DO_PASEO_SKILLS=true
fi

if [ "${DO_OPENCODE}" = "true" ]; then echo ""; echo "=== Installing opencode-ai ==="; install_opencode; fi
if [ "${DO_OMP}" = "true" ]; then echo ""; echo "=== Installing oh-my-pi ==="; install_omp; fi
if [ "${DO_PASEO_SKILLS}" = "true" ]; then echo ""; echo "=== Installing Paseo skills ==="; install_paseo_skills; fi
if [ "${DO_NPM}" = "true" ]; then echo ""; echo "=== Installing npm-managed tools ==="; init_npm_tools; fi
if [ "${DO_GO}" = "true" ]; then echo ""; echo "=== Installing Go toolchain ==="; init_go_tools; fi
if [ "${DO_MOUNTED}" = "true" ]; then echo ""; echo "=== Installing mounted release binaries ==="; init_mounted_tools; fi

echo ""; echo "[bootstrap] Done."
echo "To load the environment: source ${BUILDER_DIR}/bootstrap.sh"
