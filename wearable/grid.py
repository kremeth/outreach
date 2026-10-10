"""Local grids of every post image we have for a profile (post order, row by row).

Gemini bills an image at a fixed ~1,080 tokens however large it is (it scales it down), so packing
many photos into one grid only shrinks them. Instead, all images are split into 3x3 grids (9 per
grid; 12 images -> 2 grids, 48 -> 6), all sent in one request. build_grid() still makes one grid of
the first N images, for comparisons. Each image is fitted inside
its square cell without cropping (a watch or ring at the edge of a photo stays in), on a neutral grey
background, with no labels or borders drawn over anything. Empty cells stay grey. Cached by profile.
"""
import json
from pathlib import Path

from PIL import Image

from . import config


def load_profile(username):
    path = config.PROFILES / f"{username}.json"
    return json.loads(path.read_text()) if path.exists() else None


def post_images(profile, limit=None):
    images = [config.IMAGES_ROOT / post["file"] for post in profile.get("posts", []) if post.get("file")]
    return images[:limit] if limit else images


def layout(count):
    """(columns, rows) for a grid of `count` images."""
    columns = 3 if count <= 9 else 4
    return columns, max(1, -(-count // columns))


def build_grid(username, cell=config.GRID_CELL, rebuild=False, limit=None):
    """Path to the cached grid JPEG, or None if the profile has no images. limit: first N images only."""
    profile = load_profile(username)
    if not profile:
        return None
    images = post_images(profile, limit)
    if not images:
        return None
    config.GRIDS.mkdir(parents=True, exist_ok=True)
    out = config.GRIDS / f"{username}-{cell}-{len(images)}.jpg"
    if out.exists() and not rebuild:
        return out
    columns, rows = layout(len(images))
    grid = Image.new("RGB", (cell * columns, cell * rows), config.GRID_BACKGROUND)
    for index, path in enumerate(images):
        with Image.open(path) as image:
            image = image.convert("RGB")
            image.thumbnail((cell, cell), Image.LANCZOS)  # keeps the aspect ratio, never crops
            x = (index % columns) * cell + (cell - image.width) // 2
            y = (index // columns) * cell + (cell - image.height) // 2
            grid.paste(image, (x, y))
    grid.save(out, "JPEG", quality=90)
    return out


PER_GRID = 9


def build_grids(username, per_grid=PER_GRID, cell=config.GRID_CELL, rebuild=False):
    """All of a profile's images as consecutive 3x3 grids: [(path, first_tile, last_tile), ...]."""
    profile = load_profile(username)
    images = post_images(profile) if profile else []
    grids = []
    for start in range(0, len(images), per_grid):
        chunk = images[start:start + per_grid]
        out = config.GRIDS / f"{username}-{cell}-part{start // per_grid + 1}-{len(chunk)}.jpg"
        if not out.exists() or rebuild:
            config.GRIDS.mkdir(parents=True, exist_ok=True)
            grid = Image.new("RGB", (cell * 3, cell * 3), config.GRID_BACKGROUND)
            for index, path in enumerate(chunk):
                with Image.open(path) as image:
                    image = image.convert("RGB")
                    image.thumbnail((cell, cell), Image.LANCZOS)
                    grid.paste(image, ((index % 3) * cell + (cell - image.width) // 2, (index // 3) * cell + (cell - image.height) // 2))
            grid.save(out, "JPEG", quality=90)
        grids.append((out, start + 1, start + len(chunk)))
    return grids
