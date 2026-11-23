#!/usr/bin/env bash
set -euo pipefail
npm ci --no-audit --no-fund
npm run build:web
npm run build:dist
cp -r public dist/public
npm --prefix dist ci --omit=dev --ignore-scripts --no-audit --no-fund
rm -f dist/node_modules/.package-lock.json
