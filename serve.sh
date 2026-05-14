#!/bin/bash
# Obsidian Reader — lightweight server (Node.js)
# 1. Scan vault → generate catalog.json (Python)
# 2. Start HTTP server (Node.js — has Full Disk Access for iCloud vault)

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/obsidian-reader.log"
PYTHON=/usr/bin/python3
NODE=/opt/homebrew/bin/node

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

echo "$(date '+%Y-%m-%d %H:%M:%S') [start] Obsidian Reader starting..." | tee -a "$LOG"

# ── Scan vault for catalog ────────────────────────────
echo "$(date '+%Y-%m-%d %H:%M:%S') [scan] Generating catalog..." | tee -a "$LOG"
cd "$DIR"
if ! $PYTHON scan.py >> "$LOG" 2>&1; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [scan] Warning: scan failed (vault may not be ready)" | tee -a "$LOG"
fi
echo "$(date '+%Y-%m-%d %H:%M:%S') [scan] Catalog step done" | tee -a "$LOG"

# ── Start Node.js server ─────────────────────────────
echo "$(date '+%Y-%m-%d %H:%M:%S') [http] Starting Node.js server..." | tee -a "$LOG"
exec $NODE server.js >> "$LOG" 2>&1
