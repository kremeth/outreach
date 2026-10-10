"""Local paths and settings for the comment ranker.

Importing this module switches Hugging Face, Transformers and tokenizers to offline mode and turns
telemetry off, so nothing in the ranking pipeline can reach the network. Only setup_models.py, run
once, downloads the Sentence-BERT weights (it lifts offline mode for itself before importing this).

Every path can be overridden with an environment variable.
"""
import os
from pathlib import Path

OFFLINE_ENV = {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
    "DO_NOT_TRACK": "1",
    "TOKENIZERS_PARALLELISM": "false",
}
for _key, _value in OFFLINE_ENV.items():
    os.environ.setdefault(_key, _value)

ROOT = Path(os.environ.get("RANKER_ROOT", Path(__file__).resolve().parent.parent))

# Sentence-BERT encoder: downloaded once by setup_models.py, then only ever loaded from disk.
ENCODER_NAME = "sentence-transformers/all-MiniLM-L6-v2"
ENCODER_DIR = Path(os.environ.get("RANKER_ENCODER_DIR", ROOT / "models" / "sentence_encoder"))
EMBEDDING_DIM = 384

# Data, cache, checkpoints, metrics and logs: all on the local filesystem.
DATA_DIR = Path(os.environ.get("RANKER_DATA_DIR", ROOT / "data" / "ranker"))
DATASET_PATH = Path(os.environ.get("RANKER_DATASET", DATA_DIR / "dataset.jsonl"))
EMBEDDING_CACHE = DATA_DIR / "embeddings.sqlite"
CHECKPOINT_DIR = DATA_DIR / "checkpoints"
CHECKPOINT_PATH = CHECKPOINT_DIR / "ranker.pt"  # trained on every round, used for predictions
EVAL_CHECKPOINT_PATH = CHECKPOINT_DIR / "ranker-eval.pt"  # trained on the training split only
METRICS_PATH = DATA_DIR / "metrics.json"
HISTORY_PATH = DATA_DIR / "metrics-history.jsonl"
LOG_PATH = DATA_DIR / "ranker.log"

# Data split, time-ordered: oldest rounds train, then validation (early stopping), newest test.
MIN_HISTORY = 25  # the first rounds only serve as memory for later ones
TEST_SHARE = 0.2
VAL_SHARE = 0.2
MEMORY_ROUNDS = 12  # earlier rounds each round's comments can look back at

# Network and training.
MODEL = {"d": 32, "heads": 2, "self_blocks": 2, "cross_blocks": 2, "dropout": 0.3}
TRAIN = {"lr": 2e-3, "weight_decay": 0.05, "batch_size": 16, "max_epochs": 150, "patience": 25, "seeds": 3}


def device():
    """CUDA or Apple Silicon (MPS) for training when available, otherwise CPU."""
    import torch

    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")
