# agent-code-server-docker

code-server (VS Code in browser) with your choice of AI coding agents (omp, pi, and more) in a single Docker image, with 3-tier tooling and optional DinD. Also bakes in [Paseo](https://github.com/getpaseo/paseo), a daemon + web UI for orchestrating those agents, running alongside code-server in the same container.

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
  data/entrypoint.d \
  data/paseo data/config/claude data/config/codex data/pi data/omp data/factory data/opencode data/config/opencode

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
  data/entrypoint.d \
  data/paseo data/config/claude data/config/codex data/pi data/omp data/factory data/opencode data/config/opencode

# DO NOT chown /var/lib/docker or /var/lib/containerd

# 3. Build image
docker compose build

# 4. Start container
docker compose up -d

# 5. Open http://localhost:8880
```

By default, `omp` and other managed tools are only installed into the volume when you set `AGENT_CODE_SERVER_AUTOINSTALL: "true"` in compose or run `npm run --prefix /opt/agent-code-server/managed-tools managed-tools:init` inside the container. That managed init now also installs the mounted Paseo skills pack and the `pi-mcp-adapter` Pi extension for the managed agent CLIs.

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
  data/entrypoint.d \
  data/paseo data/config/claude data/config/codex data/pi data/omp data/factory data/opencode data/config/opencode
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

### DinD DNS bridge

Containers spawned by the nested DinD daemon cannot reach `127.0.0.11` (the outer
daemon's embedded DNS) — it is loopback, isolated per network namespace. Without help,
DinD containers fall back to public DNS and fail to resolve outer container names
(siblings on the host network) or the host's search-domain names.

When `ENABLE_DIND=true` (and `DIND_DNS` is not `false`), the entrypoint:

1. Computes the DinD `docker0` gateway (from the `bip` in `/etc/docker/daemon.json`,
   defaulting to `172.17.0.1`).
2. Starts a `dnsmasq` forwarder bound to that gateway, forwarding to `127.0.0.11`
   (reachable in the container's netns).
3. Merges `"dns": [<gateway>]` into `/etc/docker/daemon.json` so every DinD-spawned
   container inherits the forwarder via `resolv.conf`.

This lets DinD containers resolve outer container names (e.g. `mt5_3`), host
search-domain names (e.g. Tailscale `ser6`), and public names. Set `DIND_DNS=false`
to disable.

> **Limitation — user-defined (custom) networks.** Docker pins the embedded DNS
> resolver (`127.0.0.11`) for containers attached to user-defined networks and
> ignores the daemon-wide `dns` setting, `docker run --dns`, compose `dns:`, and
> `docker network create --opt` for those networks. The DNS bridge above therefore
> only covers containers on the **default bridge** (i.e. spawned without a
> `--network` flag, or with `--network bridge`). If your DinD workload attaches
> containers to a user-defined network, outer container names will not resolve —
> use the default bridge or `--network host` instead.

### Avoiding CIDR collisions

If the host network overlaps with the default DinD bridge (`172.17.0.0/16`), mount a
custom `/etc/docker/daemon.json` to change the bridge CIDR (`bip`) and
`default-address-pools`. The entrypoint merges its `dns` key into your file, so both
concerns coexist:

```yaml
volumes:
  - ./dockerd-daemon.example.json:/etc/docker/daemon.json:ro
```

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
| **1. Baked-in** | code-server, Paseo, Node.js, Bun, Python, Git, tmux, Docker CLI | In image |
| **2. Managed mounted** | omp, pi, opencode, claude, codex, droid, copilot, TypeScript LSP, Go, Rust, gh, yq, ripgrep, Paseo skills, pi-mcp-adapter | Volume data/ |
| **3. Custom mounted** | npm install -g, go install, cargo install | Volume data/ |

## Paseo

[Paseo](https://github.com/getpaseo/paseo) is baked into the image (Tier 1,
alongside code-server) and starts automatically with the container. It shares
the same `coder` user/home as code-server, so it can launch any of the Tier 2
agent CLIs (`omp`, `pi`, `opencode`, `claude`, `codex`, `droid`, `copilot`) already on
`PATH` against the same `/home/coder/workspaces` that code-server edits.

- Web UI: `http://localhost:6767`
- Set `PASEO_PASSWORD` in compose before exposing port 6767 beyond localhost —
  without it the daemon logs a warning and accepts unauthenticated control
  connections.
- Set `PASEO_HOSTNAMES` if you reach it through a reverse-proxied DNS name.
- Daemon state and agent credentials persist under `data/paseo`,
  `data/config/claude`, `data/config/codex`, `data/pi`, `data/omp`,
  `data/factory`, `data/opencode`, `data/config/opencode` (mounted to
  `~/.paseo`, `~/.claude`, `~/.codex`, `~/.pi`, `~/.omp`, `~/.factory`,
  `~/.local/share/opencode`, `~/.config/opencode` respectively). Each
  agent CLI has its own convention — `codex`/`claude` use dedicated
  dotdirs, `omp`/`pi` use `~/.omp`/`~/.pi`, `droid` uses `~/.factory`,
  and `opencode` follows the XDG base dir spec: **config** (`opencode.jsonc`,
  providers, models) lives under `$XDG_CONFIG_HOME/opencode`
  (`~/.config/opencode`) while **data** (session DB, logs) lives under
  `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode`). Both dirs must be
  mounted or your opencode config resets to defaults on every container
  restart. Check upstream source before assuming a new agent follows one
  of these same conventions.
- Paseo skills are treated as a required **managed mounted** companion config for those agent CLIs, not as a baked image asset. They persist in the mounted home volume (`~/.agents/skills` as the canonical copy, symlinked into each agent's skill root) and update through `managed-tools:init` / `managed-tools:status` / `managed-tools:compare` against the pinned `managed-tools/manifest.json` version. The skill pack itself is **not baked into the image filesystem** — it is cloned at the pinned tag from `getpaseo/paseo` and kept current exactly like other mounted tooling.

### Self-hosted relay server (optional)

The image also bundles [paseo-relay](https://github.com/zenghongtu/paseo-relay),
a zero-knowledge WebSocket relay that bridges the Paseo daemon and the mobile
app when they cannot connect directly. It is disabled by default.

To enable, set `ENABLE_PASEO_RELAY=true` and expose port `8411` in compose:

```yaml
ports:
  - "8411:8411"
environment:
  ENABLE_PASEO_RELAY: "true"
```

Then point the Paseo daemon at the relay by adding to `~/.paseo/config.json`:

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "your-host:8411",
      "publicEndpoint": "your-host:8411"
    }
  }
}
```

The relay is untrusted by design — all traffic is E2E encrypted by Paseo.
TLS should be terminated upstream (nginx, Caddy, Cloudflare Tunnel, etc.);
do not expose the relay over plain HTTP in production.

## Ports

- `8080` (default), mapped to `8880` in the sample compose — code-server
- `6767` — Paseo daemon + web UI
- `8411` — Paseo self-hosted relay server (disabled by default, enable with `ENABLE_PASEO_RELAY=true`)
