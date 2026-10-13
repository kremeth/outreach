"""The wearable model prospecting ahead of a person, in the cheapest order.

    .venv/bin/python -m wearable.live [--budget 3] [--list data/wearable/live-list.json] [--watch]

Goes through the upcoming profiles in queue order (written by Outreach's /api/model-prospect/upcoming),
once each one's photos and profile picture are saved (wearable/acquire.js), and for each:
1. Profile match (wearable.style, ~$0.001): an active person whose content is their own life. Under
   PROFILE_GATE it is a No straight away (Outreach writes it to the sheet), no wearable check.
2. Wearable check (detect.detect_photos): Gemini 3.1 Flash-Lite on the photos, each labelled with its
   number, then a closer look by Gemini 3.8 Flash at the photos it named.
The next NEAR profiles in front of the person are judged with live calls; the rest go through Gemini
Batch Mode (wearable.batch, half price, answers within minutes to hours): a request not answered yet is
queued, the profile waits, and the next pass picks up where it stopped once the batch is back.
Answers go to data/wearable/results/live.jsonl (the latest line per profile wins). Daily USD cap.
"""
import argparse
import json
import sys
import time

from . import batch, config, detect, style
from .gemini import BudgetExceeded, Deferred, Gemini

SCREEN_MODEL = "gemini-3.1-flash-lite"
BRAND_MODEL = "gemini-3.8-flash"
PROFILE_GATE = 50
NEAR = 20
CURRENT = {"photos-v3", "photos-v4"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=float, default=3.0, help="USD per day, live and batch together")
    parser.add_argument("--extra-today", type=float, default=0.0, help="one-off extra USD for the day it starts on")
    parser.add_argument("--list", default=str(config.DATA / "live-list.json"))
    parser.add_argument("--watch", action="store_true", help="keep going as the list moves on")
    args = parser.parse_args()
    out = config.RESULTS / "live.jsonl"
    config.RESULTS.mkdir(parents=True, exist_ok=True)
    day = None
    first_day = time.strftime("%Y-%m-%d", time.gmtime())
    while True:
        if day != time.strftime("%Y-%m-%d"):
            day = time.strftime("%Y-%m-%d")
            live = Gemini(budget=args.budget, run="live-prospecting", purpose="wearable model, live prospecting")
            later = Gemini(budget=args.budget, run="live-prospecting", purpose="wearable model, batch", defer=True)
        spent = batch.spent_today()  # live calls and batches today, whatever restarts happened
        budget = args.budget + (args.extra_today if time.strftime("%Y-%m-%d", time.gmtime()) == first_day else 0)
        worked = "budget" if spent >= budget else run_once(args, out, live, later)
        if worked != "budget":
            try:
                written, sent = batch.step()
                if written or sent:
                    print(f"batch: {written} answers back, {sent} batches sent", flush=True)
                    worked = worked or bool(written)
            except Exception as error:  # Google hiccup: the next minute tries again
                print(f"batch: {error}", flush=True)
        if not args.watch:
            break
        if worked == "budget":
            print(f"daily budget of ${budget:.2f} reached; waiting for tomorrow", flush=True)
            while day == time.strftime("%Y-%m-%d"):
                time.sleep(300)
        elif not worked:
            time.sleep(60)
    return 0


def profile_of(username):
    try:
        return json.loads((config.PROFILES / f"{username}.json").read_text())
    except (OSError, ValueError):
        return None


def judge(username, gemini):
    """Profile match first; the wearable check only for profiles at or above the gate."""
    profile = profile_of(username) or {}
    match = style.score(username, gemini) if profile.get("status") == "ok" else None
    if match and match["score"] < PROFILE_GATE:
        return {
            "username": username, "status": "ok", "prompt": detect.PHOTOS_VERSION, "acquired_at": profile.get("acquiredAt", ""),
            "decision": "No", "verdict": "not active", "gate": "profile", "match": match,
            "devices": [], "brands": [], "possible_brands": [], "stage1": {}, "cost": 0.0, "images": len(profile.get("posts", [])),
        }
    record = detect.detect_photos(username, gemini, SCREEN_MODEL, zoom_model=BRAND_MODEL)
    if match:
        record["match"] = match
    return record


def run_once(args, out, live, later):
    """One pass over the list. True if it judged anything, "budget" when the budget ran out."""
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
    # Current: judged with this logic on the photos saved now (a profile fetched again is judged again).
    current = {
        username for username, record in latest.items()
        if record.get("prompt") in CURRENT and record.get("acquired_at") == (profile_of(username) or {}).get("acquiredAt")
        and record.get("verdict") != "unreadable" and record.get("status") != "error"
    }
    worked, waiting = False, 0
    for position, item in enumerate(items, 1):
        username = item["username"]
        saved = profile_of(username)
        # Ready: saved with its profile picture (or known private, missing...); otherwise the next pass.
        if username in current or not saved or (saved.get("status") == "ok" and "avatar" not in saved):
            continue
        # A profile whose last try ended in an error: again at most once an hour (never in a loop).
        before = latest.get(username)
        if before and before.get("status") == "error" and time.time() - before.get("judged_at", 0) < 3600:
            continue
        gemini = live if position <= NEAR else later
        try:
            record = judge(username, gemini)
        except Deferred:
            waiting += 1
            continue
        except BudgetExceeded as error:
            print(str(error), flush=True)
            return "budget"
        except Exception as error:  # one bad profile never stops the run
            record = {"username": username, "decision": "Unknown", "status": "error", "error": str(error)[:300], "devices": [], "brands": [], "cost": 0.0}
        record["sheetRow"] = item.get("sheetRow")
        # Every answer is tied to the photos it was made on (private or missing profiles too), so it
        # counts as current until the profile is fetched again.
        record.setdefault("acquired_at", saved.get("acquiredAt", ""))
        record["judged_at"] = time.time()
        with open(out, "a") as handle:
            handle.write(json.dumps(record) + "\n")
        worked = worked or record.get("status") != "error"  # errors alone never skip the pause
        how = "live" if gemini is live else "batch"
        match = record.get("match", {}).get("score")
        print(f"{position}/{len(items)} @{username}: {record['decision']} {record.get('brands') or ''} profile {match} ({how}, ${live.spent:.3f} live today)", flush=True)
    # Shown profiles judged before the current profile match get it (a new line; the latest counts).
    for position, item in enumerate(items, 1):
        record = latest.get(item["username"])
        if not record or not shown(record) or (record.get("match") or {}).get("version") == style.MATCH_VERSION:
            continue
        try:
            match = style.score(record["username"], live if position <= NEAR else later)
        except Deferred:
            continue
        except BudgetExceeded:
            return "budget"
        except Exception as error:
            print(f"profile match @{record['username']}: {error}", flush=True)
            continue
        if match:
            record["match"] = match
            with open(out, "a") as handle:
                handle.write(json.dumps(record) + "\n")
            worked = True
    if waiting:
        print(f"{waiting} profiles waiting for a batch", flush=True)
    return worked


def shown(record):
    """The profiles a person still looks at: the model's Yes and Unsure (its No goes to the sheet)."""
    if record.get("status") != "ok":
        return False
    return record.get("decision") == "Yes" or (record.get("decision") == "Unknown" and record.get("verdict") != "insufficient")


if __name__ == "__main__":
    sys.exit(main())
