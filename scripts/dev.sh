#!/usr/bin/env bash
# Bring up local infrastructure, then run the engine with hot reload.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Creating .env from .env.example"
  cp .env.example .env
fi

if command -v docker >/dev/null 2>&1; then
  echo "Starting mongo, redis, and qdrant"
  docker compose up -d mongo redis qdrant
else
  echo "Docker not found — running with in-memory stores"
fi

npm run dev
