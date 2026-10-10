"""Train the comment ranker locally.

    .venv/bin/python -m ranker.train [--dataset path] [--epochs N] [--seeds N]

1. Every round's inputs are built (Sentence-BERT runs locally, embeddings cached on disk).
2. Time-ordered split: train / validation / test (the newest rounds, never used to fit or choose).
3. An ensemble (one network per seed) trains on the train split, each stopping at its best
   validation log-loss. That ensemble is scored on train, validation and test and saved as
   ranker-eval.pt.
4. The same recipe is trained on every round for the checkpoint used in predictions (ranker.pt).
Metrics go to metrics.json (and metrics-history.jsonl), progress to ranker.log. Nothing leaves the computer.
"""
import argparse
import copy
import datetime
import json
import logging
import random
import statistics
import sys
import time

import numpy as np
import torch
from torch import nn

from . import config
from .data import Featuriser, collate, examples_for, load_rounds, split
from .model import CommentRanker, count_parameters

log = logging.getLogger("ranker")


def setup_logging():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not log.handlers:
        log.setLevel(logging.INFO)
        handler = logging.FileHandler(config.LOG_PATH)
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        log.addHandler(handler)
        log.addHandler(logging.StreamHandler(sys.stderr))


def seed_everything(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def batches(items, size, shuffle, rng):
    order = list(range(len(items)))
    if shuffle:
        rng.shuffle(order)
    for start in range(0, len(order), size):
        yield [items[index] for index in order[start:start + size]]


def loss_of(model, inputs):
    logits = model(**{key: value for key, value in inputs.items() if key != "picked"})
    return nn.functional.cross_entropy(logits, inputs["picked"]), logits


@torch.no_grad()
def probabilities(models, items, device=torch.device("cpu")):
    """Average softmax of the ensemble, [N, 5]."""
    if not items:
        return np.zeros((0, 5))
    inputs = collate(items, device)
    total = None
    for model in models:
        model.eval()
        probs = torch.softmax(model(**{key: value for key, value in inputs.items() if key != "picked"}), dim=-1)
        total = probs if total is None else total + probs
    return (total / len(models)).cpu().numpy()


def metrics(models, examples, device=torch.device("cpu")):
    """Right first guess, right in the top 2, log-loss; overall and per person."""
    items = [features for _, features in examples]
    if not items:
        return {"rounds": 0}
    probs = probabilities(models, items, device)
    picked = np.array([item["picked"] for item in items])
    order = np.argsort(-probs, axis=1)
    top1 = order[:, 0] == picked
    top2 = (order[:, :2] == picked[:, None]).any(axis=1)
    loss = -np.log(np.clip(probs[np.arange(len(items)), picked], 1e-9, 1))
    by_person = {}
    for (round_, _), hit in zip(examples, top1):
        person = round_.get("person") or "unknown"
        entry = by_person.setdefault(person, {"rounds": 0, "correct": 0})
        entry["rounds"] += 1
        entry["correct"] += int(hit)
    return {"rounds": len(items), "accuracy": float(top1.mean()), "top2": float(top2.mean()), "logLoss": float(loss.mean()), "byPerson": by_person}


def train_one(train_items, val_items, people, seed, device, epochs=None, max_epochs=None, patience=None):
    """One network. With val_items: stops at the best validation log-loss. Without: trains `epochs` epochs."""
    seed_everything(seed)
    model = CommentRanker(people=people, **config.MODEL).to(device)
    optimiser = torch.optim.AdamW(model.parameters(), lr=config.TRAIN["lr"], weight_decay=config.TRAIN["weight_decay"])
    rng = random.Random(seed)
    max_epochs = max_epochs or config.TRAIN["max_epochs"]
    patience = patience or config.TRAIN["patience"]
    best = {"loss": float("inf"), "epoch": 0, "state": copy.deepcopy(model.state_dict())}
    for epoch in range(1, (epochs or max_epochs) + 1):
        model.train()
        for batch in batches(train_items, config.TRAIN["batch_size"], True, rng):
            optimiser.zero_grad()
            loss, _ = loss_of(model, collate(batch, device))
            loss.backward()
            optimiser.step()
        if val_items:
            model.eval()
            with torch.no_grad():
                val_loss, _ = loss_of(model, collate(val_items, device))
            if val_loss.item() < best["loss"] - 1e-4:
                best = {"loss": val_loss.item(), "epoch": epoch, "state": copy.deepcopy(model.state_dict())}
            elif epoch - best["epoch"] >= patience:
                break
    if val_items:
        model.load_state_dict(best["state"])
    return model.cpu(), best["epoch"] if val_items else (epochs or max_epochs), best["loss"]


def save_checkpoint(path, models, featuriser, people, extra):
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "version": 1,
        "model_config": {**config.MODEL, "people": people},
        "featuriser": featuriser.state(),
        "states": [model.state_dict() for model in models],
        **extra,
    }, path)


def load_checkpoint(path=None):
    """(models, featuriser, checkpoint) from a local checkpoint file, on CPU."""
    checkpoint = torch.load(str(path or config.CHECKPOINT_PATH), map_location="cpu", weights_only=False)
    models = []
    for state in checkpoint["states"]:
        model = CommentRanker(**checkpoint["model_config"])
        model.load_state_dict(state)
        model.eval()
        models.append(model)
    return models, Featuriser(**checkpoint["featuriser"]), checkpoint


def train(dataset_path=None, seeds=None, max_epochs=None, checkpoint_dir=None, quiet=False):
    setup_logging()
    started = time.time()
    device = config.device()
    rounds = load_rounds(dataset_path)
    featuriser = Featuriser.fit(rounds)
    people = len(featuriser.people)
    examples = examples_for(rounds, featuriser)
    parts = split(examples)
    log.info("rounds %d, picked %d | train %d, validation %d, test %d | device %s", len(rounds), len(examples), len(parts["train"]), len(parts["val"]), len(parts["test"]), device)
    train_items = [features for _, features in parts["train"]]
    val_items = [features for _, features in parts["val"]]
    seeds = seeds or config.TRAIN["seeds"]

    # 3. Train split, early stopping on validation.
    split_models, best_epochs = [], []
    for seed in range(seeds):
        model, epoch, val_loss = train_one(train_items, val_items, people, seed, device, max_epochs=max_epochs)
        split_models.append(model)
        best_epochs.append(max(1, epoch))
        log.info("seed %d: best epoch %d, validation log-loss %.4f", seed, epoch, val_loss)
    scores = {name: metrics(split_models, parts[name]) for name in ("train", "val", "test")}
    picked_train = [round_["picked"] for round_, _ in parts["train"]]
    favourite = max(range(5), key=picked_train.count) if picked_train else 0
    test_picked = [round_["picked"] for round_, _ in parts["test"]]
    baseline = {"random": 0.2, "favouriteSlot": (test_picked.count(favourite) / len(test_picked)) if test_picked else 0, "favourite": favourite + 1}

    # 4. Every round, for predictions.
    epochs = int(statistics.median(best_epochs))
    all_items = [features for _, features in parts["all"]]
    final_models = [train_one(all_items, None, people, seed, device, epochs=epochs)[0] for seed in range(seeds)]

    directory = checkpoint_dir or config.CHECKPOINT_DIR
    trained_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    info = {"trained_at": trained_at, "epochs": epochs, "rounds": len(examples)}
    save_checkpoint(directory / config.EVAL_CHECKPOINT_PATH.name, split_models, featuriser, people, info)
    save_checkpoint(directory / config.CHECKPOINT_PATH.name, final_models, featuriser, people, info)
    result = {
        "trainedAt": trained_at,
        "rounds": len(examples),
        "split": {name: len(parts[name]) for name in ("train", "val", "test")},
        "train": scores["train"],
        "validation": scores["val"],
        "test": scores["test"],
        "baseline": baseline,
        "epochs": epochs,
        "seeds": seeds,
        "parameters": count_parameters(final_models[0]),
        "people": featuriser.people,
        "device": str(device),
        "seconds": round(time.time() - started, 1),
    }
    if checkpoint_dir is None:
        config.METRICS_PATH.write_text(json.dumps(result, indent=1))
        with open(config.HISTORY_PATH, "a") as history:
            history.write(json.dumps({key: result[key] for key in ("trainedAt", "rounds", "split", "train", "validation", "test", "epochs")}) + "\n")
    log.info("test: %.0f%% right first guess, log-loss %.3f (random 20%%, 1.609) | %.0fs", 100 * scores["test"].get("accuracy", 0), scores["test"].get("logLoss", 0), result["seconds"])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", default=None)
    parser.add_argument("--seeds", type=int, default=None)
    parser.add_argument("--epochs", type=int, default=None, help="maximum epochs")
    args = parser.parse_args()
    result = train(args.dataset, args.seeds, args.epochs)
    print(json.dumps({key: result[key] for key in ("rounds", "split", "train", "validation", "test", "baseline", "epochs", "parameters", "seconds")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
