from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..schemas import SettingsUpdate

ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_PATH = ROOT / "config.json"
EXAMPLE_PATH = ROOT / "config.example.json"

DEFAULTS: dict[str, str] = {
    "api_base_url": "https://api.openai.com/v1",
    "api_key": "",
    "model_main": "gpt-4o",
    "model_aux": "gpt-4o-mini",
}

_lock = asyncio.Lock()


@dataclass
class EffectiveConfig:
    api_base_url: str
    api_key: str
    model_main: str
    model_aux: str
    revision: int = 0


def _file_revision() -> int:
    """Implicit version for polling — derived from file mtime, not stored in JSON."""
    if not CONFIG_PATH.exists():
        return 0
    return CONFIG_PATH.stat().st_mtime_ns


def _core_fields(raw: dict[str, Any]) -> dict[str, str]:
    return {
        "api_base_url": (raw.get("api_base_url") or DEFAULTS["api_base_url"]).strip(),
        "api_key": (raw.get("api_key") or "").strip(),
        "model_main": (raw.get("model_main") or DEFAULTS["model_main"]).strip(),
        "model_aux": (raw.get("model_aux") or DEFAULTS["model_aux"]).strip(),
    }


def _template_data() -> dict[str, str]:
    if EXAMPLE_PATH.exists():
        raw = json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))
        return _core_fields({**DEFAULTS, **raw})
    return DEFAULTS.copy()


def _read_file_unlocked() -> dict[str, str]:
    if not CONFIG_PATH.exists():
        data = _template_data()
        _write_file_unlocked(data)
        return data
    raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return _core_fields(raw)


def _write_file_unlocked(data: dict[str, str]) -> dict[str, str]:
    out = _core_fields(data)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(CONFIG_PATH)
    return out


def _to_effective(data: dict[str, str]) -> EffectiveConfig:
    return EffectiveConfig(
        api_base_url=data["api_base_url"],
        api_key=data["api_key"],
        model_main=data["model_main"],
        model_aux=data["model_aux"],
        revision=_file_revision(),
    )


async def ensure_config_file() -> None:
    async with _lock:
        _read_file_unlocked()


async def get_effective_config() -> EffectiveConfig:
    async with _lock:
        return _to_effective(_read_file_unlocked())


async def update_config(payload: SettingsUpdate) -> EffectiveConfig:
    async with _lock:
        data = _read_file_unlocked()
        if payload.api_base_url is not None:
            data["api_base_url"] = payload.api_base_url.strip() or DEFAULTS["api_base_url"]
        if payload.api_key is not None:
            data["api_key"] = payload.api_key.strip()
        if payload.model_main is not None:
            data["model_main"] = payload.model_main.strip() or DEFAULTS["model_main"]
        if payload.model_aux is not None:
            data["model_aux"] = payload.model_aux.strip() or DEFAULTS["model_aux"]
        data = _write_file_unlocked(data)
    return _to_effective(data)


async def reset_config_to_example() -> EffectiveConfig:
    async with _lock:
        data = _write_file_unlocked(_template_data())
    return _to_effective(data)
