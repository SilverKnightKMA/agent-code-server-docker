# code-server-omp Docker Builder

Builder-owned Docker packaging for **code-server** (VS Code in browser) plus **oh-my-pi** (omp) coding agent.

## Three-tier tool architecture

| Tier | Description | Examples | Setup |
|------|-------------|----------|-------|
| **Baked-in** | Bundled in image, always available | code-server, omp, Node.js, Bun, Python, Git, system tools | Image build time |
| **Managed mounted** | Version-pinned, installed on demand into persisted volumes | TypeScript LSP, ESLint, Go, Rust, gh, yq, ripgrep | `CODE_SERVER_OMP_AUTOINSTALL=true` or run `npm run managed-tools:init` |
| **Custom mounted** | User-installed via package managers | `npm install -g`, `go install`, `cargo install`, `pip install --user` | Direct commands |

## Quick start with Docker

```bash
# Clone this repo
git clone https://github.com/code-server-omp/code-server-omp-docker.git
cd code-server-omp-docker

# Build from upstream code-server source
# Requires coder/code-server checkout as build context
docker build \
  -f Dockerfile.dockerfile \
  --build-context toolchain=. \
  -t code-server-omp:local \
  .

# Or build from this repo alone (no code-server source needed)
docker build -f Dockerfile.dockerfile -t code-server-omp:local .

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
bash bootstrap.sh --omp         # oh-my-pi CLI

# Check tool status
npm run managed-tools:status
npm run managed-tools:compare
```

## Managed tool versions

| Family | Tools | Versions |
|--------|-------|----------|
| npm | pyright, eslint, prettier, typescript, typescript-language-server, yaml-language-server, bash-language-server | Pinned in `managed-tools/manifest.json` |
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
  workspaces/      ← Code (mounted)
  entrypoint.d/    ← Startup hooks (mounted, optional)
```

## Managed tools config

The managed-tools scripts (`npm run managed-tools:status`, `:init`) fetch their
manifest and policy from an **online upstream** by default:

```
https://raw.githubusercontent.com/SilverKnightKMA/code-server-omp-docker/main/managed-tools/{manifest,policy}.json
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODE_SERVER_OMP_MANAGED_TOOLS_BASE_URL` | `https://raw.githubusercontent.com/SilverKnightKMA/…` | Upstream base URL for config files |
| `CODE_SERVER_OMP_MANAGED_TOOLS_CONFIG_MODE` | `auto` | `online` — require upstream, fail on error; `baked` — skip upstream, use baked config directly; `auto` — upstream with no fallback unless overridden |
| `CODE_SERVER_OMP_MANAGED_TOOLS_ALLOW_BAKED_FALLBACK` | `false` | When `true`, fall back to baked config if upstream fetch fails (offline/emergency mode only) |
| `CODE_SERVER_OMP_CONFIG_BASE_URL` | (same as `MANAGED_TOOLS_BASE_URL`) | Legacy alias |
| `CODE_SERVER_OMP_CONFIG_SOURCE` | `auto` | Legacy alias for `MANAGED_TOOLS_CONFIG_MODE` |

### Behavior

- **Normal (healthy) mode**: `CODE_SERVER_OMP_MANAGED_TOOLS_CONFIG_MODE=auto` (default).
  Managed-tools fetch config from upstream. If upstream fails, the command **fails**
  — it does not silently fall back to baked config. This ensures the container
  always uses the published manifest/policy from the repo.

- **Online-only mode**: `CODE_SERVER_OMP_MANAGED_TOOLS_CONFIG_MODE=online`.
  Same as auto but explicitly enforced. Fails hard on fetch error (no cache, no baked).

- **Baked-only mode**: `CODE_SERVER_OMP_MANAGED_TOOLS_CONFIG_MODE=baked`.
  Skips upstream entirely. Uses config baked into the image. Useful during
  image development or when upstream is unreachable.

- **Emergency fallback**: Set `CODE_SERVER_OMP_MANAGED_TOOLS_ALLOW_BAKED_FALLBACK=true`
  to allow falling back through cache → baked config when upstream fetch fails.
  Intended for offline/gateway environments only.
