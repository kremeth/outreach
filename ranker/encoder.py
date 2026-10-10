"""Sentence-BERT embeddings, computed locally and cached on disk (SQLite)."""
import hashlib
import sqlite3
import threading
from pathlib import Path

import numpy as np

from . import config

_model = None
_lock = threading.Lock()


def load_encoder(path=None):
    """The encoder from the local directory only (never downloads)."""
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        directory = Path(path or config.ENCODER_DIR)
        if not (directory / "config.json").exists():
            raise FileNotFoundError(f"No Sentence-BERT model in {directory}. Run: .venv/bin/python -m ranker.setup_models")
        _model = SentenceTransformer(str(directory), device="cpu", local_files_only=True)
    return _model


class EmbeddingCache:
    """text -> float32 vector, keyed by a hash of the text, stored in a local SQLite file."""

    def __init__(self, path=None):
        self.path = Path(path or config.EMBEDDING_CACHE)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector BLOB)")

    @staticmethod
    def key(text):
        return hashlib.sha1(text.encode("utf-8")).hexdigest()

    def get_many(self, texts):
        found = {}
        keys = [self.key(text) for text in texts]
        for start in range(0, len(keys), 500):
            chunk = keys[start:start + 500]
            rows = self.db.execute(f"SELECT key, vector FROM embeddings WHERE key IN ({','.join('?' * len(chunk))})", chunk)
            for key, blob in rows:
                found[key] = np.frombuffer(blob, dtype=np.float32)
        return found

    def put_many(self, items):
        self.db.executemany("INSERT OR REPLACE INTO embeddings (key, vector) VALUES (?, ?)", [(self.key(text), vector.astype(np.float32).tobytes()) for text, vector in items])
        self.db.commit()


_cache = None


def embed(texts, cache=None):
    """Normalised embeddings for texts (empty strings get zeros), using and filling the local cache."""
    global _cache
    cache = cache or _cache or EmbeddingCache()
    _cache = _cache or cache
    texts = [str(text or "") for text in texts]
    with _lock:
        known = cache.get_many([text for text in texts if text])
        missing = sorted({text for text in texts if text and EmbeddingCache.key(text) not in known})
        if missing:
            vectors = load_encoder().encode(missing, batch_size=64, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False)
            cache.put_many(zip(missing, vectors))
            for text, vector in zip(missing, vectors):
                known[EmbeddingCache.key(text)] = vector.astype(np.float32)
    out = np.zeros((len(texts), config.EMBEDDING_DIM), dtype=np.float32)
    for index, text in enumerate(texts):
        if text:
            out[index] = known[EmbeddingCache.key(text)]
    return out
