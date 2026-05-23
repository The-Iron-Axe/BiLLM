from __future__ import annotations

from functools import lru_cache
from typing import Iterable

try:
    import tiktoken
except Exception:  # noqa: BLE001
    tiktoken = None  # type: ignore[assignment]


# Per-message overhead (role + separators) — closely tracks the
# ChatCompletion accounting OpenAI uses for gpt-4/4o family.
_MSG_OVERHEAD = 4


@lru_cache(maxsize=32)
def _get_encoding(model: str):  # noqa: ANN202
    if tiktoken is None:
        return None
    try:
        return tiktoken.encoding_for_model(model)
    except Exception:  # noqa: BLE001
        try:
            return tiktoken.get_encoding("cl100k_base")
        except Exception:  # noqa: BLE001
            return None


def count_tokens(text: str, model: str = "gpt-4o-mini") -> int:
    if not text:
        return 0
    enc = _get_encoding(model)
    if enc is not None:
        try:
            return len(enc.encode(text, disallowed_special=()))
        except Exception:  # noqa: BLE001
            pass
    # Fallback heuristic: ~1 token per 4 chars for ASCII-heavy text,
    # ~1 token per 1.5 chars for CJK-heavy text. Take a middle value.
    return max(1, int(len(text) / 2.4))


def count_messages_tokens(
    contents: Iterable[str], model: str = "gpt-4o-mini"
) -> int:
    total = 0
    for c in contents:
        total += count_tokens(c, model) + _MSG_OVERHEAD
    return total
