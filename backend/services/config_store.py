from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models import AppSettings
from ..schemas import SettingsUpdate


@dataclass
class EffectiveConfig:
    api_base_url: str
    api_key: str
    model_main: str
    model_aux: str


async def _get_row(db: AsyncSession) -> AppSettings | None:
    result = await db.execute(select(AppSettings).where(AppSettings.id == 1))
    return result.scalar_one_or_none()


async def get_effective_config(db: AsyncSession) -> EffectiveConfig:
    row = await _get_row(db)
    return EffectiveConfig(
        api_base_url=(row.api_base_url if row and row.api_base_url else settings.openai_base_url),
        api_key=(row.api_key if row and row.api_key else settings.openai_api_key),
        model_main=(row.model_main if row and row.model_main else settings.model_main),
        model_aux=(row.model_aux if row and row.model_aux else settings.model_aux),
    )


async def update_overrides(db: AsyncSession, payload: SettingsUpdate) -> None:
    row = await _get_row(db)
    if row is None:
        row = AppSettings(id=1)
        db.add(row)

    if payload.api_base_url is not None:
        row.api_base_url = payload.api_base_url.strip() or None
    if payload.api_key is not None:
        row.api_key = payload.api_key.strip() or None
    if payload.model_main is not None:
        row.model_main = payload.model_main.strip() or None
    if payload.model_aux is not None:
        row.model_aux = payload.model_aux.strip() or None

    await db.commit()


async def clear_overrides(db: AsyncSession) -> None:
    """Drop the DB-stored overrides so the effective config falls back to .env."""
    row = await _get_row(db)
    if row is not None:
        await db.delete(row)
        await db.commit()
