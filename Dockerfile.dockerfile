# syntax=docker/dockerfile:1
#
# agent-code-server-docker
# =======================
# code-server + oh-my-pi (omp) in a single image.
# Three-tier tooling: baked-in core, managed mounted tools, custom user tools.
#
# Build:
#   docker build \
#     --build-context toolchain=agent-code-server-docker \
#     -t agent-code-server:latest \
#     code-server
#
# (where "code-server" is the upstream coder/code-server checkout)

# ── Stage: Bun runtime ───────────────────────────────────────────────
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS bun-runtime

# ── Stage: toolchain (builder repo artifacts) ───────────────────────
# This stage only exists so --build-context toolchain=... can inject
# the managed-tools scripts and config without copying the builder
# repo into the upstream source tree.
FROM scratch AS toolchain
COPY package.json package-lock.json go.mod go.sum tools.go /opt/agent-code-server/managed-tools/
COPY managed-tools/ /opt/agent-code-server/managed-tools/managed-tools/
COPY scripts/ /opt/agent-code-server/managed-tools/scripts/
COPY scripts/code-server-entrypoint.sh /usr/local/bin/agent-code-server-entrypoint
COPY .tmux.conf /opt/agent-code-server/managed-tools/.tmux.conf
COPY vendor/tmux-resurrect /opt/agent-code-server/managed-tools/vendor/tmux-resurrect
COPY vendor/tmux-continuum /opt/agent-code-server/managed-tools/vendor/tmux-continuum

# ── Stage: code-server build ────────────────────────────────────────
FROM debian:13-slim@sha256:4e401d95de7083948053197a9c3913343cd06b706bf15eb6a0c3ccd26f436a0e AS code-server-builder

# We copy code-server from the official release .deb rather than building
# from source. This stage pins the exact version and architecture.
ARG CODE_SERVER_VERSION=4.99.3
ARG TARGETARCH=amd64

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_${TARGETARCH}.deb" \
    -o /tmp/code-server.deb

# ── Stage: Docker-in-Docker ────────────────────────────────────────
FROM docker:29.6.1-dind@sha256:66d292e5c26bd33a6f6f61cacb880de2186339a524ecba1ce098dbbaceed6515 AS docker-dind

# ── Stage: runtime ──────────────────────────────────────────────────
FROM debian:13-slim@sha256:4e401d95de7083948053197a9c3913343cd06b706bf15eb6a0c3ccd26f436a0e AS runtime

ENV DEBIAN_FRONTEND=noninteractive

# ── System packages (baked core) ────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    dumb-init \
    dnsutils \
    file \
    git \
    git-lfs \
    htop \
    iproute2 \
    iptables \
    jq \
    lbzip2 \
    less \
    locales \
    lsb-release \
    lsof \
    man-db \
    nano \
    netcat-openbsd \
    openssh-client \
    procps \
    psmisc \
    python3 \
    python3-pip \
    python3-venv \
    rsync \
    gosu \
    sudo \
    tar \
    unzip \
    wget \
    xz-utils \
    tmux \
    zsh \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && git lfs install \
  && rm -rf /var/lib/apt/lists/*

# ── Locale ──────────────────────────────────────────────────────────
RUN sed -i "s/# en_US.UTF-8/en_US.UTF-8/" /etc/locale.gen \
  && locale-gen
ENV LANG=en_US.UTF-8

# ── code-server installation ────────────────────────────────────────
COPY --from=code-server-builder /tmp/code-server.deb /tmp/code-server.deb
RUN dpkg -i /tmp/code-server.deb && rm /tmp/code-server.deb

# ── Bun runtime (for managed omp and user bun tooling) ───────────────
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

# ── Node.js + npm (baked from official image) ───────────────────────
# Pin to same version as Bun's Node for compatibility
RUN curl -fsSL https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-x64.tar.xz \
    | tar -C /usr/local --strip-components=1 -xJf -

# ── Paseo daemon + web UI (baked core, Tier 1) ──────────────────────
# Installed to a dedicated prefix (not under /home/coder) so it is never
# shadowed by the Tier 2/3 bind-mounted volumes. Agent CLIs (Tier 2) are
# intentionally NOT baked here — see managed-tools/manifest.json.
ENV ONNXRUNTIME_NODE_INSTALL=skip
RUN npm install -g --prefix /opt/paseo \
      @getpaseo/cli@0.1.105 \
      @getpaseo/server@0.1.105 \
    && npm cache clean --force

# ── User setup ──────────────────────────────────────────────────────
RUN adduser --gecos '' --disabled-password --uid 1000 coder \
  && groupadd -r docker \
  && usermod -aG docker coder

# ── fixuid for host UID mapping ─────────────────────────────────────
RUN ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL "https://github.com/boxboat/fixuid/releases/download/v0.6.0/fixuid-0.6.0-linux-$ARCH.tar.gz" \
     | tar -C /usr/local/bin -xzf - \
  && chown root:root /usr/local/bin/fixuid \
  && chmod 4755 /usr/local/bin/fixuid \
  && mkdir -p /etc/fixuid \
  && printf "user: coder\ngroup: coder\n" > /etc/fixuid/config.yml

# ── Toolchain scripts & config ──────────────────────────────────────
COPY --from=toolchain /opt/agent-code-server /opt/agent-code-server
COPY --from=toolchain /usr/local/bin/agent-code-server-entrypoint /usr/local/bin/agent-code-server-entrypoint
COPY --from=toolchain /opt/agent-code-server/managed-tools/.tmux.conf /etc/tmux.conf
COPY --from=toolchain /opt/agent-code-server/managed-tools/scripts/tmux-persist.conf.sh /usr/local/bin/agent-code-server-tmux-persist-conf
COPY --from=toolchain /opt/agent-code-server/managed-tools/vendor/tmux-resurrect /usr/local/share/agent-code-server/tmux/tmux-resurrect
COPY --from=toolchain /opt/agent-code-server/managed-tools/vendor/tmux-continuum /usr/local/share/agent-code-server/tmux/tmux-continuum

# ── Docker-in-Docker binaries ─────────────────────────────────────
COPY --from=docker-dind /usr/local/bin/ /usr/local/bin/
COPY --from=docker-dind /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

# ── Runtime directories & config ────────────────────────────────────
ENV HOME=/home/coder
ENV NODE_ENV=production
ENV DOCKER_TLS_CERTDIR=
ENV NPM_CONFIG_PREFIX=/home/coder/.npm-global
ENV MANAGED_NPM_PREFIX=/home/coder/.npm-global
ENV NPM_CONFIG_CACHE=/home/coder/.npm
ENV BUN_INSTALL=/home/coder/.bun
ENV CARGO_HOME=/home/coder/.cargo
ENV MANAGED_CARGO_HOME=/home/coder/.cargo
ENV GOPATH=/home/coder/.go
ENV GOBIN=/home/coder/.go/bin
ENV MANAGED_GO_ROOT=/home/coder/.local/go
ENV PYTHONUSERBASE=/home/coder/.local/pip
ENV MANAGED_RELEASE_BIN_DIR=/home/coder/.local/bin
ENV RUSTUP_HOME=/home/coder/.rustup
ENV MANAGED_RUSTUP_HOME=/home/coder/.rustup
ENV XDG_CACHE_HOME=/home/coder/.cache
ENV XDG_CONFIG_HOME=/home/coder/.config
ENV XDG_DATA_HOME=/home/coder/.local/share
ENV XDG_STATE_HOME=/home/coder/.local/state
ENV AGENT_CODE_SERVER_CONFIG_CACHE_DIR=/home/coder/.local/state/agent-code-server/config
ENV AGENT_CODE_SERVER_TMPDIR=/home/coder/.local/state/agent-code-server/tmp
ENV TMUX_TMPDIR=/home/coder/.local/state/tmux/socket
ENV ENTRYPOINTD=/home/coder/entrypoint.d
ENV PASEO_HOME=/home/coder/.paseo
ENV PASEO_LISTEN=0.0.0.0:6767
ENV PASEO_WEB_UI_ENABLED=true
ENV PASEO_LOG_FORMAT=json
ENV PASEO_LOG_LEVEL=info
ENV CLAUDE_CONFIG_DIR=/home/coder/.claude
ENV CODEX_HOME=/home/coder/.codex

ENV PATH=/home/coder/.local/bin:/home/coder/.npm-global/bin:/home/coder/.local/go/bin:/home/coder/.go/bin:/home/coder/.cargo/bin:/home/coder/.local/pip/bin:/home/coder/.bun/bin:/opt/paseo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN mkdir -p \
    /home/coder/.bun \
    /home/coder/.cache \
    /home/coder/.cargo/bin \
    /home/coder/.config \
    /home/coder/.config/code-server \
    /home/coder/.local/share/code-server \
    /home/coder/.go/bin \
    /home/coder/.local/bin \
    /home/coder/.local/go/bin \
    /home/coder/.local/pip/bin \
    /home/coder/.local/share \
    /home/coder/.local/state/tmux/socket \
    /home/coder/.local/state/tmux/resurrect \
    /home/coder/.local/state \
    /home/coder/.npm-global \
    /home/coder/.ssh \
    /home/coder/.paseo \
    /home/coder/.claude \
    /home/coder/.codex \
    /home/coder/workspaces \
    /home/coder/entrypoint.d \
  && chown -R coder:coder /home/coder

# ── Shell profile: PATH, tmux defaults, and shell hints ─────────────────
# code-server spawns bash -i (interactive non-login) which reads
# /etc/bash.bashrc then ~/.bashrc. The profile.d script only gets
# loaded by login shells, so source it from /etc/bash.bashrc.
RUN mkdir -p /etc/profile.d \
  && printf '%s\n' \
    '# agent-code-server: PATH, managed-tools hints, tmux defaults, and shell environment' \
    '# This script is sourced from /etc/bash.bashrc and /etc/profile' \
    '' \
    'BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"' \
    'NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"' \
    'NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$HOME/.npm}"' \
    'GOPATH="${GOPATH:-$HOME/.go}"' \
    'GOBIN="${GOBIN:-$HOME/.go/bin}"' \
    'CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"' \
    'PYTHONUSERBASE="${PYTHONUSERBASE:-$HOME/.local/pip}"' \
    'XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"' \
    'TMUX_TMPDIR="${TMUX_TMPDIR:-$XDG_STATE_HOME/tmux/socket}"' \
    '' \
    'PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.local/go/bin:$HOME/.go/bin:$HOME/.cargo/bin:$HOME/.local/pip/bin:/opt/paseo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
    'export BUN_INSTALL NPM_CONFIG_PREFIX NPM_CONFIG_CACHE GOPATH GOBIN CARGO_HOME PYTHONUSERBASE XDG_STATE_HOME TMUX_TMPDIR PATH' \
    'mkdir -p "$TMUX_TMPDIR" 2>/dev/null || true' \
    '' \
    'if [ -n "${BASH_VERSION:-}" ] && [ -n "${PS1:-}" ]; then' \
    '  if [ -z "${AGENT_CODE_SERVER_SHELL_HINT_SHOWN:-}" ]; then' \
    '    export AGENT_CODE_SERVER_SHELL_HINT_SHOWN=1' \
    '    printf "\\n[agent-code-server] Managed tools persist under %s\\n" "$HOME"' \
    '    printf "[agent-code-server] Install/update pinned tools: npm run --prefix /opt/agent-code-server/managed-tools managed-tools:init\\n"' \
    '    printf "[agent-code-server] Check status: npm run --prefix /opt/agent-code-server/managed-tools managed-tools:status\\n"' \
    '    printf "[agent-code-server] Managed npm tools live in %s\\n" "$NPM_CONFIG_PREFIX"' \
    '    printf "[agent-code-server] tmux socket dir: %s\\n" "$TMUX_TMPDIR"' \
    '    printf "[agent-code-server] Dump pane: tmux capture-pane -p -S - > tmux-pane.txt\\n"' \
    '    printf "[agent-code-server] Live log:  tmux pipe-pane -o '\''cat >> tmux-live.log'\''\\n"' \
    '    if [ "${AGENT_CODE_SERVER_TMUX_PERSIST:-false}" = "true" ] || [ "${AGENT_CODE_SERVER_TMUX_PERSIST:-false}" = "1" ]; then' \
    '      printf "[agent-code-server] tmux persistence: enabled (socket dir + resurrect state under %s)\\n" "$XDG_STATE_HOME/tmux"' \
    '    else' \
    '      printf "[agent-code-server] tmux persistence: disabled (set AGENT_CODE_SERVER_TMUX_PERSIST=true to enable)\\n"' \
    '    fi' \
    '    printf "[agent-code-server] Tip: hold Shift while dragging to select/copy text when tmux mouse mode is on.\\n"' \
    '    printf "\\n"' \
    '  fi' \
    'fi' \
    > /etc/profile.d/agent-code-server-path.sh \
  && printf '\n# agent-code-server\n. /etc/profile.d/agent-code-server-path.sh\n' >> /etc/bash.bashrc

# ── Entrypoint.d scripts (run on container start) ───────────────────
# Users can mount scripts here to customize workspace initialization.
# https://github.com/coder/code-server/issues/5177

EXPOSE 8080
EXPOSE 6767

USER root
WORKDIR /home/coder

ENTRYPOINT ["/usr/local/bin/agent-code-server-entrypoint"]
