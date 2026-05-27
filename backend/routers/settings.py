from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter
from openai import AsyncOpenAI
from pydantic import BaseModel

from ..schemas import SettingsOut, SettingsUpdate
from ..services.config_store import (
    get_effective_config,
    reset_config_to_example,
    update_config,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])


class TestConnectionRequest(BaseModel):
    """Optional in-flight overrides. If omitted, the saved config is used."""

    api_base_url: str | None = None
    api_key: str | None = None
    model: str | None = None  # which model to ping; defaults to model_main


class TestConnectionResponse(BaseModel):
    ok: bool
    detail: str
    latency_ms: int | None = None
    model: str | None = None


def _to_out(cfg) -> SettingsOut:
    return SettingsOut(
        api_base_url=cfg.api_base_url,
        api_key_set=bool(cfg.api_key),
        model_main=cfg.model_main,
        model_aux=cfg.model_aux,
        revision=cfg.revision,
    )


@router.get("", response_model=SettingsOut)
async def read_settings() -> SettingsOut:
    cfg = await get_effective_config()
    return _to_out(cfg)


@router.put("", response_model=SettingsOut)
async def update_settings(payload: SettingsUpdate) -> SettingsOut:
    cfg = await update_config(payload)
    return _to_out(cfg)


@router.post("/reset", response_model=SettingsOut)
async def reset_settings() -> SettingsOut:
    """Restore values from ``config.example.json`` into ``config.json``."""
    cfg = await reset_config_to_example()
    return _to_out(cfg)


@router.post("/test", response_model=TestConnectionResponse)
async def test_connection(payload: TestConnectionRequest) -> TestConnectionResponse:
    """Send a minimal request to the configured provider to verify reachability."""
    saved = await get_effective_config()
    base_url = (payload.api_base_url or saved.api_base_url or "").strip()
    api_key = (payload.api_key or saved.api_key or "").strip()
    model = (payload.model or saved.model_main or "").strip()

    if not api_key:
        return TestConnectionResponse(ok=False, detail="未配置 API Key")
    if not base_url:
        return TestConnectionResponse(ok=False, detail="未配置 Base URL")
    if not model:
        return TestConnectionResponse(ok=False, detail="未配置主模型")

    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    start = time.perf_counter()
    try:
        resp = await asyncio.wait_for(
            client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": "ping"}],
                max_tokens=1,
                stream=False,
            ),
            timeout=15.0,
        )
        latency = int((time.perf_counter() - start) * 1000)
        echoed = getattr(resp, "model", None) or model
        return TestConnectionResponse(
            ok=True,
            detail=f"连接成功（{latency} ms）",
            latency_ms=latency,
            model=echoed,
        )
    except asyncio.TimeoutError:
        return TestConnectionResponse(ok=False, detail="超时（>15 s）")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        first_line = msg.splitlines()[0] if msg else type(exc).__name__
        return TestConnectionResponse(ok=False, detail=first_line[:300])
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass
