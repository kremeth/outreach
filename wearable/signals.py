"""Approach D: free text signals. Brand mentions in the bio, name and captions.

Only ever positive evidence: no mention says nothing (most wearable users never name their device).
"""
import re

PATTERNS = {
    "Garmin": r"\bgarmin\b|#garmin|\bforerunner\b|\bfenix\s?\d|\bvenu\s?\d?\b|\bedge\s?(530|540|830|840|1040|1050)\b",
    "WHOOP": r"\bwhoop\b|#whoop|whoop\s?(4|5|mg|band)",
    "Apple Watch": r"\bapple\s?watch\b|#applewatch|\bwatch\s?ultra\b",
    "Polar": r"\bpolar\s?(vantage|pacer|grit|ignite|h10|verity|unite|flow)\b|#polarglobal|@polarglobal|#polar\b",
    "Oura": r"\boura\b|#oura|@ouraring|\boura\s?ring\b",
}
COMPILED = {brand: re.compile(pattern, re.I) for brand, pattern in PATTERNS.items()}


def mentions(profile):
    """{brand: [where...]} for every brand named in the bio, name or captions."""
    found = {}
    sources = [("bio", profile.get("bio", "")), ("name", profile.get("name", ""))]
    sources += [(f"caption {post['index']}", post.get("caption", "")) for post in profile.get("posts", [])]
    for where, text in sources:
        for brand, pattern in COMPILED.items():
            if text and pattern.search(text):
                found.setdefault(brand, []).append(where)
    return found
