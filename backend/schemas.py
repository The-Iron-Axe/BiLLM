from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


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


class SessionBranchCreate(BaseModel):
    from_message_id: str
    title: str | None = None


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    session_id: str
    pane: Pane
    role: Role
    content: str
    created_at: datetime


class ContextOptions(BaseModel):
    excluded_message_ids: list[str] = Field(default_factory=list, max_length=10_000)
    recent_turns: int | None = Field(default=None, strict=True, ge=1, le=1000)
    summary: str = Field(default="", max_length=100_000)
    max_context_tokens: int | None = Field(default=None, strict=True, ge=128, le=2_000_000)


class ContextPreview(BaseModel):
    messages: list[dict[str, str]]
    estimated_tokens: int
    omitted_count: int
    message_count: int


class ContextPreviewRequest(BaseModel):
    pane: Pane
    options: ContextOptions = Field(default_factory=ContextOptions)
    draft: str = Field(default="", max_length=1_000_000)


class ContextSummaryOut(BaseModel):
    summary: str


class ChatRequest(BaseModel):
    session_id: str
    pane: Pane
    content: str | None = None
    replace_from_message_id: str | None = None
    request_id: str | None = Field(default=None, min_length=1, max_length=100)
    context_options: ContextOptions | None = None


class PaneStats(BaseModel):
    message_count: int
    total_tokens: int


class MessageListResponse(BaseModel):
    messages: list[MessageOut]
    stats: PaneStats


class ExportedMessage(BaseModel):
    pane: Pane
    role: Role
    content: str
    created_at: datetime


class ExportedSession(BaseModel):
    title: str
    created_at: datetime
    updated_at: datetime
    messages: list[ExportedMessage]


class BackupExport(BaseModel):
    version: Literal[1] = 1
    exported_at: datetime
    sessions: list[ExportedSession]


class BackupImport(BaseModel):
    version: Literal[1]
    sessions: list[ExportedSession] = Field(max_length=10_000)


class BackupImportResult(BaseModel):
    imported_sessions: int
    imported_messages: int
    session_ids: list[str]


class SearchResult(BaseModel):
    session_id: str
    session_title: str
    message_id: str | None = None
    pane: Pane | None = None
    role: Role | None = None
    snippet: str


class SearchResponse(BaseModel):
    results: list[SearchResult]


class UsageStats(BaseModel):
    session_count: int
    message_count: int
    main_messages: int
    aux_messages: int
    main_tokens: int
    aux_tokens: int


class SettingsOut(BaseModel):
    api_base_url: str
    api_key_set: bool
    model_main: str
    model_aux: str
    system_prompt_main: str
    system_prompt_aux: str
    max_output_tokens_main: int | None = None
    max_output_tokens_aux: int | None = None
    revision: int


class SettingsUpdate(BaseModel):
    api_base_url: str | None = None
    api_key: str | None = None
    model_main: str | None = None
    model_aux: str | None = None
    system_prompt_main: str | None = None
    system_prompt_aux: str | None = None
    max_output_tokens_main: int | None = Field(default=None, strict=True, ge=1, le=1_000_000)
    max_output_tokens_aux: int | None = Field(default=None, strict=True, ge=1, le=1_000_000)
