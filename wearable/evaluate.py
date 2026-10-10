"""Scores a results file (data/wearable/results/<tag>.jsonl) against the human labels.

    .venv/bin/python -m wearable.evaluate <tag> [<tag> ...]

Binary recall: labelled Yes predicted Yes (screening keeps them). Unknown counts as kept (it is
never written as No), but is reported separately.
Device recall: labelled Yes whose labelled device is among the predicted brands (confirmed or probable,
or named in the bio/captions). Costs are Gemini's own token counts at listed prices; the pilot is
enriched with positives, so cost per 1,000 production profiles is re-weighted to the real prevalence.
"""
import json
import math
import sys

from . import config

PREVALENCE = 167 / 2959  # labelled range: 167 Yes in 2,959 rows
DEVICE_NAME = {"Oura": "Oura", "Garmin": "Garmin", "WHOOP": "WHOOP", "Apple Watch": "Apple Watch", "Polar": "Polar"}


def wilson(successes, total, z=1.96):
    if not total:
        return (0.0, 0.0)
    p = successes / total
    centre = (p + z * z / (2 * total)) / (1 + z * z / total)
    margin = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / (1 + z * z / total)
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def labels():
    return {json.loads(line)["username"]: json.loads(line) for line in config.LABELS.read_text().splitlines() if line.strip()}


def score(tag):
    truth = labels()
    rows = [json.loads(line) for line in (config.RESULTS / f"{tag}.jsonl").read_text().splitlines() if line.strip()]
    rows = [row for row in rows if row["username"] in truth]
    positives = [row for row in rows if truth[row["username"]]["label"] == "Yes"]
    negatives = [row for row in rows if truth[row["username"]]["label"] == "No"]
    kept = lambda row: row["decision"] in ("Yes", "Unknown")
    tp = [row for row in positives if kept(row)]
    fn = [row for row in positives if not kept(row)]
    fp = [row for row in negatives if kept(row)]
    unknown = [row for row in rows if row["decision"] == "Unknown"]
    device_hits = [row for row in positives if DEVICE_NAME.get(truth[row["username"]]["device"]) in row.get("brands", [])]
    per_device = {}
    for row in positives:
        device = truth[row["username"]]["device"]
        entry = per_device.setdefault(device, [0, 0, 0])
        entry[0] += 1
        entry[1] += kept(row)
        entry[2] += DEVICE_NAME.get(device) in row.get("brands", [])
    cost_pos = sum(row.get("cost", 0) for row in positives) / max(1, len(positives))
    cost_neg = sum(row.get("cost", 0) for row in negatives) / max(1, len(negatives))
    per_1000 = 1000 * (PREVALENCE * cost_pos + (1 - PREVALENCE) * cost_neg)
    zoom_share = sum(1 for row in rows if row.get("zoomed")) / max(1, len(rows))
    recall_ci = wilson(len(tp), len(positives))
    device_ci = wilson(len(device_hits), len(positives))
    return {
        "tag": tag,
        "profiles": len(rows),
        "positives": len(positives),
        "negatives": len(negatives),
        "recall": len(tp) / max(1, len(positives)),
        "recall_ci": recall_ci,
        "false_negatives": len(fn),
        "false_positive_rate": len(fp) / max(1, len(negatives)),
        "unknown": len(unknown),
        "device_recall": len(device_hits) / max(1, len(positives)),
        "device_ci": device_ci,
        "per_device": per_device,
        "zoom_share": zoom_share,
        "cost_per_1000": per_1000,
        "calls_per_1000": 1000 * (1 + zoom_share),
        "spent": sum(row.get("cost", 0) for row in rows),
        "missed": [{"username": row["username"], "device": truth[row["username"]]["device"], "verdict": row.get("verdict"), "images": row.get("images"), "description": (row.get("stage1") or {}).get("description", "")[:300]} for row in fn],
    }


def main():
    for tag in sys.argv[1:]:
        result = score(tag)
        low, high = result["recall_ci"]
        dlow, dhigh = result["device_ci"]
        print(f"\n== {tag}: {result['profiles']} profiles ({result['positives']} Yes, {result['negatives']} No)")
        print(f"binary recall {result['recall']:.0%} (95% CI {low:.0%}-{high:.0%}), missed {result['false_negatives']}, false-positive rate {result['false_positive_rate']:.0%}, unknown {result['unknown']}")
        print(f"device recall {result['device_recall']:.0%} (95% CI {dlow:.0%}-{dhigh:.0%}) | per device [n, kept, right brand]: {result['per_device']}")
        print(f"spent ${result['spent']:.3f} | closer looks {result['zoom_share']:.0%} | ~${result['cost_per_1000']:.2f} per 1,000 production profiles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
