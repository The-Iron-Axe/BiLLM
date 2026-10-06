from __future__ import annotations

import asyncio
import json
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..schemas import SettingsUpdate

ROOT = Path(__file__).resolve().parent.parent.parent
CONFIG_PATH = ROOT / "config.json"
EXAMPLE_PATH = ROOT / "config.example.json"

DEFAULTS: dict[str, Any] = {
    "api_base_url": "https://api.openai.com/v1",
    "api_key": "",
    "model_main": "gpt-4o",
    "model_aux": "gpt-4o-mini",
    "system_prompt_main": (
        "You are the primary assistant. The user uses this pane for their main, "
        "complex problem. Be thorough, structured, and detailed."
    ),
    "system_prompt_aux": (
        "You are an auxiliary assistant in a side pane. The user asks shorter, "
        "off-topic or quick lookup questions here to avoid polluting the main "
        "conversation. Be concise and focused."
    ),
    "max_output_tokens_main": None,
    "max_output_tokens_aux": None,
}

_lock = asyncio.Lock()
logger = logging.getLogger(__name__)


class ConfigStoreError(ValueError):
    """Raised when a local configuration file cannot be safely read."""


@dataclass
class EffectiveConfig:
    api_base_url: str
    api_key: str
    model_main: str
    model_aux: str
    system_prompt_main: str
    system_prompt_aux: str
    max_output_tokens_main: int | None = None
    max_output_tokens_aux: int | None = None
    revision: int = 0


def _file_revision() -> int:
    """Implicit version for polling — derived from file mtime, not stored in JSON."""
    if not CONFIG_PATH.exists():
        return 0
    return CONFIG_PATH.stat().st_mtime_ns


def _core_fields(raw: dict[str, Any]) -> dict[str, Any]:
    def value(key: str, default: str) -> str:
        candidate = raw.get(key)
        if candidate is None:
            return default
        if not isinstance(candidate, str):
            raise ConfigStoreError(f"字段 {key} 必须是字符串")
        return candidate.strip() or default

    def optional_limit(key: str) -> int | None:
        candidate = raw.get(key)
        if candidate is None:
            return None
        if type(candidate) is not int or not 1 <= candidate <= 1_000_000:
            raise ConfigStoreError(f"字段 {key} 必须是正整数或 null")
        return candidate

    return {
        "api_base_url": value("api_base_url", DEFAULTS["api_base_url"]),
        "api_key": value("api_key", ""),
        "model_main": value("model_main", DEFAULTS["model_main"]),
        "model_aux": value("model_aux", DEFAULTS["model_aux"]),
        "system_prompt_main": value("system_prompt_main", DEFAULTS["system_prompt_main"]),
        "system_prompt_aux": value("system_prompt_aux", DEFAULTS["system_prompt_aux"]),
        "max_output_tokens_main": optional_limit("max_output_tokens_main"),
        "max_output_tokens_aux": optional_limit("max_output_tokens_aux"),
    }


def _read_json_object(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigStoreError("JSON 格式无效") from exc
    if not isinstance(raw, dict):
        raise ConfigStoreError("根节点必须是 JSON 对象")
    return raw


def _template_data() -> dict[str, Any]:
    if EXAMPLE_PATH.exists():
        raw = _read_json_object(EXAMPLE_PATH)
        return _core_fields({**DEFAULTS, **raw})
    return DEFAULTS.copy()


def _read_file_unlocked() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        data = _template_data()
        _write_file_unlocked(data)
        return data
    raw = _read_json_object(CONFIG_PATH)
    return _core_fields(raw)


def _write_file_unlocked(data: dict[str, Any]) -> dict[str, Any]:
    out = _core_fields(data)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(out, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(CONFIG_PATH)
    return out


def _to_effective(data: dict[str, Any]) -> EffectiveConfig:
    return EffectiveConfig(
        api_base_url=data["api_base_url"],
        api_key=data["api_key"],
        model_main=data["model_main"],
        model_aux=data["model_aux"],
        system_prompt_main=data["system_prompt_main"],
        system_prompt_aux=data["system_prompt_aux"],
        max_output_tokens_main=data["max_output_tokens_main"],
        max_output_tokens_aux=data["max_output_tokens_aux"],
        revision=_file_revision(),
    )


async def ensure_config_file() -> None:
    async with _lock:
        try:
            _read_file_unlocked()
        except ConfigStoreError as exc:
            # A direct edit should not prevent the local application from
            # starting. Preserve the bad file for recovery, then boot with a
            # known-safe template.
            if CONFIG_PATH.exists():
                backup = CONFIG_PATH.with_name("config.json.invalid.bak")
                shutil.copy2(CONFIG_PATH, backup)
            _write_file_unlocked(_template_data())
            logger.warning("Invalid config.json backed up and reset: %s", exc)


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
        if payload.system_prompt_main is not None:
            data["system_prompt_main"] = (
                payload.system_prompt_main.strip() or DEFAULTS["system_prompt_main"]
            )
        if payload.system_prompt_aux is not None:
            data["system_prompt_aux"] = (
                payload.system_prompt_aux.strip() or DEFAULTS["system_prompt_aux"]
            )
        for key in ("max_output_tokens_main", "max_output_tokens_aux"):
            if key in payload.model_fields_set:
                data[key] = getattr(payload, key)
        data = _write_file_unlocked(data)
    return _to_effective(data)


async def reset_config_to_example() -> EffectiveConfig:
    async with _lock:
        data = _write_file_unlocked(_template_data())
    return _to_effective(data)
