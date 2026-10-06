#!/bin/bash
# Opens Outreach. On a new Mac it first checks the requirements and installs what it needs.
cd "$(dirname "$0")"

# Node from nvm or Homebrew, when this is opened by double-click.
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Outreach needs Node.js 22 or newer. Install it from https://nodejs.org (LTS), then open this again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

if [ ! -d "/Applications/Google Chrome.app" ]; then
  echo "Outreach needs Google Chrome in /Applications (it loads profile previews). Install it from https://www.google.com/chrome, then open this again."
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

if [ ! -x node_modules/.bin/electron ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "Installing Outreach (first run or after an update)…"
  npm install --no-fund --no-audit || { read -n 1 -s -r -p "npm install failed. Press any key to close."; exit 1; }
fi

./node_modules/.bin/electron app-main.js
