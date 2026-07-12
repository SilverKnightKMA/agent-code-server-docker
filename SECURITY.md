# Security

## Docker-in-Docker

Docker-in-Docker (`ENABLE_DIND=true`) requires a privileged container. Only enable this in trusted deployments where all users inside the container are authorized to run Docker commands on the host.

## Image contents

- code-server runs as non-root user `coder` (UID 1000).
- oh-my-pi (omp) is a Bun/Node.js CLI — it runs within the user's shell context.
- Paseo (the agent orchestration daemon + web UI) also runs as the `coder`
  user, in the same container as code-server, on the same
  `/home/coder/workspaces`. It has no additional isolation boundary from
  code-server — anything Paseo can launch (the Tier 2 agent CLIs) has the
  same read/write access to the workspace and credentials that code-server's
  integrated terminal already has.
- Managed tools are downloaded from official upstream sources with SHA-256 verification.
- No arbitrary code execution in build process; all packages are pinned by version and checksummed where possible.

## Exposed ports

- `8080`: code-server web UI. Secure with a reverse proxy (Caddy, nginx) and authentication in production.
- `6767`: Paseo daemon + web UI. Set `PASEO_PASSWORD` before exposing this
  port beyond localhost — without it, Paseo logs a warning and accepts
  unauthenticated control connections from any client that can reach it. Set
  `PASEO_HOSTNAMES` if served through a reverse-proxied DNS name.
