#!/bin/bash
# J.A.R.V.I.S. Launcher

DIR="$( cd "$(dirname "$0")" && pwd )"

cd "$DIR" || { echo "❌ Could not cd into $DIR"; exit 1; }

echo "🤖 Starting J.A.R.V.I.S. (Ctrl+C to stop)..."
exec node index.js