"""The wearable model prospecting ahead of a person.

    .venv/bin/python -m wearable.live [--budget 3] [--list data/wearable/live-list.json] [--redo 300] [--watch]

Goes through the upcoming profiles in queue order (written by Outreach's
/api/model-prospect/upcoming), waits for each one's images (wearable/acquire.js), and judges it with
detect.detect_photos: Gemini 3.1 Flash-Lite on every photo, each labelled with its number, then a
closer look by Gemini 3.8 Flash at the photos it named (only photos it confirms are shown as evidence). Answers go to data/wearable/results/live.jsonl, which the
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
    parser.add_argument("--budget", type=float, default=3.0, help="USD per day")
    parser.add_argument("--list", default=str(config.DATA / "live-list.json"))
    parser.add_argument("--redo", type=int, default=0)
    parser.add_argument("--watch", action="store_true", help="keep going as the list moves on")
    args = parser.parse_args()
    out = config.RESULTS / "live.jsonl"
    config.RESULTS.mkdir(parents=True, exist_ok=True)
    day, gemini = None, None
    while True:
        if day != time.strftime("%Y-%m-%d"):
            day = time.strftime("%Y-%m-%d")
            gemini = Gemini(budget=args.budget, run="live-prospecting", purpose="wearable model, live prospecting")
        worked = run_once(args, out, gemini)
        if not args.watch:
            break
        if worked == "budget":
            print(f"daily budget of ${args.budget:.2f} reached; waiting for tomorrow", flush=True)
            while day == time.strftime("%Y-%m-%d"):
                time.sleep(300)
        elif not worked:
            time.sleep(60)
    print(f"done: ${gemini.spent:.3f}, {gemini.calls} calls, {gemini.cache_hits} cached", flush=True)
    return 0


def run_once(args, out, gemini):
    """One pass over the list. Returns True if it judged anything, "budget" when the budget ran out."""
    try:
        items = json.loads(open(args.list).read())
    except (OSError, ValueError):
        return False
    latest = {}
    if out.exists():
        for line in out.read_text().split("\n"):
            if line.strip():
                record = json.loads(line)
                latest[record["username"]] = record
    # Current: judged with this prompt, and any device it saw had the closer look (earlier photos-v2
    # answers skipped it when the verdict was no).
    def profile_of(username):
        try:
            return json.loads((config.PROFILES / f"{username}.json").read_text())
        except (OSError, ValueError):
            return None

    # Current: judged with this prompt on the photos saved now (a profile fetched again is judged again).
    current = {
        username for username, record in latest.items()
        if record.get("prompt") == detect.PHOTOS_VERSION and record.get("acquired_at") == (profile_of(username) or {}).get("acquiredAt")
        and record.get("verdict") != "unreadable" and record.get("status") != "error"
    }
    worked = False
    for position, item in enumerate(items, 1):
        username = item["username"]
        if username in current or (username in latest and position > args.redo):
            continue
        # Ready: saved with its profile picture (or known private, missing...). Watching, the next pass
        # picks up a profile that is not ready yet, so one profile never holds the whole list up.
        def ready():
            saved = profile_of(username)
            return bool(saved) and (saved.get("status") != "ok" or "avatar" in saved)

        waited = 0
        while not ready() and not args.watch and waited < WAIT_SECONDS:
            time.sleep(2)
            waited += 2
        if not ready():
            if not args.watch:
                print(f"{position}/{len(items)} @{username}: images never arrived, skipped", flush=True)
            continue
        try:
            record = detect.detect_photos(username, gemini, SCREEN_MODEL, zoom_model=BRAND_MODEL)
        except BudgetExceeded as error:
            print(str(error), flush=True)
            return "budget"
        except Exception as error:  # one bad profile never stops the run
            record = {"username": username, "decision": "Unknown", "status": "error", "error": str(error)[:300], "devices": [], "brands": [], "cost": 0.0}
        record["sheetRow"] = item.get("sheetRow")
        with open(out, "a") as handle:
            handle.write(json.dumps(record) + "\n")
        worked = True
        print(f"{position}/{len(items)} @{username}: {record['decision']} {record.get('brands') or ''} (${gemini.spent:.3f} today)", flush=True)
    return worked


if __name__ == "__main__":
    sys.exit(main())
