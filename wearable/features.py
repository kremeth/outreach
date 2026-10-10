"""Local features for the screening classifiers (no network: models load from models/).

Vision (Approach C): CLIP ViT-B/32 embeddings of every post image, cached per profile, aggregated as
mean, max or mean+max; an embedding of the first 3x3 grid; and zero-shot wearable scores (similarity
of each image to wearable descriptions, best image per profile).
Text (Approach B and D): all-MiniLM-L6-v2 (shared with the comment ranker) on Gemini's description
and/or the bio and captions.
"""
import json
import os

import numpy as np

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from . import config  # noqa: E402
from .grid import build_grids, load_profile, post_images  # noqa: E402

CLIP_DIR = config.ROOT / "models" / "clip"
CACHE = config.DATA / "features"
ZERO_SHOT = [
    "a photo of a person wearing a smartwatch on their wrist",
    "a close-up of a sports watch on a wrist",
    "a person wearing a fitness tracker band on their wrist",
    "a WHOOP strap on a wrist or upper arm",
    "a hand wearing a smart ring on a finger",
    "an Apple Watch",
    "a Garmin running watch",
]
NEUTRAL = ["a photo of a person", "a photo of food", "a photo of a landscape", "a photo of a product"]

_clip = None


def clip():
    global _clip
    if _clip is None:
        from sentence_transformers import SentenceTransformer

        _clip = SentenceTransformer(str(CLIP_DIR), device="cpu", local_files_only=True)
    return _clip


def image_embeddings(username):
    """[n_images, 512] normalised CLIP embeddings of a profile's images (cached)."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{username}.clip.npy"
    if path.exists():
        return np.load(path)
    from PIL import Image

    profile = load_profile(username)
    paths = post_images(profile) if profile else []
    if not paths:
        vectors = np.zeros((0, 512), dtype=np.float32)
    else:
        images = [Image.open(p).convert("RGB") for p in paths]
        vectors = clip().encode(images, batch_size=32, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False).astype(np.float32)
    np.save(path, vectors)
    return vectors


def grid_embedding(username):
    path = CACHE / f"{username}.grid.npy"
    if path.exists():
        return np.load(path)
    from PIL import Image

    grids = build_grids(username)
    vector = np.zeros(512, dtype=np.float32)
    if grids:
        vector = clip().encode([Image.open(grids[0][0]).convert("RGB")], convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False)[0].astype(np.float32)
    np.save(path, vector)
    return vector


_prompts = None


def prompt_vectors():
    global _prompts
    if _prompts is None:
        _prompts = clip().encode(ZERO_SHOT + NEUTRAL, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False)
    return _prompts


def zero_shot(vectors):
    """Per wearable prompt: best image's similarity minus its best neutral similarity (len(ZERO_SHOT))."""
    if not len(vectors):
        return np.zeros(len(ZERO_SHOT), dtype=np.float32)
    sims = vectors @ prompt_vectors().T
    wear, neutral = sims[:, : len(ZERO_SHOT)], sims[:, len(ZERO_SHOT):].max(axis=1, keepdims=True)
    return (wear - neutral).max(axis=0).astype(np.float32)


def vision(username, kind="mean+max"):
    vectors = image_embeddings(username)
    if kind == "grid":
        return grid_embedding(username)
    if kind == "zero-shot":
        return zero_shot(vectors)
    if not len(vectors):
        base = np.zeros(512 if kind != "mean+max" else 1024, dtype=np.float32)
    elif kind == "mean":
        base = vectors.mean(axis=0)
    elif kind == "max":
        base = vectors.max(axis=0)
    else:
        base = np.concatenate([vectors.mean(axis=0), vectors.max(axis=0)])
    return base.astype(np.float32)


def profile_text(username, description=""):
    profile = load_profile(username) or {}
    captions = " | ".join(post.get("caption", "")[:200] for post in profile.get("posts", [])[:12] if post.get("caption"))
    parts = [description, f"Bio: {profile.get('bio', '')}", f"Captions: {captions}"]
    return "\n".join(part for part in parts if part.strip())


def text_embeddings(texts):
    from ranker.encoder import embed  # the comment ranker's local Sentence-BERT, cached on disk

    return embed(texts)
