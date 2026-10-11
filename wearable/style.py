"""Profile match: how close a profile is to the creators we actually did collabs with.

    .venv/bin/python -m wearable.style build [--budget 1]   # the ground truth set
    .venv/bin/python -m wearable.style score <username>      # one profile

Ground truth: every creator on the "2. 'Yes' Collaboration Tracking" tab (data/wearable/collab-
usernames.json, written from the sheet). Each profile, ground truth and new alike, is turned into one
vector the same way:
1. Gemini Flash-Lite describes it (who they are, what they post, their style and audience) from the
   first 12 photos, bio, name, followers and captions, wearables left out on purpose (the wearable
   model handles the device). Sentence-BERT (local) embeds that description.
2. CLIP (local) embeds every photo; their mean is the profile's look.
3. The two, each normalised, are joined and normalised again: one unit vector per profile.
Profile match = cosine similarity between the profile's vector and the ground truth set: the mean
cosine to its 5 closest collab creators (the set is varied, athletes, mums, coaches..., so the
closest ones say more than the average of all). Shown 0-100 as where that cosine falls among the
collab creators' own cosines to the rest of the set (50 = as close as a typical collab creator is
to the others). Levels: high from 50, medium from 15, low below.
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
DESCRIPTIONS = DIR / "descriptions.jsonl"
MODEL_PATH = DIR / "collab.npz"
REPORT = DIR / "report.json"
STYLE_TEXT = DIR / "collab-style.md"
GROUND_TRUTH = config.DATA / "collab-usernames.json"
VERSION = "style-v1"  # the description prompt (Gemini's cache key): unchanged, so descriptions are reused
MATCH_VERSION = "collab-v1"
DESCRIBE_MODEL = "gemini-3.1-flash-lite"
PHOTOS = 12
TOP = 5
HIGH, MEDIUM = 50, 15

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "summary": {"type": "STRING"},
        "niche": {"type": "STRING"},
        "persona": {"type": "STRING"},
        "content_style": {"type": "STRING"},
        "audience": {"type": "STRING"},
    },
    "required": ["summary", "niche", "persona", "content_style", "audience"],
}

PROMPT = """Above are the latest photos of one Instagram creator. Their profile:
username @{username}, name "{name}", {followers}, bio "{bio}".
Recent captions: {captions}

Describe this creator's profile as someone deciding whether they are the kind of creator a brand would partner with. Ignore any watches, rings or fitness trackers: describe the person and their content only.
summary: 2-3 plain sentences: who they are, what they post, and how it looks and feels.
niche: a few words (e.g. "marathon runner and coach", "mum lifestyle", "bodybuilding", "food and recipes", "makeup artist").
persona: a few words on the person (e.g. "woman in her 30s, mother of two, Sydney").
content_style: a few words on the content (e.g. "polished gym reels with tips", "casual family photos", "studio product shots").
audience: a few words on who follows them (e.g. "women into fitness and wellness")."""


def describe(username, gemini):
    """The profile description (cached by Gemini's request cache, so asking twice is free)."""
    profile = load_profile(username)
    if not profile or profile.get("status") != "ok":
        return None
    files = [config.IMAGES_ROOT / post["file"] for post in profile.get("posts", []) if post.get("file")][:PHOTOS]
    captions = " | ".join(str(post.get("caption", ""))[:160] for post in profile.get("posts", []) if post.get("caption"))[:1200]
    text = PROMPT.format(username=username, name=profile.get("name", ""), followers=profile.get("followers", "") or "followers unknown", bio=str(profile.get("bio", ""))[:400], captions=captions or "none")
    result = gemini.generate(DESCRIBE_MODEL, VERSION, [path.read_bytes() for path in files], text, SCHEMA, max_output_tokens=500, media_resolution="MEDIA_RESOLUTION_LOW")
    answer = result.get("answer", {})
    return None if "_unparsed" in answer else answer


def description_text(answer):
    return f"{answer.get('niche', '')}. {answer.get('persona', '')}. {answer.get('content_style', '')}. {answer.get('audience', '')}. {answer.get('summary', '')}"


def _image_vector(username):
    from .features import image_embeddings

    vectors = image_embeddings(username)
    if not len(vectors):
        return np.zeros(512, dtype=np.float32)
    mean = vectors.mean(axis=0)
    return (mean / (np.linalg.norm(mean) or 1)).astype(np.float32)


def _text_vectors(texts):
    from .features import text_embeddings

    vectors = np.asarray(text_embeddings(texts), dtype=np.float32)
    return vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)


def vector(username, answer):
    """One unit vector per profile: its description (Sentence-BERT) and its photos (CLIP), equally weighted."""
    joined = np.concatenate([_text_vectors([description_text(answer)])[0], _image_vector(username)])
    return (joined / (np.linalg.norm(joined) or 1)).astype(np.float32)


def similarity(v, matrix, skip=None):
    """Mean cosine to the TOP closest ground truth profiles, and which ones they are."""
    sims = matrix @ v
    if skip is not None:
        sims[skip] = -np.inf
    order = np.argsort(-sims)[:TOP]
    return float(sims[order].mean()), order


def level(score):
    return "high" if score >= HIGH else "medium" if score >= MEDIUM else "low"


def _percentile(value, reference):
    return round(float(np.searchsorted(reference, value) / len(reference) * 100))


def _auc(scores, y):
    pos, neg = scores[y == 1], scores[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def build(budget=1.0):
    DIR.mkdir(parents=True, exist_ok=True)
    collab = [u for u in json.loads(GROUND_TRUTH.read_text()) if (config.PROFILES / f"{u}.json").exists()]
    gemini = Gemini(budget=budget, run="profile-match", purpose="profile match: descriptions")
    with ThreadPoolExecutor(6) as pool:
        answers = dict(zip(collab, pool.map(lambda u: describe(u, gemini), collab)))
    collab = [u for u in collab if answers.get(u)]
    print(f"ground truth: {len(collab)} collab creators described (${gemini.spent:.3f}); embedding locally", flush=True)
    matrix = np.stack([vector(u, answers[u]) for u in collab])
    own = np.sort([similarity(matrix[i], matrix, skip=i)[0] for i in range(len(collab))])
    np.savez(MODEL_PATH, matrix=matrix, usernames=np.array(collab), own=own)
    # How it separates the profiles we said Yes and No to before (described for the first version).
    labelled = [json.loads(line) for line in open(DESCRIPTIONS)] if DESCRIPTIONS.exists() else []
    labelled = [r for r in labelled if r["username"] not in set(collab)]
    sims = np.array([similarity(vector(r["username"], r), matrix)[0] for r in labelled]) if labelled else np.zeros(0)
    y = np.array([1 if r["label"] == "Yes" else 0 for r in labelled])
    pct = np.array([_percentile(v, own) for v in sims])
    levels = lambda mask: {name: int(sum(level(p) == name for p in pct[mask])) for name in ("high", "medium", "low")}
    report = {
        "ground_truth": len(collab),
        "collab_cosine_to_set": {"median": round(float(np.median(own)), 3), "min": round(float(own[0]), 3), "max": round(float(own[-1]), 3)},
        "labelled_yes": int(y.sum()),
        "labelled_no": int(len(y) - y.sum()),
        "auc_yes_vs_no": round(_auc(sims, y), 3) if len(y) else None,
        "median_cosine": {"yes": round(float(np.median(sims[y == 1])), 3) if y.sum() else None, "no": round(float(np.median(sims[y == 0])), 3) if (1 - y).sum() else None},
        "yes_by_level": levels(y == 1) if len(y) else {},
        "no_by_level": levels(y == 0) if len(y) else {},
        "spent_usd": round(gemini.spent, 3),
    }
    REPORT.write_text(json.dumps(report, indent=1))
    summarise([answers[u] for u in collab], gemini)
    print(json.dumps(report, indent=1), flush=True)
    return report


def summarise(answers, gemini):
    """One plain description of the creators we did collabs with, for people (data/wearable/style/collab-style.md)."""
    lines = "\n".join(f"- {a.get('niche')}; {a.get('persona')}; {a.get('content_style')}; {a.get('audience')}" for a in answers)
    schema = {"type": "OBJECT", "properties": {"style": {"type": "STRING"}}, "required": ["style"]}
    prompt = f"These are short descriptions of the {len(answers)} Instagram creators a brand has done collaborations with:\n{lines}\n\nstyle: in 6-10 short bullet points (markdown, '- '), describe the kinds of creator they collaborate with: the main groups, typical niches, people, content and audiences, roughly how common each is. Plain words."
    result = gemini.generate("gemini-3.8-flash", MATCH_VERSION + "-summary", [], prompt, schema, max_output_tokens=900)
    STYLE_TEXT.write_text("# The creators we did collabs with\n\n" + result.get("answer", {}).get("style", "") + "\n")


_db = None


def score(username, gemini):
    """{score 0-100, level, cosine, closest, niche} for one profile, or None if it cannot be described."""
    global _db
    if _db is None:
        if not MODEL_PATH.exists():
            return None
        _db = dict(np.load(MODEL_PATH))
    answer = describe(username, gemini)
    if not answer:
        return None
    names = [str(u) for u in _db["usernames"]]
    skip = names.index(username) if username in names else None
    cosine, closest = similarity(vector(username, answer), _db["matrix"], skip)
    value = _percentile(cosine, _db["own"])
    return {
        "score": value,
        "level": level(value),
        "cosine": round(cosine, 3),
        "closest": [names[i] for i in closest[:3]],
        "niche": answer.get("niche", ""),
        "summary": answer.get("summary", ""),
        "version": MATCH_VERSION,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "score"])
    parser.add_argument("username", nargs="?")
    parser.add_argument("--budget", type=float, default=1.0)
    args = parser.parse_args()
    if args.command == "build":
        build(args.budget)
    else:
        print(json.dumps(score(args.username, Gemini(budget=0.05, run="profile-match", purpose="profile match")), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
