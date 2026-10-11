"""Gemini Batch Mode for the wearable pipeline: half price, answers within minutes to hours.

The pipeline runs as usual with Gemini(defer=True): a request whose answer is not cached is queued here
(queue) instead of being sent, and that profile waits. step() then
  - sends the queued requests as one batch per model (a JSONL file uploaded to the Gemini Files API,
    then models/<model>:batchGenerateContent),
  - checks the batches it sent, and when one is done downloads the answers and writes each one to the
    same cache the live calls use (gemini.record_answer, at half price).
The next pass of the pipeline finds those answers cached and moves on to its next step (which may queue
the next request: profile match, then the wearable first look, then the closer look).

    .venv/bin/python -m wearable.batch status
"""
import json
import time
import urllib.request

from . import config
from .gemini import SSL_CONTEXT, _key, record_answer, cost_of

DIR = config.DATA / "batch"
PENDING = DIR / "pending.jsonl"
JOBS = DIR / "jobs.json"
BASE = "https://generativelanguage.googleapis.com"
MAX_BATCH_BYTES = 150 * 1024 * 1024  # per upload; a bigger queue goes in several batches
SEND_AFTER_S = 120  # queued requests wait this long for company before they are sent


def _request(method, url, body=None, headers=None, raw=False, timeout=600):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"x-goog-api-key": _key(), **({"Content-Type": "application/json"} if data is not None and not isinstance(body, bytes) else {}), **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
        payload = response.read()
        return (payload, dict(response.headers)) if raw else json.loads(payload or b"{}")


def _jobs():
    try:
        return json.loads(JOBS.read_text())
    except (OSError, ValueError):
        return []


def _save_jobs(jobs):
    DIR.mkdir(parents=True, exist_ok=True)
    tmp = JOBS.with_suffix(".tmp")
    tmp.write_text(json.dumps(jobs, indent=1))
    tmp.replace(JOBS)


def _pending():
    if not PENDING.exists():
        return []
    items = []
    for line in PENDING.read_text().split("\n"):
        if line.strip():
            try:
                items.append(json.loads(line))
            except ValueError:
                pass
    return items


def in_flight():
    """Cache keys already queued or in a batch that has not come back yet."""
    keys = {item["key"] for item in _pending()}
    for job in _jobs():
        if job.get("state") not in ("done", "failed"):
            keys.update(job.get("keys", []))
    return keys


_known = None


def queue(key, model, prompt_version, body, purpose, run):
    """Queues one request (once: a request already queued or in a batch is not queued again)."""
    global _known
    if _known is None:
        _known = in_flight()
    if key in _known:
        return
    DIR.mkdir(parents=True, exist_ok=True)
    with open(PENDING, "a") as handle:
        handle.write(json.dumps({"key": key, "model": model, "prompt": prompt_version, "purpose": purpose, "run": run, "at": time.time(), "body": body}) + "\n")
    _known.add(key)


def _upload(data, name):
    _, headers = _request("POST", f"{BASE}/upload/v1beta/files", {"file": {"display_name": name}}, raw=True, headers={
        "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(len(data)), "X-Goog-Upload-Header-Content-Type": "application/jsonl",
    })
    url = next(value for header, value in headers.items() if header.lower() == "x-goog-upload-url")
    uploaded = _request("POST", url, data, headers={"X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Type": "application/jsonl"})
    return uploaded["file"]["name"]


def _find(obj, field):
    if isinstance(obj, dict):
        if field in obj:
            return obj[field]
        for value in obj.values():
            found = _find(value, field)
            if found:
                return found
    return None


def submit(force=False):
    """Sends the queued requests, one batch per model (several if large). Returns batches sent."""
    global _known
    items = _pending()
    if not items or (not force and time.time() - min(item["at"] for item in items) < SEND_AFTER_S):
        return 0
    PENDING.unlink()  # anything queued from here on goes in the next batch
    _known = None
    jobs, sent = _jobs(), 0
    by_model = {}
    for item in items:
        by_model.setdefault(item["model"], []).append(item)
    for model, group in by_model.items():
        chunk, size = [], 0
        for item in group + [None]:
            line = json.dumps({"key": item["key"], "request": item["body"]}).encode() + b"\n" if item else b""
            if item is None or (chunk and size + len(line) > MAX_BATCH_BYTES):
                if chunk:
                    data = b"".join(line_ for line_, _ in chunk)
                    name = f"wearable-{model}-{int(time.time())}"
                    file_name = _upload(data, name)
                    created = _request("POST", f"{BASE}/v1beta/models/{model}:batchGenerateContent", {"batch": {"display_name": name, "input_config": {"file_name": file_name}}})
                    jobs.append({
                        "name": created.get("name") or _find(created, "name"), "model": model, "file": file_name, "state": "running", "sent": time.time(),
                        "keys": [it["key"] for _, it in chunk], "meta": {it["key"]: {"prompt": it["prompt"], "purpose": it["purpose"], "run": it["run"]} for _, it in chunk},
                    })
                    _save_jobs(jobs)
                    sent += 1
                chunk, size = [], 0
            if item:
                chunk.append((line, item))
                size += len(line)
    return sent


def collect():
    """Checks running batches; writes the answers of finished ones to the cache. Returns answers written."""
    jobs, written = _jobs(), 0
    for job in jobs:
        if job.get("state") != "running":
            continue
        status = _request("GET", f"{BASE}/v1beta/{job['name']}")
        state = str(_find(status, "state") or "")
        if state.endswith(("FAILED", "CANCELLED", "EXPIRED")):
            job["state"], job["error"] = "failed", json.dumps(_find(status, "error") or state)[:500]
            continue
        responses_file = _find(status, "responsesFile")
        if not (state.endswith("SUCCEEDED") or status.get("done")) or not responses_file:
            continue
        data, _ = _request("GET", f"{BASE}/download/v1beta/{responses_file}:download?alt=media", raw=True)
        for line in data.decode().split("\n"):
            if not line.strip():
                continue
            entry = json.loads(line)
            key = entry.get("key")
            meta = job["meta"].get(key)
            if not meta or "response" not in entry:
                continue
            record_answer(key, entry["response"], job["model"], meta["prompt"], meta["purpose"], meta["run"], batch=True)
            written += 1
        job["state"], job["finished"] = "done", time.time()
    _save_jobs(jobs)
    global _known
    _known = None  # a request whose answer did not come back usable can be queued again
    return written


def step():
    """One round: collect what came back, send what is queued. Safe to call every minute."""
    written = collect()
    sent = submit()
    return written, sent


def spent_today():
    """USD of batch answers logged today (for the daily cap)."""
    today = time.strftime("%Y-%m-%d")
    total = 0.0
    if config.SPEND.exists():
        for line in config.SPEND.read_text().split("\n"):
            if '"batch": true' in line:
                entry = json.loads(line)
                if entry["at"][:10] == today:
                    total += entry["usd"]
    return total


def main():
    jobs = _jobs()
    print(f"queued: {len(_pending())}")
    for job in jobs[-10:]:
        print(job["name"], job["model"], job["state"], len(job["keys"]), "requests", time.strftime("%H:%M", time.localtime(job["sent"])))
    return 0


if __name__ == "__main__":
    main()
