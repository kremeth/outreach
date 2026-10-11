"""Approach A: direct Gemini detection on local 3x3 grids of every post image, with a closer look.

Stage 1: one structured request with all the profile's grids (description + verdict + devices, each
device with the one tile where it is clearest and whether the account owner wears it).
Stage 2 (closer look, on every yes or possible): each device's best photo at full resolution,
labelled with its number, to check the device is really there, worn by the account owner, and to
name the brand. Grids are small, and on big profiles the first look tends to repeat one sentence for
every photo of the person (tezuharrison: 30 photos cited, no watch in any of them).

Decision (screening): "yes" or "possible" -> Yes (kept for outreach); "no" -> No; "insufficient"
(no wrists, hands or people visible enough to tell) -> Unknown, never No. A first-look yes that the
closer look cannot find on the photos it pointed at is "unverified" -> Unknown: still kept (never
No), but not shown as a Yes. A device worn only by someone else, or by someone it cannot tell, is
"possible" at most.
"""
import json

from . import config, signals
from .gemini import Gemini
from .grid import build_grid, build_grids, load_profile, post_images

PROMPT_VERSION = "grids-v4"
ZOOM_VERSION = "verify-v1"
DEVICE_ENUM = config.BRANDS + config.GENERIC
CERTAINTY = ["confirmed", "probable", "possible"]
WEARER = ["owner", "someone else", "unclear"]

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
                    "best_tile": {"type": "INTEGER"},
                    "tiles": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    "wearer": {"type": "STRING", "enum": WEARER},
                    "certainty": {"type": "STRING", "enum": CERTAINTY},
                    "evidence": {"type": "STRING"},
                },
                "required": ["brand", "best_tile", "tiles", "wearer", "certainty", "evidence"],
            },
        },
    },
    "required": ["description", "wearable", "devices"],
}

PROMPT = """{layout}""" + """

Task: find fitness wearables worn by the account owner: smartwatches and sports watches (Apple Watch, Garmin, Polar and others), screenless fitness bands (WHOOP, worn on the wrist or upper arm), and smart rings (Oura and others).

Inspect every tile closely: every wrist, forearm, upper arm, hand and finger, including small, blurry, background and partly hidden ones, and any device held or lying in view.

description: plain facts per tile, e.g. "Tile 3: woman running, left wrist bare, right wrist out of frame". Mention every visible wrist, upper arm and hand and what is on it. No conclusions in this field.

wearable:
- "yes": the account owner clearly wears a smartwatch, fitness band or smart ring in at least one tile.
- "possible": something could be one but you cannot be sure (e.g. a dark band on a wrist, a thick ring), or you cannot tell whether the person wearing it is the owner.
- "no": people's wrists and hands are visible and the owner wears none.
- "insufficient": no people, or wrists and hands are not visible enough to tell.
Only the account owner counts: the person who appears most often, in selfies or as the main subject. A device worn only by someone else (a friend, partner, child, bystander) does not make it "yes".
Being athletic, running or being in a gym is NOT evidence. Ordinary bracelets, bangles, jewellery rings and analogue dress watches without a screen do not count.

devices: one entry per device seen. Name a brand only from visual evidence:
- Apple Watch: rectangular face with rounded corners, digital crown and side button.
- Garmin: round face, usually five side buttons, sometimes GARMIN text on the bezel.
- WHOOP: screenless fabric or knit band with a small sensor pod, on the wrist or upper arm.
- Polar: round sports watch, Polar logo.
- Oura: thick, smooth, rounded ring (matte black, silver, gold), often on the index or ring finger.
Otherwise use "Unknown smartwatch", "Unknown fitness band" or "Unknown smart ring" (or "Other brand" if another brand is identifiable).
best_tile: the single tile where this device is most clearly visible.
tiles: only tiles where you can actually see this device. Never list a tile just because the same person is in it.
wearer: "owner" if the account owner wears it, "someone else", or "unclear".
certainty: "confirmed" when the brand is clear, "probable" when the shape strongly suggests it, "possible" when unsure.
evidence: one sentence about best_tile only, e.g. "Tile 5: black round watch with side buttons on the owner's left wrist while holding coffee"."""

ZOOM_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "photos": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "photo": {"type": "INTEGER"},
                    "seen": {"type": "STRING", "enum": ["yes", "possible", "no"]},
                    "brand": {"type": "STRING", "enum": DEVICE_ENUM},
                    "wearer": {"type": "STRING", "enum": WEARER},
                    "certainty": {"type": "STRING", "enum": CERTAINTY},
                    "evidence": {"type": "STRING"},
                },
                "required": ["photo", "seen", "brand", "wearer", "certainty", "evidence"],
            },
        },
    },
    "required": ["photos"],
}

ZOOM_PROMPT = """These are full-resolution photos from one Instagram creator. Each photo is preceded by its number and what a quick look at a small thumbnail thought it showed: a fitness wearable (a smartwatch or sports watch, a screenless fitness band like WHOOP, or a smart ring like Oura). Thumbnails are often wrong, so check each photo yourself.
For each photo, look closely at every wrist, upper arm and finger and answer:
seen: "yes" if a smartwatch, fitness band or smart ring is clearly visible, "possible" if something could be one but you cannot be sure, "no" if there is none (bare wrists, wrists out of frame, an ordinary bracelet, or an analogue dress watch without a screen).
brand: from visual evidence only (Apple Watch: rectangular, rounded corners, digital crown; Garmin: round with side buttons; WHOOP: screenless band with sensor pod; Polar: round sports watch, Polar logo; Oura: thick smooth rounded ring), otherwise an Unknown type.
wearer: "owner" if it is worn by the account owner (the main subject, the person in selfies), "someone else", or "unclear".
certainty: "confirmed" when the brand is clear, "probable" when the shape strongly suggests it, "possible" when unsure.
evidence: one sentence on where the device is in that photo, or why there is none."""


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
    """Every yes or possible gets the closer look: it checks the photo is real, not just the brand."""
    return answer.get("wearable") in ("yes", "possible") and bool(answer.get("devices"))


def best_tile(device, count):
    tile = device.get("best_tile")
    if isinstance(tile, int) and 1 <= tile <= count:
        return tile
    return next((t for t in device.get("tiles", []) if isinstance(t, int) and 1 <= t <= count), None)


def verify(profile, answer, count, gemini, model, record):
    """The closer look: each device's best photo at full resolution. Returns the final answer."""
    # Photo n is the profile's n-th photo (data/wearable/images/<user>/<n>.jpg), whatever failed to download.
    files = {post["index"]: config.IMAGES_ROOT / post["file"] for post in profile.get("posts", []) if post.get("file")}
    rank = {"confirmed": 0, "probable": 1, "possible": 2}
    chosen = []
    for device in sorted(answer.get("devices", []), key=lambda d: rank.get(d.get("certainty"), 3)):
        tile = best_tile(device, count)
        if tile and tile in files and tile not in [t for t, _ in chosen]:
            chosen.append((tile, device))
    chosen = chosen[:4]
    if not chosen:
        return {**answer, "wearable": "possible"}
    labels = [f"Photo {tile} (thumbnail guess: {device.get('brand')}; {str(device.get('evidence', ''))[:160]}):" for tile, device in chosen]
    second = gemini.generate(model, ZOOM_VERSION, [files[tile].read_bytes() for tile, _ in chosen], ZOOM_PROMPT, ZOOM_SCHEMA, max_output_tokens=2000, labels=labels)
    record["zoomed"] = True
    record["stage2"] = second.get("answer", {})
    record["cost"] += second.get("usd", 0.0)
    if "_unparsed" in record["stage2"]:
        return answer
    checked = {item.get("photo"): item for item in record["stage2"].get("photos", [])}
    if len(chosen) == 1 and len(checked) == 1:
        checked = {chosen[0][0]: next(iter(checked.values()))}  # one photo: whatever number it gave
    found = []
    for tile, device in chosen:
        item = checked.get(tile)
        if not item or item.get("seen") not in ("yes", "possible"):
            continue
        certainty = item.get("certainty", "possible") if item.get("seen") == "yes" else "possible"
        if item.get("wearer") != "owner":
            certainty = "possible"  # someone else's device, or cannot tell whose
        found.append({
            "brand": item.get("brand") or device.get("brand"),
            "best_tile": tile,
            "tiles": [tile],
            "wearer": item.get("wearer"),
            "certainty": certainty,
            "evidence": item.get("evidence", ""),
            "verified": True,
        })
    if not found:
        # The first look pointed at photos where the closer look sees nothing: kept (never No), unverified.
        return {**answer, "wearable": "unverified", "devices": [{**d, "certainty": "possible"} for d in answer.get("devices", [])]}
    return {**answer, "wearable": "yes" if any(d["certainty"] != "possible" for d in found) else "possible", "devices": found}


PHOTOS_VERSION = "photos-v1"

PHOTOS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "notes": {"type": "STRING"},
        "wearable": {"type": "STRING", "enum": ["yes", "possible", "no", "insufficient"]},
        "sightings": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "photo": {"type": "INTEGER"},
                    "brand": {"type": "STRING", "enum": DEVICE_ENUM},
                    "wearer": {"type": "STRING", "enum": WEARER},
                    "certainty": {"type": "STRING", "enum": CERTAINTY},
                    "evidence": {"type": "STRING"},
                },
                "required": ["photo", "brand", "wearer", "certainty", "evidence"],
            },
        },
    },
    "required": ["notes", "wearable", "sightings"],
}

PHOTOS_PROMPT = """Above are all {count} photos from one Instagram creator's profile, in the order they appear on the profile (carousel slides included). Each photo comes right after its own label, "Photo n:". These are exactly the photos a person reviewing this creator looks at.

Task: find fitness wearables worn by the account owner: smartwatches and sports watches (Apple Watch, Garmin, Polar and others), screenless fitness bands (WHOOP, worn on the wrist or upper arm), and smart rings (Oura and others).

Inspect every photo closely: every wrist, forearm, upper arm, hand and finger, including small, blurry, background, mirror-selfie and partly hidden ones.

notes: short facts, only for photos where a wrist, upper arm or hand is visible, e.g. "Photo 3: left wrist bare. Photo 7: mirror selfie, white band on left wrist". Use the label numbers exactly.

wearable:
- "yes": the account owner clearly wears a smartwatch, fitness band or smart ring in at least one photo.
- "possible": something could be one but you cannot be sure (e.g. a dark band on a wrist, a thick ring), or you cannot tell whether the person wearing it is the owner.
- "no": people's wrists and hands are visible and the owner wears none.
- "insufficient": no people, or wrists and hands are not visible enough to tell.
Only the account owner counts: the person who appears most often, in selfies or as the main subject. A device worn only by someone else does not make it "yes".
Being athletic, running or being in a gym is NOT evidence. Ordinary bracelets, bangles, jewellery rings and analogue dress watches without a screen do not count.

sightings: one entry per photo in which you can actually see a device (the same device in several photos: one entry each, at most 8 entries, clearest first). photo is the number from that photo's label. Never list a photo you did not see the device in.
brand from visual evidence only:
- Apple Watch: rectangular face with rounded corners, digital crown and side button.
- Garmin: round face, usually five side buttons, sometimes GARMIN text on the bezel.
- WHOOP: screenless fabric or knit band with a small sensor pod, on the wrist or upper arm.
- Polar: round sports watch, Polar logo.
- Oura: thick, smooth, rounded ring (matte black, silver, gold), often on the index or ring finger.
Otherwise "Unknown smartwatch", "Unknown fitness band" or "Unknown smart ring" (or "Other brand" if another brand is identifiable).
wearer: "owner", "someone else" or "unclear".
certainty: "confirmed" when the brand is clear, "probable" when the shape strongly suggests it, "possible" when unsure.
evidence: one sentence about that photo, e.g. "Mirror selfie, white Apple Watch on her left wrist holding the phone"."""


def detect_photos(username, gemini, model="gemini-3.1-flash-lite", zoom_model="gemini-3.8-flash"):
    """Every profile photo sent on its own, labelled with its number (the numbers are the profile's
    photo order, the same as on the Prospecting screen and in data/wearable/images/<user>/<n>.jpg);
    then the closer look checks the photos it named at full size. Only checked photos are evidence."""
    profile = load_profile(username)
    if not profile or profile.get("status") != "ok":
        return {"username": username, "decision": "Unknown", "status": (profile or {}).get("status", "not acquired"), "devices": [], "cost": 0.0, "prompt": PHOTOS_VERSION}
    text = signals.mentions(profile)
    photos = [(post["index"], config.IMAGES_ROOT / post["file"]) for post in profile.get("posts", []) if post.get("file")]
    numbers = {n for n, _ in photos}
    first = gemini.generate(
        model, PHOTOS_VERSION, [path.read_bytes() for _, path in photos], PHOTOS_PROMPT.format(count=len(photos)), PHOTOS_SCHEMA,
        max_output_tokens=2500, media_resolution="MEDIA_RESOLUTION_LOW", labels=[f"Photo {n}:" for n, _ in photos],
    )
    answer = first.get("answer", {})
    record = {
        "username": username,
        "status": "ok",
        "prompt": PHOTOS_VERSION,
        "model": model,
        "images": len(photos),
        "stage1": answer,
        "text_mentions": text,
        "cost": first.get("usd", 0.0),
        "tokens": [first.get("input_tokens", 0), first.get("output_tokens", 0)],
        "zoomed": False,
    }
    sightings = [s for s in answer.get("sightings", []) if s.get("photo") in numbers] if "_unparsed" not in answer else []
    final = answer
    if answer.get("wearable") in ("yes", "possible") and sightings:
        devices = [{**s, "best_tile": s["photo"], "tiles": [s["photo"]]} for s in sightings]
        final = verify(profile, {**answer, "devices": devices}, max(numbers), gemini, zoom_model, record)
    elif answer.get("wearable") in ("yes", "possible"):
        final = {**answer, "wearable": "possible"}
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


def detect(username, gemini, model="gemini-3.1-flash-lite", zoom=True, zoom_model=None, per_grid=9, limit=None):
    profile = load_profile(username)
    if not profile or profile.get("status") != "ok":
        return {"username": username, "decision": "Unknown", "status": (profile or {}).get("status", "not acquired"), "devices": [], "cost": 0.0, "prompt": PROMPT_VERSION}
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
        "prompt": PROMPT_VERSION,
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
        final = verify(profile, answer, count, gemini, zoom_model or model, record)
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
