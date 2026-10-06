#!/bin/bash
# Builds Outreach.app in ~/Applications and adds it to the Dock. Run once per Mac (again only if this folder moves).
cd "$(dirname "$0")"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -x node_modules/.bin/electron ] || npm install --no-fund --no-audit || exit 1
node scripts/make-app.js && echo "Done: open Outreach from the Dock." 
read -n 1 -s -r -p "Press any key to close."
