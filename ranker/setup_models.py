"""One-time setup: download sentence-transformers/all-MiniLM-L6-v2 and save it locally.

    .venv/bin/python -m ranker.setup_models [--dir ./models/sentence_encoder]

This is the only part of the ranker that uses the network. After it has run, training,
evaluation and predictions load the encoder from that directory only, fully offline.
"""
import argparse
import os
import sys

# Lift offline mode for this download only (config.py turns it on for everything else).
for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
    os.environ[key] = "0"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

from . import config  # noqa: E402  (after the environment is set)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", default=str(config.ENCODER_DIR), help="where to save the encoder")
    parser.add_argument("--force", action="store_true", help="download again even if it is already there")
    args = parser.parse_args()
    target = os.path.abspath(args.dir)
    if os.path.exists(os.path.join(target, "config.json")) and not args.force:
        print(f"Encoder already saved in {target}. Nothing to do.")
        return 0
    from sentence_transformers import SentenceTransformer

    print(f"Downloading {config.ENCODER_NAME} …")
    model = SentenceTransformer(config.ENCODER_NAME, device="cpu")
    os.makedirs(target, exist_ok=True)
    model.save(target)
    print(f"Saved to {target}. The ranker now runs offline.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
