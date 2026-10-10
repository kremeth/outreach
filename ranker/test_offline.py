"""Offline verification of the ranker: every network connection is blocked for the whole run.

    .venv/bin/python -m unittest ranker.test_offline -v

1. The Sentence-BERT encoder loads from the local directory only.
2. Training smoke test: a real optimizer step changes the weights; the model is evaluated; a
   checkpoint is saved and loaded back.
3. Inference: five comments -> embeddings -> scores -> softmax summing to 1 (percentages to 100)
   -> the winning comment. Also with the real trained checkpoint, if there is one.
Anything that tries to open a connection (including a DNS lookup) fails the test.
"""
import json
import math
import random
import socket
import tempfile
import unittest
from pathlib import Path

# ---- block the network before anything else is imported ----


class NetworkBlocked(RuntimeError):
    pass


def _blocked(*args, **kwargs):
    raise NetworkBlocked(f"network access attempted: {args[:2]}")


socket.socket.connect = _blocked
socket.socket.connect_ex = _blocked
socket.create_connection = _blocked
socket.getaddrinfo = _blocked

import torch  # noqa: E402

from ranker import config  # noqa: E402
from ranker import encoder  # noqa: E402
from ranker.data import Featuriser, collate, examples_for, load_rounds, split  # noqa: E402
from ranker.predict import predict_comments  # noqa: E402
from ranker.train import load_checkpoint, metrics, save_checkpoint, train_one  # noqa: E402

COMMENTS = ["What a team 👏", "The fit 🔥🔥🔥", "that kayak leg looked freezing", "Massive effort, well deserved!!", "haha the dog in the back seat 😂"]


def synthetic_rounds(count=60, seed=7):
    """Rounds with five made-up comments; person A leans to short comments, so there is a pattern."""
    rng = random.Random(seed)
    words = ["sunset", "team", "run", "squad", "views", "effort", "coffee", "dog", "race", "beach", "legs", "crew"]
    rounds = []
    for index in range(count):
        comments = [" ".join(rng.choice(words) for _ in range(rng.randint(1, 7))) + rng.choice(["", " 🔥", "!!", " 😂"]) for _ in range(5)]
        person = "A" if index % 3 else "B"
        picked = min(range(5), key=lambda i: len(comments[i])) if person == "A" else rng.randrange(5)
        rounds.append({"key": str(index), "time": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}Z", "person": person, "comments": comments, "picked": picked, "outcome": "picked", "context": f"post {rng.choice(words)}"})
    return rounds


class OfflineRankerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="ranker-test-"))
        encoder._cache = encoder.EmbeddingCache(cls.tmp / "embeddings.sqlite")  # keep test vectors apart
        cls.dataset = cls.tmp / "dataset.jsonl"
        cls.dataset.write_text("\n".join(json.dumps(item) for item in synthetic_rounds()) + "\n")

    def test_0_network_is_blocked(self):
        with self.assertRaises(NetworkBlocked):
            socket.create_connection(("huggingface.co", 443), timeout=2)

    def test_1_encoder_loads_from_local_directory(self):
        model = encoder.load_encoder()
        self.assertTrue((config.ENCODER_DIR / "config.json").exists())
        vectors = encoder.embed(COMMENTS[:2])
        self.assertEqual(vectors.shape, (2, config.EMBEDDING_DIM))
        self.assertAlmostEqual(float((vectors[0] ** 2).sum()), 1.0, places=4)
        self.assertIsNotNone(model)

    def test_2_training_smoke(self):
        rounds = load_rounds(self.dataset)
        featuriser = Featuriser.fit(rounds)
        parts = split(examples_for(rounds, featuriser))
        train_items = [features for _, features in parts["train"]]
        people = len(featuriser.people)

        # One explicit optimizer step changes the weights and gives a finite loss.
        from ranker.model import CommentRanker

        torch.manual_seed(0)
        model = CommentRanker(people=people, **config.MODEL)
        optimiser = torch.optim.AdamW(model.parameters(), lr=1e-2)
        before = [parameter.detach().clone() for parameter in model.parameters()]
        inputs = collate(train_items[:8])
        loss = torch.nn.functional.cross_entropy(model(**{k: v for k, v in inputs.items() if k != "picked"}), inputs["picked"])
        optimiser.zero_grad()
        loss.backward()
        optimiser.step()
        self.assertTrue(math.isfinite(loss.item()))
        self.assertTrue(any(not torch.equal(a, b) for a, b in zip(before, model.parameters())))

        # A short training run with early stopping, evaluated on validation and test.
        trained, epoch, val_loss = train_one(train_items, [f for _, f in parts["val"]], people, seed=0, device=torch.device("cpu"), max_epochs=3, patience=3)
        result = metrics([trained], parts["test"])
        self.assertTrue(math.isfinite(result["logLoss"]))
        self.assertGreaterEqual(epoch, 0)

        # Checkpoint saved and loaded back with identical outputs.
        path = self.tmp / "checkpoints" / "ranker.pt"
        save_checkpoint(path, [trained], featuriser, people, {"trained_at": "test"})
        models, loaded_featuriser, _ = load_checkpoint(path)
        sample = collate([parts["test"][0][1]])
        sample.pop("picked", None)
        trained.eval()
        with torch.no_grad():
            self.assertTrue(torch.allclose(trained(**sample), models[0](**sample), atol=1e-6))
        self.assertEqual(loaded_featuriser.people, featuriser.people)
        type(self).checkpoint = path

    def test_3_offline_inference(self):
        if not hasattr(type(self), "checkpoint"):
            self.test_2_training_smoke()
        result = predict_comments(COMMENTS, context="Five friends at sunset", person="A", history=[], checkpoint=type(self).checkpoint)
        self.assertEqual(len(result["probabilities"]), 5)
        self.assertAlmostEqual(sum(result["probabilities"]), 1.0, places=6)
        self.assertEqual(sum(result["percentages"]), 100)
        self.assertIn(result["best_comment"], COMMENTS)
        self.assertEqual(result["best_comment"], COMMENTS[result["best_index"]])
        print(f"\n  winner: {result['best_comment']!r} {result['percentages']}")

    def test_4_real_checkpoint_offline(self):
        if not config.CHECKPOINT_PATH.exists():
            self.skipTest("no trained checkpoint yet")
        result = predict_comments(COMMENTS, context="Five friends at sunset")
        self.assertAlmostEqual(sum(result["probabilities"]), 1.0, places=6)
        self.assertEqual(sum(result["percentages"]), 100)
        print(f"\n  real model winner: {result['best_comment']!r} {result['percentages']}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
