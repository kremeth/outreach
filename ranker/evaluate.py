"""Evaluate a saved checkpoint locally on the time-ordered split.

    .venv/bin/python -m ranker.evaluate [--checkpoint path] [--dataset path]

By default it evaluates ranker-eval.pt (trained on the training split only), so the test numbers are
on rounds the network never saw.
"""
import argparse
import json
import sys

from . import config
from .data import examples_for, load_rounds, split
from .train import load_checkpoint, metrics


def evaluate(checkpoint=None, dataset=None):
    models, featuriser, info = load_checkpoint(checkpoint or config.EVAL_CHECKPOINT_PATH)
    parts = split(examples_for(load_rounds(dataset), featuriser))
    return {"checkpoint": str(checkpoint or config.EVAL_CHECKPOINT_PATH), "trainedAt": info.get("trained_at"), **{name: metrics(models, parts[name]) for name in ("train", "val", "test")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--checkpoint", default=None)
    parser.add_argument("--dataset", default=None)
    args = parser.parse_args()
    print(json.dumps(evaluate(args.checkpoint, args.dataset), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
