"""Local inference: five comment strings in, five softmax probabilities out. No network requests."""
import os
from pathlib import Path

import numpy as np
import torch

from . import config
from .data import collate, load_rounds

_loaded = {"path": None, "mtime": None, "models": None, "featuriser": None}


def _models(checkpoint=None):
    """The checkpoint's networks, reloaded automatically when the file changes (after a retrain)."""
    from .train import load_checkpoint

    path = Path(checkpoint or config.CHECKPOINT_PATH)
    if not path.exists():
        raise FileNotFoundError(f"No trained ranker at {path}. Train it first: .venv/bin/python -m ranker.train")
    mtime = os.path.getmtime(path)
    if _loaded["path"] != str(path) or _loaded["mtime"] != mtime:
        models, featuriser, _ = load_checkpoint(path)
        _loaded.update(path=str(path), mtime=mtime, models=models, featuriser=featuriser)
    return _loaded["models"], _loaded["featuriser"]


def _history(dataset=None):
    """Earlier picked rounds from the local dataset (the network's memory); empty if there is none."""
    try:
        return [item for item in load_rounds(dataset) if item.get("picked") is not None]
    except FileNotFoundError:
        return []


def percentages(probabilities):
    """Whole percentages that add up to exactly 100 (largest remainder)."""
    raw = [p * 100 for p in probabilities]
    out = [int(value) for value in raw]
    for index in sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)[: 100 - sum(out)]:
        out[index] += 1
    return out


@torch.no_grad()
def predict_comments(comments, context="", person=None, history=None, checkpoint=None, dataset=None):
    """Score five Gemini-written comments locally.

    comments: the 5 comment strings. context: the post's description (optional). person: who is
    choosing (as in the dataset, e.g. the computer's name; optional). history: earlier picked rounds
    (defaults to the local dataset).
    Returns {"probabilities": [5 floats summing to 1], "percentages": [5 ints summing to 100],
             "best_index": int, "best_comment": str}.
    """
    comments = [str(text or "").strip() for text in comments]
    if len(comments) != 5 or not all(comments):
        raise ValueError("predict_comments needs exactly 5 non-empty comments.")
    models, featuriser = _models(checkpoint)
    past = _history(dataset) if history is None else history
    round_ = {"comments": comments, "context": context or "", "person": person}
    inputs = collate([featuriser.build(round_, past)])
    inputs.pop("picked", None)
    total = None
    for model in models:
        probs = torch.softmax(model(**inputs), dim=-1)[0]
        total = probs if total is None else total + probs
    probabilities = (total / len(models)).numpy().astype(np.float64)
    probabilities = probabilities / probabilities.sum()
    best = int(np.argmax(probabilities))
    return {
        "probabilities": [float(p) for p in probabilities],
        "percentages": percentages(probabilities),
        "best_index": best,
        "best_comment": comments[best],
    }
