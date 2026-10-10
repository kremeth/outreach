"""Local screening classifiers: training, cross-validation and threshold selection.

Protocol (the same folds for every model and feature set):
- A stratified 20% test set is held back and never used to fit, choose or tune anything.
- 5-fold stratified cross-validation on the rest gives out-of-fold scores for every training profile.
- Models: weighted logistic regression, and a small network (in -> 64 -> 2, GELU, dropout) with
  weighted cross-entropy; positive weights computed from the training fold only (none, sqrt, full).
- The threshold is the highest score that keeps >= the recall target out of fold; it is then applied
  once to the test set. Recall comes with a Wilson 95% interval.
"""
import json
import math
import random

import numpy as np
import torch
from torch import nn

from .evaluate import wilson

SEED = 7


def set_seed(seed=SEED):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def stratified_split(labels, test_share=0.2, seed=SEED):
    rng = np.random.default_rng(seed)
    labels = np.asarray(labels)
    test = []
    for value in (0, 1):
        index = np.flatnonzero(labels == value)
        rng.shuffle(index)
        test.extend(index[: int(round(len(index) * test_share))])
    test = np.array(sorted(test))
    train = np.setdiff1d(np.arange(len(labels)), test)
    return train, test


def stratified_folds(labels, k=5, seed=SEED):
    rng = np.random.default_rng(seed)
    labels = np.asarray(labels)
    fold = np.zeros(len(labels), dtype=int)
    for value in (0, 1):
        index = np.flatnonzero(labels == value)
        rng.shuffle(index)
        fold[index] = np.arange(len(index)) % k
    return fold


class SmallNet(nn.Module):
    """in -> 64 -> 2 (No, Yes)."""

    def __init__(self, dim, hidden=64, dropout=0.3):
        super().__init__()
        self.layers = nn.Sequential(nn.Linear(dim, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, 2))

    def forward(self, x):
        return self.layers(x)


class Logistic(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.layer = nn.Linear(dim, 2)

    def forward(self, x):
        return self.layer(x)


def class_weight(y, mode):
    positives = max(1, int(y.sum()))
    negatives = max(1, int(len(y) - y.sum()))
    ratio = negatives / positives
    return torch.tensor([1.0, {"none": 1.0, "sqrt": math.sqrt(ratio), "full": ratio}[mode]], dtype=torch.float32)


def fit(x, y, model="net", weight="full", epochs=300, patience=30, lr=1e-3, decay=1e-3):
    """Trains on (x, y) with an inner 15% validation split for early stopping; returns a scorer."""
    set_seed()
    mean, std = x.mean(axis=0), x.std(axis=0) + 1e-6
    xs = torch.tensor((x - mean) / std, dtype=torch.float32)
    ys = torch.tensor(y, dtype=torch.long)
    inner_train, inner_val = stratified_split(y, 0.15, seed=SEED + 1)
    net = SmallNet(x.shape[1]) if model == "net" else Logistic(x.shape[1])
    loss_fn = nn.CrossEntropyLoss(weight=class_weight(y[inner_train], weight))
    optimiser = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=decay)
    best, best_state, since = float("inf"), None, 0
    for _ in range(epochs):
        net.train()
        for batch in torch.randperm(len(inner_train)).split(64):
            index = torch.tensor(inner_train)[batch]
            optimiser.zero_grad()
            loss_fn(net(xs[index]), ys[index]).backward()
            optimiser.step()
        net.eval()
        with torch.no_grad():
            val = loss_fn(net(xs[inner_val]), ys[inner_val]).item()
        if val < best - 1e-4:
            best, best_state, since = val, {k: v.clone() for k, v in net.state_dict().items()}, 0
        else:
            since += 1
            if since >= patience:
                break
    net.load_state_dict(best_state)
    net.eval()

    def score(x_new):
        with torch.no_grad():
            logits = net(torch.tensor((x_new - mean) / std, dtype=torch.float32))
            return torch.softmax(logits, dim=-1)[:, 1].numpy()

    return score


def threshold_for(scores, y, target=0.98):
    """Highest threshold keeping >= target recall on these labelled scores (screen: score >= t)."""
    positives = np.sort(scores[y == 1])
    if not len(positives):
        return 0.0
    keep = int(math.ceil(target * len(positives)))
    return float(positives[len(positives) - keep])


def sweep(scores, y, thresholds=None):
    """Recall, missed, negatives escalated and escalation share at each threshold."""
    rows = []
    for t in thresholds if thresholds is not None else sorted(set(np.round(np.quantile(scores, np.linspace(0, 1, 41)), 4))):
        kept = scores >= t
        rows.append({
            "threshold": float(t),
            "recall": float(kept[y == 1].mean()) if (y == 1).any() else 0.0,
            "missed": int((~kept & (y == 1)).sum()),
            "negatives_escalated": int((kept & (y == 0)).sum()),
            "escalated_share": float(kept.mean()),
        })
    return rows


def evaluate_features(x, y, model="net", weight="full", target=0.98, k=5):
    """Out-of-fold scores on the training part, threshold at the target, then the untouched test set."""
    train, test = stratified_split(y)
    folds = stratified_folds(y[train], k)
    oof = np.zeros(len(train))
    for f in range(k):
        inner, held = train[folds != f], train[folds == f]
        oof[folds == f] = fit(x[inner], y[inner], model, weight)(x[held])
    threshold = threshold_for(oof, y[train], target)
    test_scores = fit(x[train], y[train], model, weight)(x[test])
    kept_oof = oof >= threshold
    kept_test = test_scores >= threshold
    y_train, y_test = y[train], y[test]

    def summary(kept, labels):
        hits = int(kept[labels == 1].sum())
        positives = int((labels == 1).sum())
        return {
            "recall": hits / max(1, positives),
            "recall_ci": wilson(hits, positives),
            "missed": positives - hits,
            "escalated_share": float(kept.mean()),
            "negatives_escalated": int(kept[labels == 0].sum()),
            "negatives": int((labels == 0).sum()),
            "positives": positives,
        }

    order = np.argsort(-oof)
    auc_pairs = sum((oof[y_train == 1][:, None] > oof[y_train == 0][None, :]).ravel()) / max(1, (y_train == 1).sum() * (y_train == 0).sum())
    return {
        "model": model,
        "weight": weight,
        "threshold": threshold,
        "auc_oof": float(auc_pairs),
        "oof": summary(kept_oof, y_train),
        "test": summary(kept_test, y_test),
        "test_index": test.tolist(),
        "test_scores": test_scores.tolist(),
        "oof_index": train.tolist(),
        "oof_scores": oof.tolist(),
        "ranking_head": order[:5].tolist(),
    }
