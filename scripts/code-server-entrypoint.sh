#!/usr/bin/env sh
set -eu

# code-server-omp-entrypoint
# ==========================
# Mirrors code-server upstream entrypoint behavior while adding:
#   - oh-my-pi (omp) CLI availability
#   - Optional Docker-in-Docker (ENABLE_DIND=true)
#   - Optional managed tools autoinstall (CODE_SERVER_OMP_AUTOINSTALL=true)
#   - Entrypoint.d user script hooks

# ── prepend_path_dir: add a directory to the front of PATH, avoiding dupes ──
prepend_path_dir() {
  clean_path=""
  old_ifs="${IFS}"
  IFS=:
  for path_entry in ${PATH:-}; do
    [ "${path_entry}" = "$1" ] && continue
    clean_path="${clean_path:+${clean_path}:}${path_entry}"
  done
  IFS="${old_ifs}"
  PATH="$1${clean_path:+:${clean_path}}"
}

for managed_path_dir in \
  /home/coder/.bun/bin \
  /home/coder/.local/pip/bin \
  /home/coder/.cargo/bin \
  /home/coder/.go/bin \
  /home/coder/.local/go/bin \
  /home/coder/.npm-global/bin \
  /home/coder/.local/bin
do
  prepend_path_dir "${managed_path_dir}"
done
export PATH

if [ "${CODE_SERVER_OMP_DEBUG:-false}" = "true" ]; then
  echo "[debug] entrypoint user=$(id -un 2>/dev/null || echo unknown) uid=$(id -u) gid=$(id -g) groups=$(id -Gn 2>/dev/null || echo unknown)"
  echo "[debug] env USER=${USER:-unset} HOME=${HOME:-unset} DOCKER_USER=${DOCKER_USER:-unset} ENABLE_DIND=${ENABLE_DIND:-unset} DOCKER_HOST=${DOCKER_HOST:-unset}"
  echo "[debug] binaries docker=$(command -v docker 2>/dev/null || echo missing) dockerd=$(command -v dockerd 2>/dev/null || echo missing) fixuid=$(command -v fixuid 2>/dev/null || echo missing) gosu=$(command -v gosu 2>/dev/null || echo missing) sudo=$(command -v sudo 2>/dev/null || echo missing)"
fi

# ── Optional: Docker-in-Docker (must run as root, before fixuid) ───────────
if [ "${ENABLE_DIND:-false}" = "true" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[dind] ENABLE_DIND=true requires the container to start as root. Add 'user: root' to docker-compose.yml for DinD deployments." >&2
    exit 1
  fi

  mkdir -p /var/lib/docker /var/lib/containerd /run /var/run
  chown -R root:root /var/lib/docker /var/lib/containerd
  rm -f /var/run/docker.pid /var/run/docker/libnetwork/docker.pid 2>/dev/null

  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"

  if ! docker info >/dev/null 2>&1; then
    echo "[dind] starting dockerd..."
    dockerd ${DOCKERD_ARGS:-} &

    tries=0
    until docker info >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "${tries}" -ge "${DIND_STARTUP_TIMEOUT_SECONDS:-60}" ]; then
        echo "[dind] dockerd did not become ready after ${tries}s" >&2
        exit 1
      fi
      sleep 1
    done
    echo "[dind] dockerd is ready"
  else
    echo "[dind] docker daemon already reachable"
  fi
fi

# ── Run fixuid (maps container UID to host-mounted UID) ─────────────────────
# This must happen early so sudo permissions work correctly.
eval "$(fixuid -q)"


# ── Optional: DOCKER_USER remapping ────────────────────────────────────────
if [ "${DOCKER_USER-}" ] && [ "$(id -u)" -eq 0 ]; then
  USER="$DOCKER_USER"
  if [ -z "$(id -u "$DOCKER_USER" 2>/dev/null)" ]; then
    usermod --login "$DOCKER_USER" coder
    groupmod -n "$DOCKER_USER" coder
  fi
  fi


# ── Ensure home directory ownership ────────────────────────────────────
# Mounted volumes may have host UID/GID; fixuid handles top-level home,
# but subdirs like .config/code-server need to exist and be writable.
RUN_USER="${USER:-coder}"
RUN_HOME="$(getent passwd "${RUN_USER}" 2>/dev/null | cut -d: -f6 || echo /home/coder)"

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "${RUN_HOME}/.config/code-server" \
           "${RUN_HOME}/.local/share/code-server" \
           "${RUN_HOME}/.cache/code-server" 2>/dev/null
  chown -R "${RUN_USER}:${RUN_USER}" "${RUN_HOME}/.config" \
           "${RUN_HOME}/.local" \
           "${RUN_HOME}/.cache" 2>/dev/null
fi

# ── Optional: managed tools autoinstall ────────────────────────────────────
if [ "${CODE_SERVER_OMP_AUTOINSTALL:-false}" = "true" ]; then
  echo "[managed-tools] installing missing or outdated managed tools..."
  if [ "$(id -u)" -eq 0 ]; then
    gosu "${USER:-coder}" env PATH="${PATH}" npm run --prefix /opt/code-server-omp/managed-tools managed-tools:init
  else
    npm run --prefix /opt/code-server-omp/managed-tools managed-tools:init
  fi
fi


# ── Entrypoint.d user hooks ────────────────────────────────────────────────
# Users can mount executable scripts into /home/coder/entrypoint.d/
# to customize workspace initialization (e.g., clone repos, set up git).
if [ -d "${ENTRYPOINTD}" ]; then
  find "${ENTRYPOINTD}" -maxdepth 1 -type f -executable -print -exec {} \;
fi

# ── Launch code-server ─────────────────────────────────────────────────────
# Drop privileges if running as root, then start code-server.
if [ "$(id -u)" -eq 0 ]; then
  exec gosu "${USER:-coder}" dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "$@"
fi

exec dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "$@"
