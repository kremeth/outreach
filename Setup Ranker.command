#!/bin/bash
# One-time setup of the local pick predictor: Python environment + Sentence-BERT weights.
# After this, the ranker trains, evaluates and predicts fully offline.
cd "$(dirname "$0")" || exit 1
set -e
PYTHON=python3
command -v python3 >/dev/null || { echo "Install Python 3.10+ from https://www.python.org first."; exit 1; }
[ -x .venv/bin/python ] || "$PYTHON" -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r ranker/requirements.txt
.venv/bin/python -m ranker.setup_models
echo
echo "Checking it works offline…"
.venv/bin/python -m unittest ranker.test_offline
echo "Done. Quit and reopen Outreach."
