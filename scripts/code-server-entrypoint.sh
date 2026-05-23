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

# ── Optional: Docker-in-Docker (must run as root, before fixuid) ───────────
if [ "${ENABLE_DIND:-false}" = "true" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[dind] ENABLE_DIND=true requires root entrypoint" >&2
    exit 1
  fi

  mkdir -p /var/lib/docker /var/lib/containerd /run /var/run
  chown -R root:root /var/lib/docker /var/lib/containerd

  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"

  if ! docker info >/dev/null 2>&1; then
    echo "[dind] starting dockerd..."
    # shellcheck disable=SC2086
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
if [ "${DOCKER_USER-}" ]; then
  USER="$DOCKER_USER"
  if [ -z "$(id -u "$DOCKER_USER" 2>/dev/null)" ]; then
    echo "$DOCKER_USER ALL=(ALL) NOPASSWD:ALL" | sudo tee -a /etc/sudoers.d/nopasswd > /dev/null
    sudo usermod --login "$DOCKER_USER" coder
    sudo groupmod -n "$DOCKER_USER" coder
    sudo sed -i "/coder/d" /etc/sudoers.d/nopasswd
  fi
fi

# ── Optional: managed tools autoinstall ────────────────────────────────────
if [ "${CODE_SERVER_OMP_AUTOINSTALL:-false}" = "true" ]; then
  echo "[managed-tools] installing missing or outdated managed tools..."
  if [ "$(id -u)" -eq 0 ]; then
    sudo -E -u coder env PATH="${PATH}" npm run --prefix /opt/code-server-omp/managed-tools managed-tools:init
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
  exec sudo -E -u coder env PATH="${PATH}" dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "$@"
fi

exec dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "$@"
