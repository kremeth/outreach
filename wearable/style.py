"""Profile match: is this an active person whose content is their own (active) life?

    .venv/bin/python -m wearable.style check [--sample 50] [--budget 0.5]   # how it scores known profiles
    .venv/bin/python -m wearable.style score <username>                     # one profile

What we look for (11 Oct): someone with a wearable (the wearable model's job) who is active, and whose
content is lifestyle and being active. Gemini Flash-Lite reads the first 12 photos, bio, name, followers
and captions and rates, against fixed anchors:
  active     0-100: how physically active the account owner clearly is
  lifestyle  0-100: how much the content is their own everyday life (not a business, product,
             client-work or meme page)
Profile match = (2 x active + lifestyle) / 3. Levels: high from 65, medium from 40, low below.
Wearables are left out on purpose (the wearable model handles the device).
"""
import argparse
import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import config
from .gemini import Gemini
from .grid import load_profile

DIR = config.DATA / "style"
REPORT = DIR / "report.json"
GROUND_TRUTH = config.DATA / "collab-usernames.json"
VERSION = "style-v2"
MATCH_VERSION = "active-v1"
DESCRIBE_MODEL = "gemini-3.1-flash-lite"
PHOTOS = 12
HIGH, MEDIUM = 65, 40

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING"},
        "niche": {"type": "STRING"},
        "active_evidence": {"type": "STRING"},
        "active": {"type": "INTEGER"},
        "lifestyle": {"type": "INTEGER"},
    },
    "required": ["summary", "niche", "active_evidence", "active", "lifestyle"],
}

PROMPT = """Above are the latest photos of one Instagram creator. Their profile:
username @{username}, name "{name}", {followers}, bio "{bio}".
Recent captions: {captions}

We look for creators who are physically active and whose content is their own life, lifestyle and being active. Ignore any watches, rings or fitness trackers. Judge only the account owner (the main person), from what the photos, bio and captions show.

summary: 1-2 plain sentences: who they are and what they post.
niche: a few words (e.g. "marathon runner and coach", "mum lifestyle", "makeup artist", "food and recipes").
active_evidence: one sentence: what shows how active they are (e.g. "race photos, gym sessions and trail runs in 7 of 12 posts").
active, 0-100: how physically active the owner clearly is.
  0-10: no sign of physical activity.
  25: occasionally active (a walk, a beach swim, the odd gym mention).
  50: regularly active: workouts, runs or sport show up often.
  75: activity is a big part of their life and content (keen runner, gym regular, plays sport).
  90-100: training or sport is central: athlete, coach, endurance or competition.
lifestyle, 0-100: how much the content is their own everyday life.
  0-10: not a person's life: a business, product, brand, meme or news page, or only client work.
  30: mostly professional or promotional, a little personal life.
  60: a mix of personal life and other content.
  90-100: almost all their own life: days, training, family, travel, food, friends."""


def describe(username, gemini):
    """The profile's ratings (cached by Gemini's request cache, so asking twice is free)."""
    profile = load_profile(username)
    if not profile or profile.get("status") != "ok":
        return None
    files = [config.IMAGES_ROOT / post["file"] for post in profile.get("posts", []) if post.get("file")][:PHOTOS]
    captions = " | ".join(str(post.get("caption", ""))[:160] for post in profile.get("posts", []) if post.get("caption"))[:1200]
    text = PROMPT.format(username=username, name=profile.get("name", ""), followers=profile.get("followers", "") or "followers unknown", bio=str(profile.get("bio", ""))[:400], captions=captions or "none")
    result = gemini.generate(DESCRIBE_MODEL, VERSION, [path.read_bytes() for path in files], text, SCHEMA, max_output_tokens=500, media_resolution="MEDIA_RESOLUTION_LOW")
    answer = result.get("answer", {})
    return None if "_unparsed" in answer else answer


def level(score):
    return "high" if score >= HIGH else "medium" if score >= MEDIUM else "low"


def match_of(answer):
    active = max(0, min(100, int(answer.get("active") or 0)))
    lifestyle = max(0, min(100, int(answer.get("lifestyle") or 0)))
    value = round((2 * active + lifestyle) / 3)
    return {
        "score": value,
        "level": level(value),
        "active": active,
        "lifestyle": lifestyle,
        "evidence": answer.get("active_evidence", ""),
        "niche": answer.get("niche", ""),
        "summary": answer.get("summary", ""),
        "version": MATCH_VERSION,
    }


def score(username, gemini):
    """{score 0-100, level, active, lifestyle, evidence, niche} for one profile, or None."""
    answer = describe(username, gemini)
    return match_of(answer) if answer else None


def check(sample=50, budget=0.5, seed=42):
    """Scores the collab creators and a sample of past Yes and No profiles, to see the gauge is sensible."""
    DIR.mkdir(parents=True, exist_ok=True)
    collab = [u for u in json.loads(GROUND_TRUTH.read_text()) if (config.PROFILES / f"{u}.json").exists()]
    labels = [json.loads(line) for line in open(config.DATA / "labels.jsonl") if line.strip()]
    human = [r for r in labels if r.get("source") == "human" and (config.PROFILES / f"{r['username']}.json").exists()]
    rng = random.Random(seed)
    yes = rng.sample(sorted({r["username"] for r in human if r["label"] == "Yes"}), sample)
    no = rng.sample(sorted({r["username"] for r in human if r["label"] == "No"}), sample)
    gemini = Gemini(budget=budget, run="profile-match", purpose="profile match: active lifestyle")
    groups = {"collab": collab, "past yes": yes, "past no": no}
    report = {}
    with ThreadPoolExecutor(6) as pool:
        for name, users in groups.items():
            scores = [m for m in pool.map(lambda u: score(u, gemini), users) if m]
            values = np.array([m["score"] for m in scores])
            report[name] = {
                "profiles": len(scores),
                "median": int(np.median(values)) if len(values) else None,
                "by_level": {lv: sum(m["level"] == lv for m in scores) for lv in ("high", "medium", "low")},
                "lowest": sorted(((m["score"], u) for u, m in zip(users, scores)))[:3] if len(scores) == len(users) else [],
            }
    report["spent_usd"] = round(gemini.spent, 3)
    REPORT.write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["check", "score"])
    parser.add_argument("username", nargs="?")
    parser.add_argument("--sample", type=int, default=50)
    parser.add_argument("--budget", type=float, default=0.5)
    args = parser.parse_args()
    if args.command == "check":
        check(args.sample, args.budget)
    else:
        print(json.dumps(score(args.username, Gemini(budget=0.05, run="profile-match", purpose="profile match")), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
