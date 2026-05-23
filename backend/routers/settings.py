from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends
from openai import AsyncOpenAI
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..schemas import SettingsOut, SettingsUpdate
from ..services.config_store import (
    clear_overrides,
    get_effective_config,
    update_overrides,
)
from ..database import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])


class TestConnectionRequest(BaseModel):
    """Optional in-flight overrides. If omitted, the saved effective config is used."""

    api_base_url: str | None = None
    api_key: str | None = None
    model: str | None = None  # which model to ping; defaults to model_main


class TestConnectionResponse(BaseModel):
    ok: bool
    detail: str
    latency_ms: int | None = None
    model: str | None = None


@router.get("", response_model=SettingsOut)
async def read_settings(db: AsyncSession = Depends(get_db)) -> SettingsOut:
    cfg = await get_effective_config(db)
    return SettingsOut(
        api_base_url=cfg.api_base_url,
        api_key_set=bool(cfg.api_key),
        model_main=cfg.model_main,
        model_aux=cfg.model_aux,
    )


@router.put("", response_model=SettingsOut)
async def update_settings(
    payload: SettingsUpdate, db: AsyncSession = Depends(get_db)
) -> SettingsOut:
    await update_overrides(db, payload)
    cfg = await get_effective_config(db)
    return SettingsOut(
        api_base_url=cfg.api_base_url,
        api_key_set=bool(cfg.api_key),
        model_main=cfg.model_main,
        model_aux=cfg.model_aux,
    )


@router.post("/reset", response_model=SettingsOut)
async def reset_settings(db: AsyncSession = Depends(get_db)) -> SettingsOut:
    """Drop DB overrides; the effective config will fall back to .env."""
    await clear_overrides(db)
    cfg = await get_effective_config(db)
    return SettingsOut(
        api_base_url=cfg.api_base_url,
        api_key_set=bool(cfg.api_key),
        model_main=cfg.model_main,
        model_aux=cfg.model_aux,
    )


@router.post("/test", response_model=TestConnectionResponse)
async def test_connection(
    payload: TestConnectionRequest,
    db: AsyncSession = Depends(get_db),
) -> TestConnectionResponse:
    """Send a minimal request to the configured provider to verify reachability.

    Uses the in-flight overrides if provided (so the user can test what's
    in the form before saving). Costs at most 1 output token.
    """
    saved = await get_effective_config(db)
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
        # Use the model echoed back by the provider when available -- some
        # gateways resolve aliases.
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
        # OpenAI SDK exception messages can be very long with raw body --
        # take the first line as a human-friendly summary.
        first_line = msg.splitlines()[0] if msg else type(exc).__name__
        return TestConnectionResponse(ok=False, detail=first_line[:300])
    finally:
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            pass
