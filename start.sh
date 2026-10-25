#!/bin/sh
set -eu

# The daemon must listen on all interfaces inside the container.
# The CLI and the processing server dial loopback so OLLAMA_HOST stays a URL.
OLLAMA_HOST=0.0.0.0:11434 ollama serve &
ollama_pid=$!

i=0
while [ "$i" -lt 60 ]; do
  if OLLAMA_HOST=http://127.0.0.1:11434 ollama list >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

export OLLAMA_HOST=http://127.0.0.1:11434
node /srv/server.mjs &
node_pid=$!

trap 'kill "$ollama_pid" "$node_pid" 2>/dev/null || true' TERM INT
wait "$node_pid"
