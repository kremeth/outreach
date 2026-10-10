"""One-time download of the local vision model for wearable screening (CLIP ViT-B/32, via
sentence-transformers) to models/clip/. Afterwards it is only loaded from disk, offline.
The text encoder (all-MiniLM-L6-v2) is shared with the comment ranker (ranker/setup_models.py).

    .venv/bin/python -m wearable.setup_models
"""
import os
import sys

for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
    os.environ[key] = "0"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from . import config  # noqa: E402

CLIP_NAME = "sentence-transformers/clip-ViT-B-32"
CLIP_DIR = config.ROOT / "models" / "clip"


def main():
    if (CLIP_DIR / "modules.json").exists():
        print(f"CLIP already saved in {CLIP_DIR}.")
        return 0
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(CLIP_NAME, device="cpu")
    CLIP_DIR.mkdir(parents=True, exist_ok=True)
    model.save(str(CLIP_DIR))
    print(f"Saved {CLIP_NAME} to {CLIP_DIR}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
