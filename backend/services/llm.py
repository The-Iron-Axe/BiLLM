from __future__ import annotations

from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from .config_store import EffectiveConfig

def _client(cfg: EffectiveConfig) -> AsyncOpenAI:
    return AsyncOpenAI(api_key=cfg.api_key or "sk-none", base_url=cfg.api_base_url)


async def stream_chat(
    cfg: EffectiveConfig,
    pane: str,
    history: list[dict[str, str]],
    *,
    messages_are_complete: bool = False,
    max_output_tokens: int | None = None,
) -> AsyncIterator[str]:
    """Stream assistant text deltas for one chat turn.

    `history` already contains the latest user message at the end.

    Ensures the underlying OpenAI stream is closed when the consumer
    stops iterating (e.g. client disconnect / abort), so we do not keep
    burning tokens after the user pressed "stop".
    """
    model = cfg.model_main if pane == "main" else cfg.model_aux
    system = cfg.system_prompt_main if pane == "main" else cfg.system_prompt_aux

    messages = history if messages_are_complete else [{"role": "system", "content": system}, *history]

    client = _client(cfg)
    stream = None

    try:
        output_options = {"max_tokens": max_output_tokens} if max_output_tokens is not None else {}
        stream = await client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
            **output_options,
        )
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
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass
