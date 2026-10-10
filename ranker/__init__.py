"""Local comment ranker: which of five comments gets picked, with Sentence-BERT and an attention
network, entirely on this computer.

    from ranker import predict_comments
    predict_comments(["...", "...", "...", "...", "..."])
"""
from . import config  # noqa: F401  (switches Hugging Face to offline mode first)
from .predict import predict_comments

__all__ = ["predict_comments"]
