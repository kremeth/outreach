"""A long-running local worker for Outreach: JSON lines over stdin/stdout (no sockets, no network).

    request:  {"id": 1, "comments": [5 strings], "context": "...", "person": "..."}
    response: {"id": 1, "probabilities": [...], "percentages": [...], "best_index": 2, "best_comment": "..."}
              or {"id": 1, "error": "..."}

The encoder and the checkpoint stay loaded; a retrained checkpoint is picked up automatically.
"""
import json
import sys

from . import config  # noqa: F401  (offline mode before anything else loads)
from .predict import predict_comments


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            if request.get("ping"):
                response = {"id": request.get("id"), "ok": True}
            else:
                response = {"id": request.get("id"), **predict_comments(request["comments"], request.get("context", ""), request.get("person"))}
        except Exception as error:  # reported back, the worker keeps running
            response = {"id": request.get("id"), "error": str(error)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
