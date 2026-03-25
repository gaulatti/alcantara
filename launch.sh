#!/usr/bin/env bash

set -euo pipefail

SESSION_NAME="alcantara"
WINDOW_NAME="dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
RESET_REQUESTED=0

if [[ "${1:-}" == "--reset" ]]; then
  RESET_REQUESTED=1
fi

session_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null
}

expected_layout_exists() {
  local window_count pane_count
  window_count="$(tmux list-windows -t "$SESSION_NAME" -F '#W' | wc -l | tr -d ' ')"
  pane_count="$(tmux list-panes -t "$SESSION_NAME:$WINDOW_NAME" 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$window_count" == "1" && "$pane_count" == "2" ]]
}

legacy_layout_exists() {
  local windows
  windows="$(tmux list-windows -t "$SESSION_NAME" -F '#W')"
  grep -q '^backend$' <<<"$windows" && grep -q '^frontend$' <<<"$windows"
}

create_session() {
  tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$ROOT_DIR/backend" "pnpm start:dev"
  tmux split-window -h -t "$SESSION_NAME:$WINDOW_NAME.0" -c "$ROOT_DIR/frontend" "pnpm dev"
  tmux select-layout -t "$SESSION_NAME:$WINDOW_NAME" even-horizontal
  tmux set-window-option -t "$SESSION_NAME:$WINDOW_NAME" remain-on-exit off
  tmux select-pane -t "$SESSION_NAME:$WINDOW_NAME.0"
}

if session_exists; then
  if [[ "$RESET_REQUESTED" == "1" ]]; then
    tmux kill-session -t "$SESSION_NAME"
    create_session
  elif legacy_layout_exists; then
    tmux kill-session -t "$SESSION_NAME"
    create_session
  elif ! expected_layout_exists; then
    echo "Existing tmux session '$SESSION_NAME' has a custom layout."
    echo "Use './launch.sh --reset' to recreate the standard frontend/backend split."
  fi
else
  create_session
fi

tmux attach-session -t "$SESSION_NAME"
