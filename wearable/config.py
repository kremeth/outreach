"""Wearable detection: paths, models, prices and budget. Everything here runs locally except the
Gemini calls (wearable/gemini.py), which are cached, budgeted and logged."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("WEARABLE_DATA_DIR", ROOT / "data" / "wearable"))
PROFILES = DATA / "profiles"
IMAGES_ROOT = DATA  # profile JSON stores image paths relative to this
GRIDS = DATA / "grids"
GEMINI_CACHE = DATA / "gemini-cache"
RESULTS = DATA / "results"
LABELS = DATA / "labels.jsonl"
PILOT = DATA / "pilot.json"
SPEND = DATA / "spend.jsonl"
USAGE_LOG = ROOT / "data" / "gemini-usage.jsonl"  # shared with Outreach's API costs card
KEY_PATH = ROOT / "data" / "gemini-key.txt"

BRANDS = ["Garmin", "WHOOP", "Apple Watch", "Polar", "Oura"]
GENERIC = ["Unknown smartwatch", "Unknown fitness band", "Unknown smart ring", "Other brand"]

# USD per 1M tokens (input, output). Third-party listings, checked against Gemini's own token counts.
PRICES = {
    "gemini-3.1-flash-lite": (0.25, 1.50),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.8-flash": (0.75, 3.75),
}

GRID_CELL = 512  # px per cell, 3x3 -> 1536 px square
GRID_BACKGROUND = (128, 128, 128)

# Hard spending cap for one run (USD); a run stops before a call that would exceed it.
DEFAULT_BUDGET = float(os.environ.get("WEARABLE_BUDGET_USD", "3.00"))
