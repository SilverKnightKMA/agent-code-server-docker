# agent-code-server Docker Builder

Builder-owned Docker packaging for **code-server** (VS Code in browser) plus AI coding agents (omp, pi, and more), with [Paseo](https://github.com/getpaseo/paseo) baked in as a second Tier 1 service for orchestrating those agents.

## Three-tier tool architecture

| Tier | Description | Examples | Setup |
|------|-------------|----------|-------|
| **Baked-in** | Bundled in image, always available | code-server, Paseo, Node.js, Bun, Python, Git, tmux, system tools | Image build time |
| **Managed mounted** | Version-pinned, installed on demand into persisted volumes | omp, pi, opencode, claude, codex, droid, copilot, TypeScript LSP, ESLint, Go, Rust, gh, yq, ripgrep | `AGENT_CODE_SERVER_AUTOINSTALL=true` or run `npm run managed-tools:init` |
| **Custom mounted** | User-installed via package managers | `npm install -g`, `go install`, `cargo install`, `pip install --user` | Direct commands |

## Quick start with Docker

```bash
# Clone this repo
git clone https://github.com/SilverKnightKMA/agent-code-server-docker.git
cd agent-code-server-docker

# Build from upstream code-server source
# Requires coder/code-server checkout as build context
docker build \
  -f Dockerfile.dockerfile \
  --build-context toolchain=. \
  -t agent-code-server:local \
  .

# Or build from this repo alone (no code-server source needed)
docker build -f Dockerfile.dockerfile -t agent-code-server:local .

# Start container
mkdir -p data/workspaces data/ssh
docker compose up -d
```

## Local development (no Docker)

```bash
# Source environment
source bootstrap.sh

# Install everything
bash bootstrap.sh --all

# Or selective install
bash bootstrap.sh --npm-init    # TypeScript, ESLint, Prettier, etc.
bash bootstrap.sh --go-init     # Go toolchain + gopls
bash bootstrap.sh --mounted-init  # gh, yq, ripgrep, hadolint
bash bootstrap.sh --omp         # omp/pi CLI (managed npm tool)

# Check tool status
npm run managed-tools:status
npm run managed-tools:compare
```

## Managed tool versions

| Family | Tools | Versions |
|--------|-------|----------|
| npm | pyright, eslint, prettier, typescript, typescript-language-server, yaml-language-server, bash-language-server, omp, pi, opencode, claude, codex, droid, copilot | Pinned in `managed-tools/manifest.json` |
| go_toolchain | go | Latest stable |
| go_tools | gopls, shfmt | Pinned |
| gh | GitHub CLI | Pinned |
| release_binaries | yq, ripgrep, actionlint, hadolint | Pinned |
| rustup | rustc, cargo | Stable channel |

## Container structure

```
/home/coder/
  .npm-global/     ← npm global packages (managed/custom)
  .local/
    bin/           ← release binaries (managed)
    go/            ← Go toolchain (managed)
    pip/           ← Python user packages (custom)
  .go/bin/         ← Go tools (managed)
  .cargo/          ← Rust tools (managed/custom)
  .bun/            ← Bun runtime (managed)
  .rustup/         ← Rustup (managed)
  .config/         ← Configs (mounted)
  .ssh/            ← SSH keys (mounted)
  .paseo/          ← Paseo daemon state (mounted, PASEO_HOME)
  .claude/         ← Claude Code credentials (mounted)
  .codex/          ← Codex credentials (mounted)
  workspaces/      ← Code (mounted)
  entrypoint.d/    ← Startup hooks (mounted, optional)

/opt/paseo/        ← Paseo CLI + server (baked, Tier 1 — outside any Tier 2/3 mount point)
```

## Managed tools config

The managed-tools scripts (`npm run managed-tools:status`, `:init`) fetch their
manifest and policy from an **online upstream** by default:

```
https://raw.githubusercontent.com/SilverKnightKMA/agent-code-server-docker/main/managed-tools/{manifest,policy}.json
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_CODE_SERVER_MANAGED_TOOLS_BASE_URL` | `https://raw.githubusercontent.com/SilverKnightKMA/…` | Upstream base URL for config files |
| `AGENT_CODE_SERVER_MANAGED_TOOLS_CONFIG_MODE` | `auto` | `online` — require upstream, fail on error; `baked` — skip upstream, use baked config directly; `auto` — upstream with no fallback unless overridden |
| `AGENT_CODE_SERVER_MANAGED_TOOLS_ALLOW_BAKED_FALLBACK` | `false` | When `true`, fall back to baked config if upstream fetch fails (offline/emergency mode only) |
| `AGENT_CODE_SERVER_CONFIG_BASE_URL` | (same as `MANAGED_TOOLS_BASE_URL`) | Legacy alias |
| `AGENT_CODE_SERVER_CONFIG_SOURCE` | `auto` | Legacy alias for `MANAGED_TOOLS_CONFIG_MODE` |

### Behavior

- **Normal (healthy) mode**: `AGENT_CODE_SERVER_MANAGED_TOOLS_CONFIG_MODE=auto` (default).
  Managed-tools fetch config from upstream. If upstream fails, the command **fails**
  — it does not silently fall back to baked config. This ensures the container
  always uses the published manifest/policy from the repo.

- **Online-only mode**: `AGENT_CODE_SERVER_MANAGED_TOOLS_CONFIG_MODE=online`.
  Same as auto but explicitly enforced. Fails hard on fetch error (no cache, no baked).

- **Baked-only mode**: `AGENT_CODE_SERVER_MANAGED_TOOLS_CONFIG_MODE=baked`.
  Skips upstream entirely. Uses config baked into the image. Useful during
  image development or when upstream is unreachable.

- **Emergency fallback**: Set `AGENT_CODE_SERVER_MANAGED_TOOLS_ALLOW_BAKED_FALLBACK=true`
  to allow falling back through cache → baked config when upstream fetch fails.
  Intended for offline/gateway environments only.
