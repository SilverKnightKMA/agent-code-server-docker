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
