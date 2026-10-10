"""Gemini client for wearable detection: cached, budgeted, logged.

- Cache: every request is keyed by model + prompt version + exact image bytes + text, and its answer
  is stored in data/wearable/gemini-cache/. The same request is never paid for twice.
- Budget: a run has a hard USD cap; a call that could exceed it is refused (BudgetExceeded).
- Dry run: counts tokens with Gemini's free countTokens endpoint and prices them, without generating.
- Usage: Gemini's own token counts for every paid call go to data/gemini-usage.jsonl (the Outreach
  API costs card) and data/wearable/spend.jsonl.
- Retries with exponential backoff on rate limits and server errors.
"""
import base64
import hashlib
import json
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from . import config

API = "https://generativelanguage.googleapis.com/v1beta/models"

try:  # python.org builds on macOS ship without a CA store; certifi comes with the ML dependencies
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()


class BudgetExceeded(RuntimeError):
    pass


def _key():
    return config.KEY_PATH.read_text().strip()


def _post(url, body, timeout=120):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"x-goog-api-key": _key(), "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
        return json.loads(response.read())


def cost_of(model, input_tokens, output_tokens):
    price_in, price_out = config.PRICES.get(model, config.PRICES["gemini-3.8-flash"])
    return (input_tokens * price_in + output_tokens * price_out) / 1e6


class Gemini:
    def __init__(self, budget=config.DEFAULT_BUDGET, dry_run=False, run="wearable", purpose="wearable detection"):
        self.budget = budget
        self.dry_run = dry_run
        self.run = run
        self.purpose = purpose
        self.spent = 0.0
        self.calls = 0
        self.cache_hits = 0
        self.estimated = 0.0
        config.GEMINI_CACHE.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _parts(images, text):
        parts = [{"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(image).decode()}} for image in images]
        return parts + [{"text": text}]

    def cache_key(self, model, prompt_version, images, text, extra=""):
        digest = hashlib.sha256()
        for item in (model, prompt_version, extra, text):
            digest.update(str(item).encode())
        for image in images:
            digest.update(hashlib.sha256(image).digest())
        return digest.hexdigest()

    def generate(self, model, prompt_version, images, text, schema, max_output_tokens=900, media_resolution=None, thinking=0):
        """Structured JSON answer. images: list of JPEG bytes."""
        key = self.cache_key(model, prompt_version, images, text, f"{media_resolution}|{thinking}|{max_output_tokens}")
        cached = config.GEMINI_CACHE / f"{key}.json"
        if cached.exists():
            self.cache_hits += 1
            return json.loads(cached.read_text())
        generation = {"temperature": 0, "responseMimeType": "application/json", "responseSchema": schema, "maxOutputTokens": max_output_tokens}
        if media_resolution:
            generation["mediaResolution"] = media_resolution
        if thinking is not None:
            generation["thinkingConfig"] = {"thinkingBudget": thinking}
        body = {"contents": [{"role": "user", "parts": self._parts(images, text)}], "generationConfig": generation}
        if self.dry_run:
            counted = _post(f"{API}/{model}:countTokens", {"generateContentRequest": {"model": f"models/{model}", **body}})
            estimate = cost_of(model, counted.get("totalTokens", 0), max_output_tokens // 3)
            self.estimated += estimate
            return {"dry_run": True, "input_tokens": counted.get("totalTokens", 0), "estimated_usd": estimate}
        # Worst case for this call: input estimated from image count, full output allowance.
        worst = cost_of(model, 1500 * max(1, len(images)) + len(text) // 3, max_output_tokens + (thinking or 0))
        if self.spent + worst > self.budget:
            raise BudgetExceeded(f"Budget ${self.budget:.2f} reached (spent ${self.spent:.4f}).")
        payload = None
        for attempt in range(6):
            try:
                payload = _post(f"{API}/{model}:generateContent", body)
                break
            except urllib.error.HTTPError as error:
                if error.code in (429, 500, 502, 503, 504) and attempt < 5:
                    time.sleep(2 ** attempt + 0.5)
                    continue
                raise RuntimeError(f"Gemini {error.code}: {error.read()[:300]!r}") from None
            except (urllib.error.URLError, TimeoutError):
                if attempt < 5:
                    time.sleep(2 ** attempt + 0.5)
                    continue
                raise
        usage = payload.get("usageMetadata", {})
        input_tokens = usage.get("promptTokenCount", 0)
        output_tokens = usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0)
        usd = cost_of(model, input_tokens, output_tokens)
        self.spent += usd
        self.calls += 1
        now = datetime.now(timezone.utc).isoformat()
        with open(config.USAGE_LOG, "a") as log:
            log.write(json.dumps({"at": now, "purpose": self.purpose, "model": model, "input": input_tokens, "cached": usage.get("cachedContentTokenCount", 0), "output": output_tokens, "cacheWrite": 0}) + "\n")
        with open(config.SPEND, "a") as log:
            log.write(json.dumps({"at": now, "run": self.run, "model": model, "prompt": prompt_version, "input": input_tokens, "output": output_tokens, "usd": usd}) + "\n")
        text_out = "".join(part.get("text", "") for part in payload.get("candidates", [{}])[0].get("content", {}).get("parts", []) if not part.get("thought"))
        try:
            answer = json.loads(text_out)
        except json.JSONDecodeError:
            answer = {"_unparsed": text_out[:2000]}
        result = {"answer": answer, "model": model, "prompt": prompt_version, "input_tokens": input_tokens, "output_tokens": output_tokens, "usd": usd, "at": now}
        if "_unparsed" not in answer:
            cached.write_text(json.dumps(result))
        return result
