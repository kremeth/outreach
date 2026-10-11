"""Tests for the wearable pipeline. No network: Gemini is mocked, images are generated locally.

    .venv/bin/python -m unittest wearable.test_wearable -v
"""
import json
import socket
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def _blocked(*args, **kwargs):
    raise RuntimeError("network access attempted")


socket.socket.connect = _blocked
socket.create_connection = _blocked

from PIL import Image  # noqa: E402

from wearable import config, detect, evaluate, gemini, grid, signals  # noqa: E402


class WearableTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="wearable-test-"))
        self.patches = [
            mock.patch.object(config, "PROFILES", self.tmp / "profiles"),
            mock.patch.object(config, "IMAGES_ROOT", self.tmp),
            mock.patch.object(config, "GRIDS", self.tmp / "grids"),
            mock.patch.object(config, "GEMINI_CACHE", self.tmp / "cache"),
            mock.patch.object(config, "SPEND", self.tmp / "spend.jsonl"),
            mock.patch.object(config, "USAGE_LOG", self.tmp / "usage.jsonl"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()

    def make_profile(self, username, count, bio=""):
        folder = self.tmp / "images" / username
        folder.mkdir(parents=True)
        posts = []
        for index in range(count):
            Image.new("RGB", (300 + index * 10, 600), (index * 20 % 255, 80, 120)).save(folder / f"{index + 1}.jpg")
            posts.append({"index": index + 1, "file": f"images/{username}/{index + 1}.jpg", "caption": ""})
        (self.tmp / "profiles").mkdir(exist_ok=True)
        (self.tmp / "profiles" / f"{username}.json").write_text(json.dumps({"username": username, "status": "ok", "bio": bio, "name": username, "posts": posts}))

    def test_grids_keep_every_image_without_cropping(self):
        self.make_profile("a", 12)
        grids = grid.build_grids("a")
        self.assertEqual([(first, last) for _, first, last in grids], [(1, 9), (10, 12)])
        with Image.open(grids[0][0]) as image:
            self.assertEqual(image.size, (config.GRID_CELL * 3, config.GRID_CELL * 3))
            # A tall image fitted into its cell keeps grey padding at the sides (not cropped).
            self.assertEqual(image.getpixel((2, config.GRID_CELL // 2)), config.GRID_BACKGROUND)

    def test_text_mentions_are_positive_only(self):
        found = signals.mentions({"bio": "Marathoner ⌚️ @garmin athlete", "name": "", "posts": [{"index": 2, "caption": "sleep score from my Oura ring"}]})
        self.assertEqual(set(found), {"Garmin", "Oura"})
        self.assertEqual(signals.mentions({"bio": "runner", "name": "", "posts": []}), {})

    def test_cache_means_never_paying_twice(self):
        self.make_profile("b", 9)
        client = gemini.Gemini(budget=1.0)
        answer = {"description": "Tile 1: left wrist, black Garmin watch", "wearable": "yes", "devices": [{"brand": "Garmin", "tiles": [1], "certainty": "confirmed", "evidence": "tile 1"}]}
        payload = {"candidates": [{"content": {"parts": [{"text": json.dumps(answer)}]}}], "usageMetadata": {"promptTokenCount": 1500, "candidatesTokenCount": 200}}
        with mock.patch.object(gemini, "_post", return_value=payload) as post:
            first = detect.detect("b", client, "gemini-3.1-flash-lite", zoom=False)
            second = detect.detect("b", client, "gemini-3.1-flash-lite", zoom=False)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(first["decision"], "Yes")
        self.assertEqual(second["brands"], ["Garmin"])
        self.assertEqual(client.cache_hits, 1)
        self.assertTrue(config.USAGE_LOG.exists())

    def test_budget_stops_before_overspending(self):
        self.make_profile("c", 9)
        client = gemini.Gemini(budget=0.0001)
        with mock.patch.object(gemini, "_post") as post:
            with self.assertRaises(gemini.BudgetExceeded):
                detect.detect("c", client, "gemini-3.8-flash")
        post.assert_not_called()

    def test_insufficient_evidence_is_unknown_not_no(self):
        self.make_profile("d", 4)
        client = gemini.Gemini(budget=1.0)
        payload = {"candidates": [{"content": {"parts": [{"text": json.dumps({"description": "food photos", "wearable": "insufficient", "devices": []})}]}}], "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 50}}
        with mock.patch.object(gemini, "_post", return_value=payload):
            record = detect.detect("d", client)
        self.assertEqual(record["decision"], "Unknown")

    def test_closer_look_on_every_yes_or_possible(self):
        self.assertTrue(detect.needs_zoom({"wearable": "possible", "devices": [{"brand": "Unknown smartwatch"}]}))
        self.assertTrue(detect.needs_zoom({"wearable": "yes", "devices": [{"brand": "WHOOP", "certainty": "confirmed"}]}))
        self.assertFalse(detect.needs_zoom({"wearable": "no", "devices": []}))

    def _two_step(self, username, first, second):
        self.make_profile(username, 9)
        client = gemini.Gemini(budget=1.0)
        replies = [{"candidates": [{"content": {"parts": [{"text": json.dumps(reply)}]}}], "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 50}} for reply in (first, second)]
        with mock.patch.object(gemini, "_post", side_effect=replies):
            return detect.detect(username, client)

    def test_closer_look_that_finds_nothing_is_unknown_never_no(self):
        first = {"description": "Tile 2: dark band on left wrist", "wearable": "yes", "devices": [{"brand": "Apple Watch", "best_tile": 2, "tiles": [2, 3, 4, 5], "wearer": "owner", "certainty": "probable", "evidence": "tile 2"}]}
        second = {"photos": [{"photo": 2, "seen": "no", "brand": "Unknown smartwatch", "wearer": "unclear", "certainty": "possible", "evidence": "wrist out of frame"}]}
        record = self._two_step("e", first, second)
        self.assertTrue(record["zoomed"])
        self.assertEqual(record["verdict"], "unverified")
        self.assertEqual(record["decision"], "Unknown")

    def test_closer_look_keeps_only_the_photo_it_saw(self):
        first = {"description": "", "wearable": "yes", "devices": [{"brand": "Unknown smartwatch", "best_tile": 7, "tiles": [1, 4, 7], "wearer": "owner", "certainty": "possible", "evidence": "tile 7"}]}
        second = {"photos": [{"photo": 7, "seen": "yes", "brand": "Garmin", "wearer": "owner", "certainty": "confirmed", "evidence": "round watch on left wrist"}]}
        record = self._two_step("f", first, second)
        self.assertEqual(record["decision"], "Yes")
        self.assertEqual(record["brands"], ["Garmin"])
        self.assertEqual(record["devices"][0]["tiles"], [7])

    def test_someone_elses_watch_is_possible_at_most(self):
        first = {"description": "", "wearable": "yes", "devices": [{"brand": "Apple Watch", "best_tile": 3, "tiles": [3], "wearer": "owner", "certainty": "confirmed", "evidence": "tile 3"}]}
        second = {"photos": [{"photo": 3, "seen": "yes", "brand": "Apple Watch", "wearer": "someone else", "certainty": "confirmed", "evidence": "on the friend's wrist"}]}
        record = self._two_step("g", first, second)
        self.assertEqual(record["verdict"], "possible")
        self.assertEqual(record["brands"], [])

    def test_photo_numbers_are_the_profile_order_even_with_a_failed_download(self):
        self.make_profile("h", 6)
        profile_path = self.tmp / "profiles" / "h.json"
        profile = json.loads(profile_path.read_text())
        profile["posts"][2] = {"index": 3, "error": "download failed"}  # photo 3 missing
        profile_path.write_text(json.dumps(profile))
        first = {"notes": "Photo 5: watch", "wearable": "yes", "sightings": [{"photo": 5, "brand": "Garmin", "wearer": "owner", "certainty": "confirmed", "evidence": "Photo 5"}]}
        second = {"photos": [{"photo": 5, "seen": "yes", "brand": "Garmin", "wearer": "owner", "certainty": "confirmed", "evidence": "left wrist"}]}
        replies = [{"candidates": [{"content": {"parts": [{"text": json.dumps(reply)}]}}], "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 50}} for reply in (first, second)]
        client = gemini.Gemini(budget=1.0)
        with mock.patch.object(gemini, "_post", side_effect=replies) as post:
            record = detect.detect_photos("h", client)
        labels = [part["text"] for part in post.call_args_list[0][0][1]["contents"][0]["parts"] if "text" in part][:-1]
        self.assertEqual(labels, ["Photo 1:", "Photo 2:", "Photo 4:", "Photo 5:", "Photo 6:"])
        sent = [part for part in post.call_args_list[1][0][1]["contents"][0]["parts"] if "inline_data" in part]
        self.assertEqual(len(sent), 1)
        import base64
        self.assertEqual(base64.b64decode(sent[0]["inline_data"]["data"]), (self.tmp / "images" / "h" / "5.jpg").read_bytes())
        self.assertEqual(record["decision"], "Yes")
        self.assertEqual(record["devices"][0]["best_tile"], 5)
        self.assertTrue(record["devices"][0]["verified"])

    def test_network_has_two_logits_and_softmax(self):
        import torch
        from wearable.train import SmallNet
        net = SmallNet(384)
        logits = net(torch.randn(10, 384))
        self.assertEqual(tuple(logits.shape), (10, 2))
        self.assertTrue(torch.allclose(torch.softmax(logits, -1).sum(-1), torch.ones(10)))

    def test_class_weights_come_from_the_training_labels(self):
        import numpy as np
        from wearable.train import class_weight
        y = np.array([0] * 90 + [1] * 10)
        self.assertAlmostEqual(class_weight(y, "full")[1].item(), 9.0)
        self.assertAlmostEqual(class_weight(y, "sqrt")[1].item(), 3.0)
        self.assertAlmostEqual(class_weight(y, "none")[1].item(), 1.0)

    def test_weighted_training_and_recall_threshold(self):
        import numpy as np
        from wearable.train import fit, threshold_for
        rng = np.random.default_rng(0)
        x = np.vstack([rng.normal(0, 1, (190, 8)), rng.normal(1.5, 1, (10, 8))]).astype(np.float32)
        y = np.array([0] * 190 + [1] * 10)
        scores = fit(x, y, "net", "full", epochs=60)(x)
        t = threshold_for(scores, y, 0.98)
        self.assertGreaterEqual((scores[y == 1] >= t).mean(), 0.98)
        self.assertGreater(scores[y == 1].mean(), scores[y == 0].mean())

    def test_wilson_interval(self):
        low, high = evaluate.wilson(49, 50)
        self.assertLess(low, 0.95)
        self.assertGreater(high, 0.99)


if __name__ == "__main__":
    unittest.main(verbosity=2)
