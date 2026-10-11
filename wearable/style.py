"""Profile match: how much a profile looks like the ones we say Yes to (whatever the wearable).

    .venv/bin/python -m wearable.style build [--negatives 300] [--budget 1]   # the Yes database
    .venv/bin/python -m wearable.style score <username>                       # one profile

1. Every human-labelled Yes profile (data/wearable/labels.jsonl) gets a short description from
   Gemini Flash-Lite: who they are, what they post, their style and audience, from their first 12
   photos, bio, name, follower count and captions. Wearables are left out on purpose: this score is
   about the kind of profile, the wearable model handles the device. A sample of human-labelled No
   profiles gets the same description, to calibrate against.
2. Locally: each description is embedded with the comment ranker's Sentence-BERT, the photos with
   CLIP (both already on disk, offline). A profile's similarity to the Yes database is the mean
   cosine to its 10 nearest Yes profiles, text and photos, minus the same against the No sample.
3. A small logistic regression on those similarities (cross-validated) gives the score; 0-100 is
   where that lands among the Yes profiles' own scores (50 = a typical Yes). Levels: high from 50,
   medium from 20, low below.
The description prompt is the same for the database and for every new profile, so they compare.
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
MODEL_PATH = DIR / "model.npz"
REPORT = DIR / "report.json"
STYLE_TEXT = DIR / "yes-style.md"
VERSION = "style-v1"
DESCRIBE_MODEL = "gemini-3.1-flash-lite"
PHOTOS = 12
K = 10

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


def _knn(vector, matrix, skip=None):
    if not len(matrix):
        return 0.0
    sims = matrix @ vector
    if skip is not None:
        sims = np.delete(sims, skip)
    return float(np.sort(sims)[-K:].mean())


def _features(text_vec, image_vec, db, skip_yes=None, skip_no=None):
    return np.array([
        _knn(text_vec, db["text_yes"], skip_yes) - _knn(text_vec, db["text_no"], skip_no),
        _knn(image_vec, db["image_yes"], skip_yes) - _knn(image_vec, db["image_no"], skip_no),
        _knn(text_vec, db["text_yes"], skip_yes),
        _knn(image_vec, db["image_yes"], skip_yes),
    ], dtype=np.float32)


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


def _fit_logistic(x, y, steps=3000, lr=0.5, l2=1e-3):
    mean, std = x.mean(axis=0), x.std(axis=0) + 1e-6
    z = (x - mean) / std
    w, b = np.zeros(z.shape[1]), 0.0
    weight = np.where(y == 1, len(y) / (2 * max(1, y.sum())), len(y) / (2 * max(1, (1 - y).sum())))
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(z @ w + b)))
        grad = (p - y) * weight
        w -= lr * (z.T @ grad / len(y) + l2 * w)
        b -= lr * grad.mean()
    return {"w": w, "b": b, "mean": mean, "std": std}


def _predict(model, x):
    z = (x - model["mean"]) / model["std"]
    return 1 / (1 + np.exp(-(z @ model["w"] + model["b"])))


def _auc(scores, y):
    pos, neg = scores[y == 1], scores[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    return float((pos[:, None] > neg[None, :]).mean() + 0.5 * (pos[:, None] == neg[None, :]).mean())


def build(negatives=300, budget=1.0, seed=42):
    DIR.mkdir(parents=True, exist_ok=True)
    labels = [json.loads(line) for line in open(config.DATA / "labels.jsonl") if line.strip()]
    human = [r for r in labels if r.get("source") == "human" and (config.PROFILES / f"{r['username']}.json").exists()]
    yes = sorted({r["username"] for r in human if r["label"] == "Yes"})
    no_all = sorted({r["username"] for r in human if r["label"] == "No"} - set(yes))
    no = sorted(random.Random(seed).sample(no_all, min(negatives, len(no_all))))
    gemini = Gemini(budget=budget, run="profile-match", purpose="profile match: descriptions")
    print(f"describing {len(yes)} Yes and {len(no)} No profiles (cached ones are free)", flush=True)
    with ThreadPoolExecutor(6) as pool:
        answers = dict(zip(yes + no, pool.map(lambda u: describe(u, gemini), yes + no)))
    with open(DESCRIPTIONS, "w") as handle:
        for username, answer in answers.items():
            if answer:
                handle.write(json.dumps({"username": username, "label": "Yes" if username in yes else "No", **answer}) + "\n")
    yes = [u for u in yes if answers.get(u)]
    no = [u for u in no if answers.get(u)]
    print(f"described: {len(yes)} Yes, {len(no)} No; ${gemini.spent:.3f}; embedding locally", flush=True)
    text = _text_vectors([description_text(answers[u]) for u in yes + no])
    image = np.stack([_image_vector(u) for u in yes + no])
    n_yes = len(yes)
    db = {"text_yes": text[:n_yes], "text_no": text[n_yes:], "image_yes": image[:n_yes], "image_no": image[n_yes:]}
    x = np.stack([_features(text[i], image[i], db, skip_yes=i if i < n_yes else None, skip_no=i - n_yes if i >= n_yes else None) for i in range(len(yes) + len(no))])
    y = np.array([1] * n_yes + [0] * len(no), dtype=np.float32)
    # 5-fold cross-validation for an honest AUC (the kNN features already leave each profile out).
    order = np.random.default_rng(seed).permutation(len(y))
    held = np.zeros(len(y))
    for fold in range(5):
        test = order[fold::5]
        train = np.setdiff1d(order, test)
        held[test] = _predict(_fit_logistic(x[train], y[train]), x[test])
    model = _fit_logistic(x, y)
    fitted = _predict(model, x)
    yes_scores = np.sort(fitted[:n_yes])
    np.savez(MODEL_PATH, **db, w=model["w"], b=model["b"], mean=model["mean"], std=model["std"], yes_scores=yes_scores, usernames_yes=np.array(yes))
    pct = lambda s: float(np.searchsorted(yes_scores, s) / len(yes_scores) * 100)
    no_levels = [level(pct(s)) for s in fitted[n_yes:]]
    report = {
        "yes": n_yes,
        "no": len(no),
        "auc_cross_validated": round(_auc(held, y), 3),
        "auc_text_only": round(_auc(x[:, 0], y), 3),
        "auc_photos_only": round(_auc(x[:, 1], y), 3),
        "no_profiles_by_level": {name: no_levels.count(name) for name in ("high", "medium", "low")},
        "spent_usd": round(gemini.spent, 3),
    }
    REPORT.write_text(json.dumps(report, indent=1))
    summarise([answers[u] for u in yes], gemini)
    print(json.dumps(report, indent=1), flush=True)
    return report


def summarise(answers, gemini):
    """One plain description of the profiles we say Yes to, for people (data/wearable/style/yes-style.md)."""
    lines = "\n".join(f"- {a.get('niche')}; {a.get('persona')}; {a.get('content_style')}; {a.get('audience')}" for a in answers)
    schema = {"type": "OBJECT", "properties": {"style": {"type": "STRING"}}, "required": ["style"]}
    prompt = f"These are short descriptions of the {len(answers)} Instagram creators a team said Yes to for a partnership:\n{lines}\n\nstyle: in 8-12 short bullet points (markdown, '- '), describe the kinds of profile they say Yes to: the main groups, typical niches, people, content and audiences, roughly how common each is. Plain words."
    result = gemini.generate("gemini-3.8-flash", VERSION + "-summary", [], prompt, schema, max_output_tokens=900)
    STYLE_TEXT.write_text("# The profiles we say Yes to\n\n" + result.get("answer", {}).get("style", "") + "\n")


def level(score):
    return "high" if score >= 50 else "medium" if score >= 20 else "low"


_db = None


def score(username, gemini):
    """{score 0-100, level, niche, summary} for one profile, or None if it cannot be described."""
    global _db
    if _db is None:
        if not MODEL_PATH.exists():
            return None
        _db = dict(np.load(MODEL_PATH))
    answer = describe(username, gemini)
    if not answer:
        return None
    text = _text_vectors([description_text(answer)])[0]
    image = _image_vector(username)
    model = {key: _db[key] for key in ("w", "b", "mean", "std")}
    probability = float(_predict(model, _features(text, image, _db)[None, :])[0])
    value = round(float(np.searchsorted(_db["yes_scores"], probability) / len(_db["yes_scores"]) * 100))
    return {"score": value, "level": level(value), "niche": answer.get("niche", ""), "summary": answer.get("summary", ""), "version": VERSION}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "score"])
    parser.add_argument("username", nargs="?")
    parser.add_argument("--negatives", type=int, default=300)
    parser.add_argument("--budget", type=float, default=1.0)
    args = parser.parse_args()
    if args.command == "build":
        build(args.negatives, args.budget)
    else:
        print(json.dumps(score(args.username, Gemini(budget=0.05, run="profile-match", purpose="profile match")), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
