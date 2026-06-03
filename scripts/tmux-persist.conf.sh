#!/usr/bin/env bash
set -euo pipefail

PERSIST_ENABLED="${CODE_SERVER_OMP_TMUX_PERSIST:-false}"
RESURRECT_DIR="${CODE_SERVER_OMP_TMUX_RESURRECT_DIR:-$HOME/.local/state/tmux/resurrect}"
SAVE_INTERVAL="${CODE_SERVER_OMP_TMUX_SAVE_INTERVAL:-1}"
RESTORE_PROCESSES="${CODE_SERVER_OMP_TMUX_RESURRECT_PROCESSES:-false}"

if [ "$PERSIST_ENABLED" != "true" ] && [ "$PERSIST_ENABLED" != "1" ]; then
  exit 0
fi

case "$SAVE_INTERVAL" in
  ''|*[!0-9]*)
    echo "CODE_SERVER_OMP_TMUX_SAVE_INTERVAL must be a non-negative integer" >&2
    exit 1
    ;;
esac

cat <<EOF
# code-server-omp tmux persistence (generated)
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'
set -g @resurrect-dir '${RESURRECT_DIR}'
set -g @continuum-restore 'on'
set -g @continuum-save-interval '${SAVE_INTERVAL}'
set -g @resurrect-processes '${RESTORE_PROCESSES}'
run-shell /usr/local/share/code-server-omp/tmux/tmux-resurrect/resurrect.tmux
run-shell /usr/local/share/code-server-omp/tmux/tmux-continuum/continuum.tmux
EOF
