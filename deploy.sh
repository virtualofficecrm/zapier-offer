#!/usr/bin/env bash
#
# Deploy the Zapier landing page to Cloudflare Pages PRODUCTION
# (serves https://zapier.vofficeai.com).
#
# What it does:
#   1. Compiles Tailwind to dist/styles.css (minified)
#   2. Rebuilds a clean public/ folder with ONLY the public files
#      (index.html, privacy.html, terms.html, dist/) so wrang.jsonc /
#      otp-worker.js never ship as downloadable static assets
#   3. Deploys to the production branch (main) so it hits the live domain
#
# Usage:  ./deploy.sh      (or:  npm run deploy)
#
set -euo pipefail
cd "$(dirname "$0")"

echo "▶ Building Tailwind CSS..."
npm run build

echo "▶ Assembling public/ deploy folder..."
rm -rf public
mkdir -p public
cp index.html privacy.html terms.html public/
cp -r dist public/

echo "▶ Deploying to Cloudflare Pages (production / main)..."
npx wrangler pages deploy public --project-name=zapier-offer --branch=main --commit-dirty=true

echo "✓ Done. Live at https://zapier.vofficeai.com"
