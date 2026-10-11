"""The wearable model prospecting ahead of a person.

    .venv/bin/python -m wearable.live [--budget 3] [--list data/wearable/live-list.json] [--redo 50]

Goes through the upcoming profiles in queue order (written by Outreach's
/api/model-prospect/upcoming), waits for each one's images (wearable/acquire.js), and judges it with
the pilot's best setup: Gemini 3.1 Flash-Lite on all the profile's grids, with the closer look (brand
identification) done by Gemini 3.8 Flash. Answers go to data/wearable/results/live.jsonl, which the
Prospecting screen reads (the latest line per profile wins). Resumable; stops at the budget.
--redo N: the first N profiles of the list are judged again if their answer came from an older prompt.
"""
import argparse
import json
import sys
import time

from . import config, detect
from .gemini import BudgetExceeded, Gemini

SCREEN_MODEL = "gemini-3.1-flash-lite"
BRAND_MODEL = "gemini-3.8-flash"
WAIT_SECONDS = 20 * 60


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=float, default=3.0)
    parser.add_argument("--list", default=str(config.DATA / "live-list.json"))
    parser.add_argument("--redo", type=int, default=0)
    args = parser.parse_args()
    items = json.loads(open(args.list).read())
    out = config.RESULTS / "live.jsonl"
    config.RESULTS.mkdir(parents=True, exist_ok=True)
    latest = {}
    if out.exists():
        for line in out.read_text().split("\n"):
            if line.strip():
                record = json.loads(line)
                latest[record["username"]] = record
    current = {username for username, record in latest.items() if record.get("prompt") == detect.PROMPT_VERSION}
    gemini = Gemini(budget=args.budget, run="live-prospecting", purpose="wearable model, live prospecting")
    for position, item in enumerate(items, 1):
        username = item["username"]
        if username in current or (username in latest and position > args.redo):
            continue
        profile_path = config.PROFILES / f"{username}.json"
        waited = 0
        while not profile_path.exists() and waited < WAIT_SECONDS:
            time.sleep(2)
            waited += 2
        if not profile_path.exists():
            print(f"{position}/{len(items)} @{username}: images never arrived, skipped", flush=True)
            continue
        try:
            record = detect.detect(username, gemini, SCREEN_MODEL, zoom=True, zoom_model=BRAND_MODEL)
        except BudgetExceeded as error:
            print(str(error), flush=True)
            break
        except Exception as error:  # one bad profile never stops the run
            record = {"username": username, "decision": "Unknown", "status": "error", "error": str(error)[:300], "devices": [], "brands": [], "cost": 0.0}
        record["sheetRow"] = item.get("sheetRow")
        with open(out, "a") as handle:
            handle.write(json.dumps(record) + "\n")
        print(f"{position}/{len(items)} @{username}: {record['decision']} {record.get('brands') or ''} (${gemini.spent:.3f} so far)", flush=True)
    print(f"done: ${gemini.spent:.3f}, {gemini.calls} calls, {gemini.cache_hits} cached", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
