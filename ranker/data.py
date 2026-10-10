"""The training data and the network's inputs.

dataset.jsonl (written locally by Outreach from the "HUSTLING Training Data" tab), one round per line:
    {"key", "time", "person", "comments": [5 strings], "picked": 0-4 or null, "outcome", "context"}
Rounds with a pick are the examples; every round with a pick also serves as memory for later ones.

Inputs for one round (B = batch):
    comments  [5, 384]        Sentence-BERT embeddings of the 5 comments
    plain     [5, 12]         slot (one-hot 5) + style (7): length, words, emoji, "!", capital start, all lower, "haha"
    context   [385]           the post's embedding (description, caption, transcript) + whether there is one
    memory    [M, 387]        the comments of the MEMORY_ROUNDS earlier rounds: embedding + picked + same person + recency
    person    int             who is choosing (index into the people list; 0 = unknown)
"""
import json
import math
import re
from pathlib import Path

import numpy as np
import torch

from . import config
from .encoder import embed

STYLE_SIZE = 7
PLAIN_SIZE = 5 + STYLE_SIZE
MEMORY_EXTRA = 3


def load_rounds(path=None):
    """All rounds, oldest first."""
    path = Path(path or config.DATASET_PATH)
    if not path.exists():
        raise FileNotFoundError(f"No dataset at {path}. Outreach writes it from the training tab.")
    rounds = []
    # split("\n"), not splitlines(): captions can hold Unicode line separators inside the JSON strings.
    for line in path.read_text(encoding="utf-8").split("\n"):
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        if len(item.get("comments") or []) == 5 and all(item["comments"]):
            rounds.append(item)
    rounds.sort(key=lambda item: item.get("time", ""))
    return rounds


def is_emoji(char):
    code = ord(char)
    return code >= 0x1F000 or 0x2600 <= code <= 0x27BF or 0x2B00 <= code <= 0x2BFF


def style(text):
    letters = re.sub(r"[^\w]|[\d_]", "", text)
    return [
        math.log(1 + len(text)),
        len(text.split()),
        1.0 if any(is_emoji(char) for char in text) else 0.0,
        1.0 if "!" in text else 0.0,
        1.0 if text[:1].isupper() else 0.0,
        1.0 if letters and letters == letters.lower() else 0.0,
        1.0 if re.search(r"\b(haha+|lol|lmao)\b", text, re.I) else 0.0,
    ]


def plain_features(comments):
    rows = []
    for slot, text in enumerate(comments):
        rows.append([1.0 if slot == other else 0.0 for other in range(5)] + style(text))
    return np.array(rows, dtype=np.float32)


class Featuriser:
    """Turns rounds into tensors. Holds what was learned from the training data (people, style
    scaling), which is saved inside the checkpoint so predictions use exactly the same inputs."""

    def __init__(self, people=None, style_mean=None, style_std=None):
        self.people = list(people or [])
        self.style_mean = np.array(style_mean if style_mean is not None else np.zeros(STYLE_SIZE), dtype=np.float32)
        self.style_std = np.array(style_std if style_std is not None else np.ones(STYLE_SIZE), dtype=np.float32)

    @classmethod
    def fit(cls, rounds):
        people = sorted({item.get("person", "") for item in rounds if item.get("person")})
        styles = np.array([style(text) for item in rounds for text in item["comments"]], dtype=np.float32)
        std = styles.std(axis=0)
        std[std == 0] = 1
        return cls(people, styles.mean(axis=0), std)

    def state(self):
        return {"people": self.people, "style_mean": self.style_mean.tolist(), "style_std": self.style_std.tolist()}

    def person_index(self, person):
        return self.people.index(person) + 1 if person in self.people else 0

    def plain(self, comments):
        rows = plain_features(comments)
        rows[:, 5:] = (rows[:, 5:] - self.style_mean) / self.style_std
        return rows

    def build(self, round_, history):
        """Inputs for one round; history = the rounds before it with a pick, oldest first."""
        texts = list(round_["comments"])
        context = str(round_.get("context") or "")
        recent = history[-config.MEMORY_ROUNDS:]
        memory_texts = [text for past in recent for text in past["comments"]]
        vectors = embed(texts + [context] + memory_texts)
        comments = vectors[:5]
        ctx = np.concatenate([vectors[5], [1.0 if context else 0.0]]).astype(np.float32)
        memory = []
        for position, past in enumerate(recent):
            for slot in range(5):
                vector = vectors[6 + position * 5 + slot]
                flags = [1.0 if slot == past.get("picked") else 0.0, 1.0 if past.get("person") == round_.get("person") else 0.0, (position + 1) / len(recent)]
                memory.append(np.concatenate([vector, flags]))
        memory = np.array(memory, dtype=np.float32).reshape(-1, config.EMBEDDING_DIM + MEMORY_EXTRA)
        return {
            "comments": comments,
            "plain": self.plain(texts),
            "context": ctx,
            "memory": memory,
            "person": self.person_index(round_.get("person")),
            "picked": round_.get("picked"),
        }


def examples_for(rounds, featuriser):
    """One example per picked round, each with the picked rounds before it as memory."""
    examples = []
    history = []
    for item in rounds:
        if item.get("picked") is not None:
            examples.append((item, featuriser.build(item, history)))
            history.append(item)
    return examples


def split(examples):
    """Time-ordered: skip the first MIN_HISTORY (memory only), then train / validation / test."""
    usable = examples[config.MIN_HISTORY:]
    test_count = max(1, round(len(usable) * config.TEST_SHARE))
    rest = usable[: len(usable) - test_count]
    val_count = max(1, round(len(rest) * config.VAL_SHARE))
    return {"train": rest[: len(rest) - val_count], "val": rest[len(rest) - val_count:], "test": usable[len(usable) - test_count:], "all": usable}


def collate(batch, device=None):
    """Pads memory to the longest in the batch; mask marks the padding."""
    longest = max(1, max(item["memory"].shape[0] for item in batch))
    memory = np.zeros((len(batch), longest, config.EMBEDDING_DIM + MEMORY_EXTRA), dtype=np.float32)
    mask = np.ones((len(batch), longest), dtype=bool)
    for index, item in enumerate(batch):
        count = item["memory"].shape[0]
        if count:
            memory[index, :count] = item["memory"]
            mask[index, :count] = False
    tensors = {
        "comments": torch.tensor(np.stack([item["comments"] for item in batch])),
        "plain": torch.tensor(np.stack([item["plain"] for item in batch])),
        "context": torch.tensor(np.stack([item["context"] for item in batch])),
        "memory": torch.tensor(memory),
        "memory_mask": torch.tensor(mask),
        "person": torch.tensor([item["person"] for item in batch], dtype=torch.long),
    }
    if all(item.get("picked") is not None for item in batch):
        tensors["picked"] = torch.tensor([item["picked"] for item in batch], dtype=torch.long)
    if device is not None:
        tensors = {key: value.to(device) for key, value in tensors.items()}
    return tensors
