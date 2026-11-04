import re


def slugify(text: str) -> str:
    """Lowercase, replace runs of non-alphanumerics with a single '-', strip leading/trailing '-'."""
    return re.sub(r"[^a-z0-9]", "-", text.lower())


def word_count(text: str) -> int:
    return len(text.split())
