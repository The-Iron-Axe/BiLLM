from __future__ import annotations

from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from .config_store import EffectiveConfig

SYSTEM_PROMPTS = {
    "main": (
        "You are the primary assistant. The user uses this pane for their main, "
        "complex problem. Be thorough, structured, and detailed."
    ),
    "aux": (
        "You are an auxiliary assistant in a side pane. The user asks shorter, "
        "off-topic or quick lookup questions here to avoid polluting the main "
        "conversation. Be concise and focused."
    ),
}


def _client(cfg: EffectiveConfig) -> AsyncOpenAI:
    return AsyncOpenAI(api_key=cfg.api_key or "sk-none", base_url=cfg.api_base_url)


async def stream_chat(
    cfg: EffectiveConfig,
    pane: str,
    history: list[dict[str, str]],
) -> AsyncIterator[str]:
    """Stream assistant text deltas for one chat turn.

    `history` already contains the latest user message at the end.

    Ensures the underlying OpenAI stream is closed when the consumer
    stops iterating (e.g. client disconnect / abort), so we do not keep
    burning tokens after the user pressed "stop".
    """
    model = cfg.model_main if pane == "main" else cfg.model_aux
    system = SYSTEM_PROMPTS.get(pane, SYSTEM_PROMPTS["main"])

    messages = [{"role": "system", "content": system}, *history]

    client = _client(cfg)
    stream = await client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True,
    )

    try:
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta and delta.content:
                yield delta.content
    finally:
        # Closing the AsyncStream sends an HTTP-level cancel to the
        # provider, freeing the in-flight completion.
        try:
            close = getattr(stream, "close", None)
            if close is not None:
                result = close()
                if hasattr(result, "__await__"):
                    await result
        except Exception:  # noqa: BLE001
            pass
