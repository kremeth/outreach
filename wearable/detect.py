"""Approach A: direct Gemini detection on local 3x3 grids of every post image, with a conditional
closer look.

Stage 1: one structured request with all the profile's grids (description + verdict + devices).
Stage 2 (only when it can change the answer): the original photos of the tiles Gemini pointed at,
at full resolution, to confirm a "possible" or name an unbranded device.

Decision (screening): "yes" or "possible" -> Yes (kept for outreach); "no" -> No; "insufficient"
(no wrists, hands or people visible enough to tell) -> Unknown, never No.
"""
import json

from . import config, signals
from .gemini import Gemini
from .grid import build_grid, build_grids, load_profile, post_images

PROMPT_VERSION = "grids-v3"
DEVICE_ENUM = config.BRANDS + config.GENERIC

SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "description": {"type": "STRING"},
        "wearable": {"type": "STRING", "enum": ["yes", "possible", "no", "insufficient"]},
        "devices": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "brand": {"type": "STRING", "enum": DEVICE_ENUM},
                    "tiles": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    "certainty": {"type": "STRING", "enum": ["confirmed", "probable", "possible"]},
                    "evidence": {"type": "STRING"},
                },
                "required": ["brand", "tiles", "certainty", "evidence"],
            },
        },
    },
    "required": ["description", "wearable", "devices"],
}

PROMPT = """{layout}""" + """

Task: find fitness wearables: smartwatches and sports watches (Apple Watch, Garmin, Polar and others), screenless fitness bands (WHOOP, worn on the wrist or upper arm), and smart rings (Oura and others).

Inspect every tile closely: every wrist, forearm, upper arm, hand and finger, including small, blurry, background and partly hidden ones, and any device held or lying in view.

description: plain facts per tile, e.g. "Tile 3: woman running, left wrist bare, right wrist out of frame". Mention every visible wrist, upper arm and hand and what is on it. No conclusions in this field.

wearable:
- "yes": a smartwatch, fitness band or smart ring is clearly visible in at least one tile.
- "possible": something could be one but you cannot be sure (e.g. a dark band on a wrist, a thick ring).
- "no": people's wrists and hands are visible and none wears one.
- "insufficient": no people, or wrists and hands are not visible enough to tell.
Being athletic, running or being in a gym is NOT evidence. Ordinary bracelets, bangles, jewellery rings and analogue dress watches without a screen do not count.

devices: one entry per device seen. Name a brand only from visual evidence:
- Apple Watch: rectangular face with rounded corners, digital crown and side button.
- Garmin: round face, usually five side buttons, sometimes GARMIN text on the bezel.
- WHOOP: screenless fabric or knit band with a small sensor pod, on the wrist or upper arm.
- Polar: round sports watch, Polar logo.
- Oura: thick, smooth, rounded ring (matte black, silver, gold), often on the index or ring finger.
Otherwise use "Unknown smartwatch", "Unknown fitness band" or "Unknown smart ring" (or "Other brand" if another brand is identifiable).
certainty: "confirmed" when the brand is clear, "probable" when the shape strongly suggests it, "possible" when unsure.
evidence: tile number and where, e.g. "tile 5, left wrist of the woman holding coffee"."""

ZOOM_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "devices": SCHEMA["properties"]["devices"],
        "wearable": SCHEMA["properties"]["wearable"],
    },
    "required": ["devices", "wearable"],
}

ZOOM_PROMPT = """These are full-resolution photos from one Instagram creator (photo numbers given before each). A first look at a small grid suggested a possible fitness wearable in them.
Look closely at every wrist, upper arm and finger. Report each smartwatch, fitness band or smart ring you can see, with the brand only if the visual evidence supports it (Apple Watch: rectangular, rounded corners, digital crown; Garmin: round with side buttons; WHOOP: screenless band with sensor pod; Polar: round sports watch, Polar logo; Oura: thick smooth rounded ring). Otherwise use the Unknown types.
wearable: "yes" if one is clearly visible, "possible" if still unsure, "no" if the suspected object is not a wearable, "insufficient" if it cannot be seen."""


def layout_text(grids):
    """How the tiles are numbered across the grid images."""
    total = grids[-1][2]
    if len(grids) == 1:
        return f"This image is a 3x3 grid of one Instagram creator's latest posts. Tiles are numbered 1-{total}, left to right, top to bottom."
    parts = ", ".join(f"image {n} holds tiles {first}-{last}" for n, (_, first, last) in enumerate(grids, 1))
    return f"These {len(grids)} images are 3x3 grids of one Instagram creator's latest posts ({total} photos): {parts}. Within each grid, tiles go left to right, top to bottom."


def _strong(devices):
    return [d for d in devices if d.get("certainty") in ("confirmed", "probable")]


def needs_zoom(answer):
    """The closer look is only worth paying for when it can change the outcome."""
    if answer.get("wearable") == "possible":
        return True
    if answer.get("wearable") == "yes":
        devices = answer.get("devices", [])
        return not any(d["brand"] in config.BRANDS for d in _strong(devices))
    return False


def detect(username, gemini, model="gemini-3.1-flash-lite", zoom=True, zoom_model=None, per_grid=9, limit=None):
    profile = load_profile(username)
    if not profile or profile.get("status") != "ok":
        return {"username": username, "decision": "Unknown", "status": (profile or {}).get("status", "not acquired"), "devices": [], "cost": 0.0}
    text = signals.mentions(profile)
    grids = build_grids(username, per_grid=per_grid) if per_grid else [(build_grid(username, limit=limit), 1, min(limit or 99, len(post_images(profile))))]
    if limit and per_grid:
        grids = [g for g in grids if g[1] <= limit]
    count = grids[-1][2]
    first = gemini.generate(model, PROMPT_VERSION, [path.read_bytes() for path, _, _ in grids], PROMPT.format(layout=layout_text(grids)), SCHEMA, max_output_tokens=1200 + 150 * (len(grids) - 1))
    answer = first.get("answer", {})
    record = {
        "username": username,
        "status": "ok",
        "model": model,
        "images": count,
        "grids": len(grids),
        "stage1": answer,
        "text_mentions": text,
        "cost": first.get("usd", 0.0),
        "tokens": [first.get("input_tokens", 0), first.get("output_tokens", 0)],
        "zoomed": False,
    }
    final = answer
    if zoom and "_unparsed" not in answer and needs_zoom(answer):
        tiles = sorted({tile for device in answer.get("devices", []) for tile in device.get("tiles", []) if 1 <= tile <= count}) or list(range(1, count + 1))
        paths = post_images(profile)
        chosen = [(tile, paths[tile - 1]) for tile in tiles if tile - 1 < len(paths)][:4]
        if chosen:
            listing = "\n".join(f"Photo {tile} follows." for tile, _ in chosen)
            second = gemini.generate(zoom_model or model, "zoom-v1", [path.read_bytes() for _, path in chosen], f"{ZOOM_PROMPT}\n{listing}", ZOOM_SCHEMA, max_output_tokens=700)
            record["zoomed"] = True
            record["stage2"] = second.get("answer", {})
            record["cost"] += second.get("usd", 0.0)
            if "_unparsed" not in record["stage2"]:
                # The closer look can only add certainty or a brand; it never vetoes the first pass
                # (a missed wearable user costs far more than an extra check).
                rank = {"no": 0, "insufficient": 1, "possible": 2, "yes": 3}
                verdicts = [answer.get("wearable", "insufficient"), record["stage2"].get("wearable", "insufficient")]
                final = {**answer, "wearable": max(verdicts, key=lambda v: rank.get(v, 1)), "devices": answer.get("devices", []) + record["stage2"].get("devices", [])}
    devices = final.get("devices", [])
    verdict = final.get("wearable", "insufficient")
    brands = sorted({d["brand"] for d in _strong(devices) if d["brand"] in config.BRANDS} | set(text))
    record.update({
        "verdict": verdict,
        "decision": "Yes" if verdict in ("yes", "possible") or text else ("No" if verdict == "no" else "Unknown"),
        "brands": brands,
        "possible_brands": sorted({d["brand"] for d in devices if d["brand"] in config.BRANDS} | set(text)),
        "devices": devices,
    })
    return record


def run(usernames, model="gemini-3.1-flash-lite", budget=config.DEFAULT_BUDGET, zoom=True, tag=None, zoom_model=None, per_grid=9, limit=None):
    """Runs detection over usernames, appending results to data/wearable/results/<tag>.jsonl (resumable)."""
    tag = tag or f"A-{model}"
    gemini = Gemini(budget=budget, run=tag, purpose=f"wearable detection ({model})")
    config.RESULTS.mkdir(parents=True, exist_ok=True)
    out = config.RESULTS / f"{tag}.jsonl"
    done = {json.loads(line)["username"] for line in out.read_text().splitlines() if line.strip()} if out.exists() else set()
    for username in usernames:
        if username in done:
            continue
        record = detect(username, gemini, model, zoom=zoom, zoom_model=zoom_model, per_grid=per_grid, limit=limit)
        with open(out, "a") as handle:
            handle.write(json.dumps(record) + "\n")
    return {"spent": gemini.spent, "calls": gemini.calls, "cache_hits": gemini.cache_hits, "file": str(out)}
