#!/usr/bin/env sh
set -eu

# code-server-omp-entrypoint
# ==========================
# Mirrors code-server upstream entrypoint behavior while adding:
#   - oh-my-pi (omp) CLI availability
#   - Optional Docker-in-Docker (ENABLE_DIND=true)
#   - Optional managed tools autoinstall (CODE_SERVER_OMP_AUTOINSTALL=true)
#   - Entrypoint.d user script hooks
#   - Idempotent writable directory preparation for bind-mounted paths

RC=0

# ── Helper: prepend a directory to PATH, avoiding dupes ────────────────────
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

# ── Debug info (always printed when ENABLE_DIND=true) ──────────────────────
if [ "${ENABLE_DIND:-false}" = "true" ] || [ "${CODE_SERVER_OMP_DEBUG:-false}" = "true" ]; then
  echo "[entrypoint] user=$(id -un 2>/dev/null || echo unknown) uid=$(id -u) gid=$(id -g)"
  echo "[entrypoint] HOME=${HOME:-unset} USER=${USER:-unset} DOCKER_USER=${DOCKER_USER:-unset} ENABLE_DIND=${ENABLE_DIND:-unset}"
  echo "[entrypoint] binaries: docker=$(command -v docker), dockerd=$(command -v dockerd), gosu=$(command -v gosu)"
fi

# ── Optional: Docker-in-Docker (must run as root) ──────────────────────────
if [ "${ENABLE_DIND:-false}" = "true" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[FATAL] ENABLE_DIND=true requires the container to start as root (compose 'user: root')." >&2
    exit 1
  fi

  # Ensure docker group for socket access
  if ! getent group docker >/dev/null 2>&1; then
    groupadd -r docker
  fi

  mkdir -p /var/lib/docker /var/lib/containerd /run /var/run
  chown -R root:root /var/lib/docker /var/lib/containerd
  rm -f /var/run/docker.pid 2>/dev/null
  rm -f /var/run/docker/containerd/containerd.pid 2>/dev/null
  rm -f /var/run/docker/containerd/*.pid 2>/dev/null

  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"

  if ! docker info >/dev/null 2>&1; then
    echo "[dind] starting dockerd..."
    dockerd ${DOCKERD_ARGS:-} &

    tries=0
    until docker info >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "${tries}" -ge "${DIND_STARTUP_TIMEOUT_SECONDS:-60}" ]; then
        echo "[FATAL] dockerd did not become ready after ${tries}s" >&2
        exit 1
      fi
      sleep 1
    done
    echo "[dind] dockerd is ready"
  else
    echo "[dind] docker daemon already reachable"
  fi

  # Make /var/run/docker.sock accessible to coder via docker group
  if [ -S /var/run/docker.sock ]; then
    chown root:docker /var/run/docker.sock
    chmod 0660 /var/run/docker.sock
  fi
fi

# ── Run fixuid (maps container UID to host-mounted UID) ─────────────────────
eval "$(fixuid -q)"

# ── Optional: DOCKER_USER remapping ────────────────────────────────────────
if [ "${DOCKER_USER-}" ] && [ "$(id -u)" -eq 0 ]; then
  USER="$DOCKER_USER"
  if [ -z "$(id -u "$DOCKER_USER" 2>/dev/null)" ]; then
    usermod --login "$DOCKER_USER" coder
    groupmod -n "$DOCKER_USER" coder
    # Re-map docker group for the renamed user
    if getent group docker >/dev/null 2>&1; then
      usermod -aG docker "${DOCKER_USER}" 2>/dev/null || true
    fi
  fi
fi

# ── Resolve the runtime user (after DOCKER_USER remap or fixuid) ──────────
if [ -n "${DOCKER_USER-}" ]; then
  RUN_USER="${DOCKER_USER}"
elif [ "$(id -u)" -eq 0 ] && [ -z "${USER:-}" ]; then
  RUN_USER="coder"
elif [ -n "${USER:-}" ]; then
  RUN_USER="${USER}"
else
  RUN_USER="coder"
fi
export RUN_USER
echo "[entrypoint] runtime user: ${RUN_USER}"

# ── Make coder a member of the docker group (if DinD active) ───────────────
if [ "${ENABLE_DIND:-false}" = "true" ] && getent group docker >/dev/null 2>&1; then
  if ! id -nG "${RUN_USER}" 2>/dev/null | grep -qw docker; then
    usermod -aG docker "${RUN_USER}" 2>/dev/null || true
  fi
fi

# ── Ensure all needed writable directories exist ──────────────────────────
# Bind-mounted volumes retain host ownership; root must create subdirs once.
HOME_DIR="/home/${RUN_USER}"
[ -d "${HOME_DIR}" ] || HOME_DIR="/home/coder"

DIR_PREP_OK=true
for dir in \
  "${HOME_DIR}/.config" \
  "${HOME_DIR}/.config/code-server" \
  "${HOME_DIR}/.local" \
  "${HOME_DIR}/.local/share" \
  "${HOME_DIR}/.local/share/code-server" \
  "${HOME_DIR}/.local/state" \
  "${HOME_DIR}/.cache" \
  "${HOME_DIR}/.cache/code-server" \
  "${HOME_DIR}/workspaces"
do
  if [ ! -d "${dir}" ]; then
    if ! mkdir -p "${dir}" 2>/dev/null; then
      echo "[FATAL] mkdir failed: ${dir}"
      DIR_PREP_OK=false
    fi
  fi
  if ! chown "${RUN_USER}:${RUN_USER}" "${dir}" 2>/dev/null; then
    # chown may fail on bind-mounted root-owned parent; non-fatal if dir
    # became writable via gosu at runtime.
    echo "[warn] chown failed: ${dir} (parent mount may be root-only)"
  fi
done

# Also ensure managed tool paths exist (may be bind-mounted empty)
for tool_dir in \
  "${HOME_DIR}/.npm-global" \
  "${HOME_DIR}/.bun" \
  "${HOME_DIR}/.local/bin" \
  "${HOME_DIR}/.local/go" \
  "${HOME_DIR}/.local/pip" \
  "${HOME_DIR}/.cargo" \
  "${HOME_DIR}/.cargo/bin" \
  "${HOME_DIR}/.rustup" \
  "${HOME_DIR}/.go" \
  "${HOME_DIR}/.go/bin"
do
  if [ ! -d "${tool_dir}" ]; then
    mkdir -p "${tool_dir}" 2>/dev/null || true
    chown "${RUN_USER}:${RUN_USER}" "${tool_dir}" 2>/dev/null || true
  fi
done

if [ "${DIR_PREP_OK}" = "false" ]; then
  echo "[FATAL] Some required directories could not be created. Diagnostics:" >&2
  for p in /home/coder "${HOME_DIR}" "${HOME_DIR}/.config" "${HOME_DIR}/.local" "${HOME_DIR}/.cache"; do
    ls -ldn "${p}" 2>/dev/null || echo "  ${p}: (does not exist)"
  done
  df -h "${HOME_DIR}" 2>/dev/null || true
  exit 1
fi

# ── Optional: managed tools autoinstall ────────────────────────────────────
if [ "${CODE_SERVER_OMP_AUTOINSTALL:-false}" = "true" ]; then
  echo "[managed-tools] installing missing or outdated managed tools..."
  if [ "$(id -u)" -eq 0 ]; then
    gosu "${RUN_USER}" env PATH="${PATH}" npm run --prefix /opt/code-server-omp/managed-tools managed-tools:init
  else
    npm run --prefix /opt/code-server-omp/managed-tools managed-tools:init
  fi
fi

# ── Entrypoint.d user hooks ────────────────────────────────────────────────
if [ -d "${ENTRYPOINTD:-}" ]; then
  find "${ENTRYPOINTD}" -maxdepth 1 -type f -executable -print -exec {} \;
fi

# ── Launch code-server ─────────────────────────────────────────────────────
echo "[entrypoint] launching code-server as ${RUN_USER}..."
if [ "$(id -u)" -eq 0 ]; then
  exec gosu "${RUN_USER}" dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "$@"
fi

exec dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "$@"
