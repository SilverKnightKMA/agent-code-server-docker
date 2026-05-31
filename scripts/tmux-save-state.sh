#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${CODE_SERVER_OMP_TMUX_STATE_DIR:-${TMUX_TMPDIR:-${XDG_STATE_HOME:-$HOME/.local/state}/tmux}}"
STATE_FILE="${STATE_DIR}/snapshot.tsv"
TMP_FILE="${STATE_FILE}.tmp"

mkdir -p "$STATE_DIR"

if ! command -v tmux >/dev/null 2>&1; then
  exit 0
fi

if ! tmux list-sessions >/dev/null 2>&1; then
  rm -f "$STATE_FILE" "$TMP_FILE"
  exit 0
fi

{
  printf 'v1\n'
  tmux list-sessions -F $'S\t#{session_name}'
  tmux list-windows -a -F $'W\t#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_layout}'
  tmux list-panes -a -F $'P\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{pane_current_path}'
} > "$TMP_FILE"

mv "$TMP_FILE" "$STATE_FILE"
exit 0
