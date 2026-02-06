#!/bin/bash

SESSION_NAME="alcantara"

# Check if session already exists
tmux has-session -t $SESSION_NAME 2>/dev/null

if [ $? != 0 ]; then
  # Create new session with first window for backend
  tmux new-session -d -s $SESSION_NAME -n "backend" -c "$PWD/backend"

  # Send commands to backend window
  tmux send-keys -t $SESSION_NAME:backend "pnpm start:dev" C-m

  # Create new window for frontend
  tmux new-window -t $SESSION_NAME -n "frontend" -c "$PWD/frontend"

  # Send commands to frontend window
  tmux send-keys -t $SESSION_NAME:frontend "pnpm dev" C-m

  # Select the first window
  tmux select-window -t $SESSION_NAME:backend
fi

# Attach to session
tmux attach-session -t $SESSION_NAME
