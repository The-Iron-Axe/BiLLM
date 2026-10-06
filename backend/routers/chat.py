from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal, get_db
from ..models import Message, Session, _utcnow
from ..schemas import ChatRequest
from ..services.config_store import ConfigStoreError, get_effective_config
from ..services.context import ContextBudgetError, build_context
from ..services.friendly_errors import friendly_api_error
from ..services.llm import stream_chat
from ..services.tokens import count_tokens

router = APIRouter(prefix="/api/chat", tags=["chat"])
logger = logging.getLogger(__name__)


def _sse(data: dict) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


_DONE = b"data: [DONE]\n\n"


@dataclass
class Generation:
    request_id: str
    payload: ChatRequest
    events: asyncio.Queue[bytes | None] = field(default_factory=asyncio.Queue)
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    provider_task: asyncio.Task | None = None
    status: str = "running"
    saved: bool = False
    message_id: str | None = None
    saved_session_id: str | None = None
    branch_id: str | None = None
    error: str | None = None
    full: str = ""
    input_tokens_estimate: int | None = None
    output_tokens_estimate: int | None = None
    finished_at: float | None = None

    def result(self) -> dict:
        result = {
            "request_id": self.request_id,
            "status": self.status,
            "saved": self.saved,
            "session_id": self.saved_session_id or self.payload.session_id,
        }
        for key in ("message_id", "branch_id", "error"):
            if value := getattr(self, key):
                result[key] = value
        for key in ("input_tokens_estimate", "output_tokens_estimate"):
            if (value := getattr(self, key)) is not None:
                result[key] = value
        return result


# Workers outlive their HTTP responses. Disconnects cancel only the provider;
# persistence runs in the worker and is also awaited during app shutdown.
_requests: dict[str, Generation] = {}
_active_panes: dict[tuple[str, str], str] = {}
_workers: set[asyncio.Task] = set()


def _prune_requests() -> None:
    now = time.monotonic()
    finished = [state for state in _requests.values() if state.finished_at is not None]
    finished.sort(key=lambda state: state.finished_at or 0)
    for index, state in enumerate(finished):
        if now - (state.finished_at or now) > 600 or index < len(finished) - 128:
            _requests.pop(state.request_id, None)


def _signal_stop(state: Generation) -> None:
    if state.status != "running" or state.stop.is_set():
        return
    state.stop.set()
    if state.provider_task is not None and not state.provider_task.done():
        state.provider_task.cancel()


async def shutdown_generations() -> None:
    """Close upstream streams and finish all outstanding database saves."""
    for state in list(_requests.values()):
        _signal_stop(state)
    if _workers:
        await asyncio.gather(*list(_workers), return_exceptions=True)
    _requests.clear()
    _active_panes.clear()


async def _load_history(db: AsyncSession, session_id: str, pane: str) -> list[Message]:
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session_id, Message.pane == pane)
        .order_by(Message.created_at.asc(), Message.id.asc())
    )
    return list(result.scalars())


def _derive_title(text: str) -> str:
    text = text.strip().replace("\n", " ")
    return text[:30] if len(text) <= 30 else text[:30] + "…"


def _signature(history: list[Message]) -> list[tuple[str, str, str]]:
    return [(message.id, message.role, message.content) for message in history]


async def _copy_branch(
    db: AsyncSession, session: Session, *, title_suffix: str, pane: str | None = None,
    prefix_ids: set[str] | None = None,
) -> Session:
    branch = Session(title=f"{session.title[:180]}{title_suffix}")
    db.add(branch)
    await db.flush()
    history = list((await db.execute(
        select(Message).where(Message.session_id == session.id)
        .order_by(Message.created_at, Message.id)
    )).scalars())
    for message in history:
        # Partial replacements live in a branch with the rewound pane, leaving
        # the original complete answer and any later messages intact.
        if pane == message.pane and prefix_ids is not None and message.id not in prefix_ids:
            continue
        db.add(Message(
            session_id=branch.id, pane=message.pane, role=message.role,
            content=message.content, created_at=message.created_at,
        ))
    return branch


async def _persist(
    state: Generation, original_signature: list[tuple[str, str, str]],
    prefix_ids: set[str], user_message: Message | None, *, complete: bool,
) -> None:
    payload = state.payload
    async with AsyncSessionLocal() as db:
        session = await db.get(Session, payload.session_id)
        if session is None:
            raise ValueError("会话已被删除，回复未保存。")
        current = await _load_history(db, payload.session_id, payload.pane)
        if _signature(current) != original_signature:
            raise ValueError("生成期间会话内容已改变，回复未覆盖原有记录。")

        destination_id = session.id
        if payload.replace_from_message_id:
            if complete:
                archive = await _copy_branch(db, session, title_suffix="（修改前）")
                state.branch_id = archive.id
                delete_ids = [message.id for message in current if message.id not in prefix_ids]
                await db.execute(delete(Message).where(Message.id.in_(delete_ids)))
            elif state.full:
                partial = await _copy_branch(
                    db, session, title_suffix="（未完成分支）", pane=payload.pane,
                    prefix_ids=prefix_ids,
                )
                state.branch_id = partial.id
                destination_id = partial.id
            else:
                # Failed regeneration without output must not delete the old answer.
                return

        if user_message is not None:
            db.add(Message(
                id=user_message.id, session_id=destination_id, pane=payload.pane,
                role="user", content=user_message.content, created_at=user_message.created_at,
            ))
            if payload.pane == "main" and session.title in ("", "新对话"):
                session.title = _derive_title(user_message.content)
        saved_message = None
        if state.full:
            saved_message = Message(
                id=str(uuid.uuid4()), session_id=destination_id, pane=payload.pane,
                role="assistant", content=state.full,
            )
            db.add(saved_message)
        session.updated_at = _utcnow()
        await db.commit()
        state.saved = True
        state.saved_session_id = destination_id
        state.message_id = saved_message.id if saved_message else None


async def _pump_provider(state: Generation, cfg, messages: list[dict[str, str]]) -> None:
    pane = state.payload.pane
    output_limit = getattr(cfg, f"max_output_tokens_{pane}", None)
    async for delta in stream_chat(
        cfg, pane, messages, messages_are_complete=True,
        max_output_tokens=output_limit,
    ):
        if state.stop.is_set():
            break
        state.full += delta
        state.events.put_nowait(_sse({"content": delta, "request_id": state.request_id}))


async def _run_generation(state: Generation) -> None:
    payload = state.payload
    try:
        cfg = await get_effective_config()
        if not cfg.api_key:
            raise ValueError("请在设置中配置 API Key。")
        async with AsyncSessionLocal() as db:
            session = await db.get(Session, payload.session_id)
            if session is None:
                raise ValueError("会话不存在。")
            original = await _load_history(db, payload.session_id, payload.pane)
            original_signature = _signature(original)
            history = original
            if payload.replace_from_message_id:
                index = next((i for i, message in enumerate(original)
                              if message.id == payload.replace_from_message_id), None)
                if index is None:
                    raise ValueError("要重生成或编辑的消息不存在。")
                history = original[:index]
            prefix_ids = {message.id for message in history}
            user_message = None
            if payload.content is not None:
                user_message = Message(
                    id=str(uuid.uuid4()), session_id=payload.session_id, pane=payload.pane,
                    role="user", content=payload.content, created_at=_utcnow(),
                )
                history = [*history, user_message]
            if not history or not any(message.role == "user" for message in history):
                raise ValueError("没有可发送给模型的用户消息。")
            model = cfg.model_main if payload.pane == "main" else cfg.model_aux
            system = cfg.system_prompt_main if payload.pane == "main" else cfg.system_prompt_aux
            preview = build_context(history, system, model, getattr(payload, "context_options", None))
            state.input_tokens_estimate = preview.estimated_tokens
            if not any(message["role"] == "user" for message in preview.messages):
                raise ValueError("没有可发送给模型的用户消息，请调整上下文排除设置。")

        provider_completed = False
        if not state.stop.is_set():
            state.provider_task = asyncio.create_task(_pump_provider(state, cfg, preview.messages))
            try:
                await state.provider_task
                provider_completed = not state.stop.is_set()
            except asyncio.CancelledError:
                if not state.stop.is_set():
                    raise
            except Exception as exc:  # noqa: BLE001
                logger.exception("LLM request failed (%s)", state.request_id)
                state.error = f"LLM 请求失败：{friendly_api_error(exc)}"
        if provider_completed and not state.full:
            state.error = "模型没有返回可保存的文本，请重试。"
        state.output_tokens_estimate = count_tokens(state.full, model)
        try:
            await _persist(
                state, original_signature, prefix_ids, user_message,
                complete=provider_completed and bool(state.full) and not state.error,
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("Chat persistence failed (%s)", state.request_id)
            state.saved = False
            state.message_id = None
            state.branch_id = None
            state.error = str(exc) if isinstance(exc, ValueError) else "回复保存失败，请保留当前文本后重试。"
        state.status = "failed" if state.error else "stopped" if state.stop.is_set() else "saved"
    except ConfigStoreError:
        state.status = "failed"
        state.error = "无法读取 config.json，请检查配置格式。"
    except (ValueError, ContextBudgetError) as exc:
        state.status = "failed"
        state.error = str(exc)
    except Exception:  # noqa: BLE001
        logger.exception("Generation failed (%s)", state.request_id)
        state.status = "failed"
        state.error = "聊天请求未能完成，请重试。"
    finally:
        state.finished_at = time.monotonic()
        _active_panes.pop((payload.session_id, payload.pane), None)
        state.events.put_nowait(_sse({"type": "result", **state.result()}))
        state.events.put_nowait(_DONE)
        state.events.put_nowait(None)
        state.full = ""


async def _event_source(state: Generation) -> AsyncIterator[bytes]:
    try:
        while True:
            event = await state.events.get()
            if event is None:
                break
            yield event
    finally:
        _signal_stop(state)
        # Status is retained briefly for reconnect/stop checks, but unused
        # buffered text must not remain in the request registry after disconnect.
        while not state.events.empty():
            state.events.get_nowait()


@router.post("/stream")
async def chat_stream(
    payload: ChatRequest, db: AsyncSession = Depends(get_db)
) -> StreamingResponse:
    if await db.get(Session, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.content is None and payload.replace_from_message_id is None:
        raise HTTPException(status_code=400, detail="Either content or a replacement target is required.")
    if payload.content is not None and not payload.content.strip():
        raise HTTPException(status_code=422, detail="Message content cannot be blank.")
    if payload.replace_from_message_id:
        target = await db.get(Message, payload.replace_from_message_id)
        if target is None or target.session_id != payload.session_id or target.pane != payload.pane:
            raise HTTPException(status_code=404, detail="Target message not found")
        expected_role = "user" if payload.content is not None else "assistant"
        if target.role != expected_role:
            raise HTTPException(status_code=422, detail="Invalid replacement target role")

    _prune_requests()
    request_id = getattr(payload, "request_id", None) or str(uuid.uuid4())
    pane_key = (payload.session_id, payload.pane)
    if request_id in _requests:
        raise HTTPException(status_code=409, detail="This request_id has already been used.")
    if pane_key in _active_panes:
        raise HTTPException(status_code=409, detail="This pane is already generating. Stop it before retrying.")
    state = Generation(request_id=request_id, payload=payload)
    _requests[request_id] = state
    _active_panes[pane_key] = request_id
    state.task = asyncio.create_task(_run_generation(state))
    _workers.add(state.task)
    state.task.add_done_callback(_workers.discard)
    return StreamingResponse(
        _event_source(state), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "X-Request-ID": request_id},
    )


@router.post("/{request_id}/stop")
async def stop_generation(request_id: str) -> dict:
    state = _requests.get(request_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Request not found")
    _signal_stop(state)
    if state.task is not None:
        try:
            await asyncio.wait_for(asyncio.shield(state.task), timeout=15)
        except TimeoutError:
            # Provider closing can take time. Clients can poll until persistence
            # changes the status from running to a terminal value.
            pass
    return state.result()


@router.get("/{request_id}/status")
async def generation_status(request_id: str) -> dict:
    state = _requests.get(request_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Request not found")
    return state.result()
