from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


Pane = Literal["main", "aux"]
Role = Literal["user", "assistant"]


class SessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    created_at: datetime
    updated_at: datetime


class SessionCreate(BaseModel):
    title: str | None = None


class SessionUpdate(BaseModel):
    title: str


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    session_id: str
    pane: Pane
    role: Role
    content: str
    created_at: datetime


class ChatRequest(BaseModel):
    session_id: str
    pane: Pane
    content: str | None = None
    replace_from_message_id: str | None = None


class PaneStats(BaseModel):
    message_count: int
    total_tokens: int


class MessageListResponse(BaseModel):
    messages: list[MessageOut]
    stats: PaneStats


class SettingsOut(BaseModel):
    api_base_url: str
    api_key_set: bool
    model_main: str
    model_aux: str


class SettingsUpdate(BaseModel):
    api_base_url: str | None = None
    api_key: str | None = None
    model_main: str | None = None
    model_aux: str | None = None
