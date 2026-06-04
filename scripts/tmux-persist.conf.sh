#!/usr/bin/env bash
set -euo pipefail

PERSIST_ENABLED="${AGENT_CODE_SERVER_TMUX_PERSIST:-false}"
RESURRECT_DIR="${AGENT_CODE_SERVER_TMUX_RESURRECT_DIR:-$HOME/.local/state/tmux/resurrect}"
SAVE_INTERVAL="${AGENT_CODE_SERVER_TMUX_SAVE_INTERVAL:-1}"
RESTORE_PROCESSES="${AGENT_CODE_SERVER_TMUX_RESURRECT_PROCESSES:-false}"

if [ "$PERSIST_ENABLED" != "true" ] && [ "$PERSIST_ENABLED" != "1" ]; then
  exit 0
fi

case "$SAVE_INTERVAL" in
  ''|*[!0-9]*)
    echo "AGENT_CODE_SERVER_TMUX_SAVE_INTERVAL must be a non-negative integer" >&2
    exit 1
    ;;
esac

cat <<EOF
# agent-code-server tmux persistence (generated)
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'
set -g @resurrect-dir '${RESURRECT_DIR}'
set -g @continuum-restore 'on'
set -g @continuum-save-interval '${SAVE_INTERVAL}'
set -g @resurrect-processes '${RESTORE_PROCESSES}'
run-shell /usr/local/share/agent-code-server/tmux/tmux-resurrect/resurrect.tmux
run-shell /usr/local/share/agent-code-server/tmux/tmux-continuum/continuum.tmux
EOF
