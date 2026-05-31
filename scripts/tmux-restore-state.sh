#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${CODE_SERVER_OMP_TMUX_STATE_DIR:-${TMUX_TMPDIR:-${XDG_STATE_HOME:-$HOME/.local/state}/tmux}}"
STATE_FILE="${STATE_DIR}/snapshot.tsv"

if ! command -v tmux >/dev/null 2>&1; then
  exit 0
fi

if [ ! -s "$STATE_FILE" ]; then
  exit 0
fi

mapfile -t lines < "$STATE_FILE"
if [ "${#lines[@]}" -eq 0 ] || [ "${lines[0]}" != "v1" ]; then
  exit 0
fi

current_sessions="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"
if [ -n "$current_sessions" ]; then
  count=$(printf '%s\n' "$current_sessions" | sed '/^$/d' | wc -l)
  if [ "$count" -gt 1 ]; then
    exit 0
  fi
fi

has_non_scratch=false
while IFS= read -r name; do
  [ -z "$name" ] && continue
  if [ "$name" != "0" ] && [ "$name" != "scratch" ]; then
    has_non_scratch=true
    break
  fi
done <<< "$current_sessions"
if [ "$has_non_scratch" = true ]; then
  exit 0
fi

scratch_session=""
while IFS= read -r name; do
  [ -z "$name" ] && continue
  if [ "$name" = "0" ] || [ "$name" = "scratch" ]; then
    scratch_session="$name"
  fi
done <<< "$current_sessions"

sessions=()
declare -A session_seen=()
declare -A session_windows=()
declare -A pane_paths=()
declare -A pane_active=()
declare -A session_active_window=()
declare -A window_layout=()

for line in "${lines[@]:1}"; do
  IFS=$'\t' read -r kind a b c d e f <<< "$line"
  case "$kind" in
    S)
      if [ -n "$a" ] && [ -z "${session_seen[$a]:-}" ]; then
        session_seen[$a]=1
        sessions+=("$a")
      fi
      ;;
    W)
      session="$a"
      win_idx="$b"
      win_name="$c"
      win_active="$d"
      layout="$e"
      session_windows["$session"]+="${win_idx}|${win_name}|${win_active}|${layout}"$'\n'
      if [ "$win_active" = "1" ]; then
        session_active_window["$session"]="$win_idx"
      fi
      window_layout["$session:$win_idx"]="$layout"
      ;;
    P)
      session="$a"
      win_idx="$b"
      pane_idx="$c"
      active="$d"
      pane_path="$e"
      pane_paths["$session:$win_idx:$pane_idx"]="$pane_path"
      pane_active["$session:$win_idx"]="$active:$pane_idx"
      ;;
  esac
done

if [ "${#sessions[@]}" -eq 0 ]; then
  exit 0
fi

restore_base_path="${pane_paths[${sessions[0]}:0:0]:-$HOME}"
if ! tmux list-sessions >/dev/null 2>&1; then
  tmux new-session -d -s scratch -c "$restore_base_path"
  current_sessions="scratch"
  scratch_session="scratch"
fi

for session in "${sessions[@]}"; do
  if ! tmux has-session -t "$session" 2>/dev/null; then
    tmux new-session -d -s "$session" -c "${pane_paths[$session:0:0]:-$HOME}"
  fi
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    IFS='|' read -r win_idx win_name win_active layout <<< "$entry"
    target="$session:$win_idx"
    if ! tmux list-windows -t "$session" -F '#{window_index}' | grep -qx "$win_idx"; then
      first_path="${pane_paths[$session:$win_idx:0]:-$HOME}"
      tmux new-window -d -t "$session:$win_idx" -n "$win_name" -c "$first_path"
    fi
    current_panes=$(tmux list-panes -t "$target" -F '#{pane_index}' | wc -l)
    desired_panes=$(printf '%s\n' "${!pane_paths[@]}" | awk -F: -v s="$session" -v w="$win_idx" '$1==s && $2==w {count++} END {print count+0}')
    if [ "$desired_panes" -gt 0 ] && [ "$current_panes" -lt "$desired_panes" ]; then
      next=1
      while [ "$next" -lt "$desired_panes" ]; do
        path="${pane_paths[$session:$win_idx:$next]:-$HOME}"
        tmux split-window -d -t "$target" -c "$path"
        next=$((next + 1))
      done
    fi
    if [ -n "${window_layout[$session:$win_idx]:-}" ]; then
      tmux select-layout -t "$target" "${window_layout[$session:$win_idx]}" >/dev/null 2>&1 || true
    fi
    if [ -n "${pane_active[$session:$win_idx]:-}" ]; then
      active_meta="${pane_active[$session:$win_idx]}"
      active_idx="${active_meta#*:}"
      tmux select-pane -t "$target.$active_idx" >/dev/null 2>&1 || true
    fi
  done <<< "${session_windows[$session]:-}"
  if [ -n "${session_active_window[$session]:-}" ]; then
    tmux select-window -t "$session:${session_active_window[$session]}" >/dev/null 2>&1 || true
  fi
done

if [ -n "$scratch_session" ] && tmux has-session -t "$scratch_session" 2>/dev/null; then
  if [ "${#sessions[@]}" -eq 1 ] && [ "$scratch_session" != "${sessions[0]}" ]; then
    tmux kill-session -t "$scratch_session" >/dev/null 2>&1 || true
  fi
fi
