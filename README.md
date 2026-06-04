# agent-code-server-docker

code-server (VS Code in browser) with your choice of AI coding agents (omp, pi, and more) in a single Docker image, with 3-tier tooling and optional DinD.

## Requirements

- Docker Engine + Docker Compose
- ~4GB RAM, ~2GB disk

## Quick start

```bash
git clone https://github.com/SilverKnightKMA/agent-code-server-docker.git
cd agent-code-server-docker

# 1. Create all data directories (including dedicated code-server mounts)
mkdir -p \
  data/workspaces \
  data/ssh \
  data/config/git data/config/gh data/config/code-server \
  data/code-server-data data/code-server-cache \
  data/npm-global data/bun \
  data/local-bin data/local-go data/local-pip \
  data/cargo data/rustup data/go \
  data/agent-code-server-cache data/tmux-state \
  data/entrypoint.d

# 2. Set ownership (UID 1000 = coder inside container)
# Skip if data/ does not exist yet; run after first creation.
sudo chown -R 1000:1000 \
  data/workspaces \
  data/ssh \
  data/config data/code-server-data data/code-server-cache \
  data/npm-global data/bun \
  data/local-bin data/local-go data/local-pip \
  data/cargo data/rustup data/go \
  data/agent-code-server-cache data/tmux-state \
  data/entrypoint.d

# DO NOT chown /var/lib/docker or /var/lib/containerd

# 3. Build image
docker compose build

# 4. Start container
docker compose up -d

# 5. Open http://localhost:8880
```

By default, `omp` and other managed tools are only installed into the volume when you set `AGENT_CODE_SERVER_AUTOINSTALL: "true"` in compose or run `npm run --prefix /opt/agent-code-server/managed-tools managed-tools:init` inside the container.

## Host-side preparation (details)

### Create data directories

All volume mounts need corresponding host directories. If missing, Docker creates them with `root:root` ownership. When the container runs with `user: root` (required for DinD), the entrypoint creates subdirectories and chowns them. However, host-prep avoids errors from the start.

### Set ownership

UID 1000 inside the container is `coder`. To make bind-mounted directories writable:

```bash
sudo chown 1000:1000 \
  data/workspaces \
  data/config data/code-server-data data/code-server-cache \
  data/npm-global data/bun \
  data/local-bin data/local-go data/local-pip \
  data/cargo data/rustup data/go \
  data/agent-code-server-cache data/tmux-state \
  data/entrypoint.d
```

### SSH keys

```bash
cp -r ~/.ssh/* data/ssh/
chmod 600 data/ssh/*
chown -R 1000:1000 data/ssh
```

### Git config

```bash
cp ~/.gitconfig data/config/git/config
chown -R 1000:1000 data/config/git
```

## After container starts

```bash
docker compose logs -f                    # Follow logs
docker compose exec -u coder agent-code-server bash   # Enter container
```

### Check DinD

```bash
docker compose exec agent-code-server docker info
docker compose exec agent-code-server docker compose version
```

## Docker-in-Docker

By default the container runs with `USER root`; entrypoint starts DinD if env is set.
code-server always runs as user `coder` via `gosu`.

Enable DinD by uncommenting in `docker-compose.yml`:

```yaml
environment:
  ENABLE_DIND: "true"

# service level:
privileged: true
security_opt:
  - no-new-privileges:false

volumes:
  - ./data/docker:/var/lib/docker
  - ./data/containerd:/var/lib/containerd
```

The container must run as root for dockerd to start. `coder` is added to the `docker`
group so it can run `docker info` without sudo.

Without DinD → no privileged mode needed, workloads run safely.

## Diagnostics

If you still encounter EACCES errors, enter the container:

```bash
docker compose exec agent-code-server bash -c 'id; ls -ldn /home/coder /home/coder/.config /home/coder/.local /home/coder/.cache /home/coder/.config/code-server'
```

Expected output:
```
uid=1000(coder) gid=1000(coder) groups=1000(coder),xxx(docker)
drwxr-xr-x 0 0 ... /home/coder
drwxr-xr-x 1000 1000 ... /home/coder/.config
drwxr-xr-x 1000 1000 ... /home/coder/.config/code-server
drwxr-xr-x 1000 1000 ... /home/coder/.local
drwxr-xr-x 1000 1000 ... /home/coder/.cache
```

## 3-tier architecture

| Tier | Examples | Persist |
|------|----------|---------|
| **1. Baked-in** | code-server, Node.js, Bun, Python, Git, tmux, Docker CLI | In image |
| **2. Managed mounted** | omp, pi, TypeScript LSP, Go, Rust, gh, yq, ripgrep | Volume data/ |
| **3. Custom mounted** | npm install -g, go install, cargo install | Volume data/ |

## Ports

- `8080` (default), mapped to `8880` in the sample compose
