# Security

## Docker-in-Docker

Docker-in-Docker (`ENABLE_DIND=true`) requires a privileged container. Only enable this in trusted deployments where all users inside the container are authorized to run Docker commands on the host.

## Image contents

- code-server runs as non-root user `coder` (UID 1000).
- oh-my-pi (omp) is a Node.js CLI — it runs within the user's shell context.
- Managed tools are downloaded from official upstream sources with SHA-256 verification.
- No arbitrary code execution in build process; all packages are pinned by version and checksummed where possible.

## Exposed ports

- `8080`: code-server web UI. Secure with a reverse proxy (Caddy, nginx) and authentication in production.
