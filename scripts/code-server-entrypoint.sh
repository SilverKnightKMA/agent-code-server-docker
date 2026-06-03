#!/usr/bin/env sh
set -eu

# code-server-omp-entrypoint
# ==========================
# Three-phase startup:
#   1. DinD (if enabled)
#   2. Directory preparation (idempotent, targeted chown)
#   3. Preflight check + code-server launch (explicit env)

# ── PATH setup ─────────────────────────────────────────────────────────
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

# ── Default runtime user (before DinD, before fixuid) ─────────────────
# These are the canonical paths regardless of DOCKER_USER remapping.
CANONICAL_HOME="/home/coder"
CANONICAL_USER="coder"

# ── Phase 1: Docker-in-Docker (must run as root) ─────────────────────
if [ "${ENABLE_DIND:-false}" = "true" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[FATAL] ENABLE_DIND=true requires the container to start as root (compose 'user: root')." >&2
    exit 1
  fi

  if ! getent group docker >/dev/null 2>&1; then
    groupadd -r docker
  fi

  mkdir -p /var/lib/docker /var/lib/containerd /run /var/run
  chown -R root:root /var/lib/docker /var/lib/containerd
  rm -f /var/run/docker.pid 2>/dev/null
  rm -f /var/run/docker/containerd/containerd.pid 2>/dev/null
  rm -f /var/run/docker/containerd/*.pid 2>/dev/null

  export DOCKER_HOST="${DOCKER_HOST:-unix:///var/run/docker.sock}"

  # When dockerd starts inside DinD, the docker group may not exist yet
  # inside the container. It's safe — dockerd creates the socket without a group.
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

  # Make /var/run/docker.sock accessible via docker group
  if [ -S /var/run/docker.sock ]; then
    chown root:docker /var/run/docker.sock 2>/dev/null || true
    chmod 0660 /var/run/docker.sock 2>/dev/null || true
  fi
fi

# ── Run fixuid (maps container UID to host-mounted UID) ──────────────
eval "$(fixuid -q)"

# ── DOCKER_USER remapping ────────────────────────────────────────────
if [ "${DOCKER_USER-}" ] && [ "$(id -u)" -eq 0 ]; then
  if [ -z "$(id -u "$DOCKER_USER" 2>/dev/null)" ]; then
    usermod --login "$DOCKER_USER" coder
    groupmod -n "$DOCKER_USER" coder
    if getent group docker >/dev/null 2>&1; then
      usermod -aG docker "${DOCKER_USER}" 2>/dev/null || true
    fi
  fi
fi

# ── Resolve runtime user/group/uid/gid ──────────────────────────────
if [ -n "${DOCKER_USER-}" ]; then
  RUN_USER="${DOCKER_USER}"
elif [ "$(id -u)" -eq 0 ] && [ -z "${USER:-}" ]; then
  RUN_USER="${CANONICAL_USER}"
elif [ -n "${USER:-}" ]; then
  RUN_USER="${USER}"
else
  RUN_USER="${CANONICAL_USER}"
fi

RUN_HOME="${CANONICAL_HOME}"
RUN_UID="$(id -u "${RUN_USER}" 2>/dev/null || echo 1000)"
RUN_GID="$(id -g "${RUN_USER}" 2>/dev/null || echo 1000)"
RUN_GROUP="$(id -gn "${RUN_USER}" 2>/dev/null || echo "${RUN_USER}")"

echo "[entrypoint] runtime user=${RUN_USER} uid=${RUN_UID} gid=${RUN_GID} group=${RUN_GROUP} home=${RUN_HOME}"

# ── Runtime env we will pass to code-server (set now for subsequent commands) ──
export HOME="${RUN_HOME}"
export USER="${RUN_USER}"
export LOGNAME="${RUN_USER}"
export XDG_CONFIG_HOME="${RUN_HOME}/.config"
export XDG_DATA_HOME="${RUN_HOME}/.local/share"
export XDG_CACHE_HOME="${RUN_HOME}/.cache"
export XDG_STATE_HOME="${RUN_HOME}/.local/state"
export NPM_CONFIG_CACHE="${RUN_HOME}/.npm"
export TMUX_TMPDIR="${RUN_HOME}/.local/state/tmux/socket"
export CODE_SERVER_OMP_TMUX_SOCKET_DIR="${TMUX_TMPDIR}"
export CODE_SERVER_OMP_TMUX_RESURRECT_DIR="${RUN_HOME}/.local/state/tmux/resurrect"
# ── Sudo password (LinuxServer-style) ───────────────────────────────
if [ -n "${SUDO_PASSWORD-}" ]; then
  echo "[entrypoint] configuring sudo for ${RUN_USER}..."
  _SUDO_FAILED=false

  # Use printf (not echo) to avoid shell escape interpretation on the password.
  # Reject newlines in password to prevent chpasswd injection.
  case "${SUDO_PASSWORD}" in
    *$'\n'*)
      echo "[FAIL] SUDO_PASSWORD contains newline characters; rejecting" >&2
      _SUDO_FAILED=true
      ;;
    *)
      printf '%s:%s\n' "${RUN_USER}" "${SUDO_PASSWORD}" | chpasswd 2>/dev/null || {
        echo "[warn] chpasswd failed" >&2
        _SUDO_FAILED=true
      }
      ;;
  esac

  # Write sudoers with correct ownership and permissions (0440).
  # sudo silently ignores files in sudoers.d that are not root:root 0440.
  printf '%s ALL=(ALL) ALL\n' "${RUN_USER}" > /etc/sudoers.d/coder 2>/dev/null || {
    echo "[warn] failed to create /etc/sudoers.d/coder" >&2
    _SUDO_FAILED=true
  }
  chown root:root /etc/sudoers.d/coder 2>/dev/null || _SUDO_FAILED=true
  chmod 0440 /etc/sudoers.d/coder 2>/dev/null || _SUDO_FAILED=true

  if [ "${_SUDO_FAILED}" = "false" ]; then
    echo "[entrypoint] sudo enabled for ${RUN_USER}"
  else
    echo "[warn] sudo configuration incomplete — user ${RUN_USER} may not have working sudo" >&2
  fi
  unset _SUDO_FAILED
fi


# ── Docker group membership ─────────────────────────────────────────
if [ "${ENABLE_DIND:-false}" = "true" ] && getent group docker >/dev/null 2>&1; then
  if ! id -nG "${RUN_USER}" 2>/dev/null | grep -qw docker; then
    usermod -aG docker "${RUN_USER}" 2>/dev/null || true
    echo "[entrypoint] added ${RUN_USER} to docker group"
  fi
fi

# ── Phase 2: Directory preparation (targeted chown, no blanket chown) ──
# Step 2a: Ensure RUN_HOME itself is owned by the runtime user and traversable.
# When bind-mounts create subpaths like /home/coder/.config/code-server,
# Docker may create the parent /home/coder with root:root 0700, which
# blocks the runtime user from traversing to the mount points.
echo "[entrypoint] preparing directories..."

if [ ! -d "${RUN_HOME}" ]; then
  mkdir -p "${RUN_HOME}" 2>/dev/null || echo "[warn] mkdir ${RUN_HOME} failed"
fi
chown "${RUN_UID}:${RUN_GID}" "${RUN_HOME}" 2>/dev/null || \
  echo "[warn] chown ${RUN_UID}:${RUN_GID} ${RUN_HOME} failed"
chmod 755 "${RUN_HOME}" 2>/dev/null || true

# Parent dirs (may be bind-mounted from host)
for parent in \
  "${RUN_HOME}/.config" \
  "${RUN_HOME}/.local" \
  "${RUN_HOME}/.local/share" \
  "${RUN_HOME}/.local/state" \
  "${RUN_HOME}/.cache"
do
  if [ ! -d "${parent}" ]; then
    mkdir -p "${parent}" 2>/dev/null || echo "[warn] mkdir ${parent} failed (may be bind-mounted read-only)"
  fi
  chown "${RUN_UID}:${RUN_GID}" "${parent}" 2>/dev/null || true
done

# App data subdirs (code-server + managed tools)
for appdir in \
  "${RUN_HOME}/.config/code-server" \
  "${RUN_HOME}/.local/share/code-server" \
  "${RUN_HOME}/.cache/code-server" \
  "${RUN_HOME}/.local/state/code-server-omp" \
  "${RUN_HOME}/.local/state/code-server-omp/config" \
  "${RUN_HOME}/.local/state/code-server-omp/tmp" \
  "${RUN_HOME}/.local/state/tmux/socket" \
  "${RUN_HOME}/.local/state/tmux/resurrect" \
  "${RUN_HOME}/workspaces" \
  "${RUN_HOME}/entrypoint.d" \
  "${RUN_HOME}/.npm-global" \
  "${RUN_HOME}/.npm" \
  "${RUN_HOME}/.bun" \
  "${RUN_HOME}/.local/bin" \
  "${RUN_HOME}/.local/go" \
  "${RUN_HOME}/.local/pip" \
  "${RUN_HOME}/.cargo" \
  "${RUN_HOME}/.cargo/bin" \
  "${RUN_HOME}/.rustup" \
  "${RUN_HOME}/.go" \
  "${RUN_HOME}/.go/bin"
do
  if [ ! -d "${appdir}" ]; then
    mkdir -p "${appdir}" 2>/dev/null || echo "[warn] mkdir ${appdir} failed (bind-mounted)"
  fi
  chown "${RUN_UID}:${RUN_GID}" "${appdir}" 2>/dev/null || true
done


# ── Phase 3: Preflight check (run as the target user) ────────────────
echo "[entrypoint] preflight checks..."

PREFLIGHT_FAILED=false

gosu "${RUN_USER}" sh -c '
  CHECK_FAILED=false

  check_dir() {
    desc="$1"
    path="$2"
    if [ ! -e "${path}" ]; then
      echo "[FAIL] ${desc}: ${path} does not exist" >&2
      CHECK_FAILED=true
      return
    fi
    if [ ! -d "${path}" ]; then
      echo "[FAIL] ${desc}: ${path} is not a directory" >&2
      CHECK_FAILED=true
      return
    fi
    if [ ! -w "${path}" ]; then
      echo "[FAIL] ${desc}: ${path} is not writable" >&2
      CHECK_FAILED=true
      return
    fi
    # Write test
    touch "${path}/.entrypoint-write-test" 2>/dev/null || {
      echo "[FAIL] ${desc}: touch ${path}/.entrypoint-write-test failed" >&2
      CHECK_FAILED=true
      return
    }
    rm -f "${path}/.entrypoint-write-test" 2>/dev/null
    echo "[check] ${desc}: OK"
  }

  check_dir "HOME"      "/home/coder"
  check_dir "XDG_CONFIG" "/home/coder/.config"
  check_dir "code-server-config" "/home/coder/.config/code-server"
  check_dir "code-server-data"  "/home/coder/.local/share/code-server"
  check_dir "code-server-cache" "/home/coder/.cache/code-server"

  if [ "${CHECK_FAILED}" = "true" ]; then
    echo "[DIAGNOSTICS] Preflight failed. Environment:" >&2
    id >&2
    env | sort >&2
    echo "--- passwd ---" >&2
    getent passwd "$(whoami)" 2>/dev/null >&2 || echo "(not found)" >&2
    echo "--- groups ---" >&2
    groups >&2
    echo "--- getent group docker ---" >&2
    getent group docker 2>/dev/null >&2 || echo "(not found)" >&2
    echo "--- namei .config/code-server ---" >&2
    namei -l /home/coder/.config/code-server 2>/dev/null >&2 || echo "(namei unavailable)" >&2
    echo "--- namei .local/share/code-server ---" >&2
    namei -l /home/coder/.local/share/code-server 2>/dev/null >&2 || echo "(namei unavailable)" >&2
    echo "--- namei .cache/code-server ---" >&2
    namei -l /home/coder/.cache/code-server 2>/dev/null >&2 || echo "(namei unavailable)" >&2
    echo "--- ls -ldn ---" >&2
    for p in /home/coder /home/coder/.config /home/coder/.config/code-server /home/coder/.local /home/coder/.local/share /home/coder/.local/share/code-server /home/coder/.cache /home/coder/.cache/code-server; do
      ls -ldn "${p}" 2>/dev/null || echo "  ${p}: (does not exist)" >&2
    done
    echo "--- mount | grep /home/coder ---" >&2
    mount 2>/dev/null | grep "/home/coder" || echo "(none)" >&2
    echo "--- /proc/self/mountinfo | grep /home/coder ---" >&2
    cat /proc/self/mountinfo 2>/dev/null | grep "/home/coder" || echo "(none)" >&2
    exit 1
  fi
' 2>&1

# Capture the exit code of the gosu preflight
PREFLIGHT_RC=$?

if [ "${PREFLIGHT_RC}" -ne 0 ]; then
  echo "[FATAL] Preflight checks failed. Cannot start code-server." >&2
  exit 1
fi

echo "[entrypoint] preflight: all checks passed"

# ── Managed tools autoinstall (optional) ────────────────────────────
if [ "${CODE_SERVER_OMP_AUTOINSTALL:-false}" = "true" ]; then
  echo "[managed-tools] installing missing or outdated managed tools..."
  gosu "${RUN_USER}" env \
    HOME="${RUN_HOME}" \
    USER="${RUN_USER}" \
    PATH="${PATH}" \
    NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE}" \
    TMUX_TMPDIR="${TMUX_TMPDIR}" \
    npm run --prefix /opt/code-server-omp/managed-tools managed-tools:init
fi

if /usr/local/bin/code-server-omp-tmux-persist-conf > /etc/tmux.persist.conf.tmp; then
  if [ -s /etc/tmux.persist.conf.tmp ]; then
    mv /etc/tmux.persist.conf.tmp /etc/tmux.persist.conf
  else
    rm -f /etc/tmux.persist.conf.tmp /etc/tmux.persist.conf
  fi
else
  rm -f /etc/tmux.persist.conf.tmp /etc/tmux.persist.conf
fi

# ── Entrypoint.d user hooks ─────────────────────────────────────────
if [ -d "${ENTRYPOINTD:-/home/coder/entrypoint.d}" ]; then
  find "${ENTRYPOINTD:-/home/coder/entrypoint.d}" -maxdepth 1 -type f -executable -print -exec {} \;
fi

# ── Launch code-server (with explicit env) ─────────────────────────
echo "[entrypoint] launching code-server as ${RUN_USER}..."

if [ "$(id -u)" -eq 0 ]; then
  exec gosu "${RUN_USER}" env \
    HOME="${RUN_HOME}" \
    USER="${RUN_USER}" \
    LOGNAME="${RUN_USER}" \
    XDG_CONFIG_HOME="${RUN_HOME}/.config" \
    XDG_DATA_HOME="${RUN_HOME}/.local/share" \
    XDG_CACHE_HOME="${RUN_HOME}/.cache" \
    XDG_STATE_HOME="${RUN_HOME}/.local/state" \
    DOCKER_HOST="${DOCKER_HOST:-}" \
    PATH="${PATH}" \
    NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE}" \
    TMUX_TMPDIR="${TMUX_TMPDIR}" \
    dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "${RUN_HOME}/workspaces" "$@"
fi

exec env \
  HOME="${RUN_HOME}" \
  USER="${RUN_USER}" \
  LOGNAME="${RUN_USER}" \
  XDG_CONFIG_HOME="${RUN_HOME}/.config" \
  XDG_DATA_HOME="${RUN_HOME}/.local/share" \
  XDG_CACHE_HOME="${RUN_HOME}/.cache" \
  XDG_STATE_HOME="${RUN_HOME}/.local/state" \
  DOCKER_HOST="${DOCKER_HOST:-}" \
  PATH="${PATH}" \
  NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE}" \
  TMUX_TMPDIR="${TMUX_TMPDIR}" \
  dumb-init /usr/bin/code-server --bind-addr 0.0.0.0:8080 "${RUN_HOME}/workspaces" "$@"
