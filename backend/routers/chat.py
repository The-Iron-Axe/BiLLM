from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import AsyncSessionLocal, get_db
from ..models import Message, Session, _utcnow
from ..schemas import ChatRequest
from ..services.config_store import get_effective_config
from ..services.llm import stream_chat

router = APIRouter(prefix="/api/chat", tags=["chat"])


def _sse(data: dict) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


_DONE = b"data: [DONE]\n\n"


async def _load_history(db: AsyncSession, session_id: str, pane: str) -> list[dict[str, str]]:
    result = await db.execute(
        select(Message)
        .where(Message.session_id == session_id, Message.pane == pane)
        .order_by(Message.created_at.asc())
    )
    return [{"role": m.role, "content": m.content} for m in result.scalars().all()]


def _derive_title(text: str) -> str:
    text = text.strip().replace("\n", " ")
    return text[:30] if len(text) <= 30 else text[:30] + "…"


async def _delete_from(
    db: AsyncSession, session_id: str, pane: str, from_message_id: str
) -> bool:
    """Delete `from_message_id` and every message in the same pane created
    at or after it. Returns True if the target message existed.

    Uses an ID set so we don't rely on text-based datetime comparisons (SQLite
    stores DateTime as text and the format can drift across drivers).
    """
    anchor = await db.get(Message, from_message_id)
    if anchor is None or anchor.session_id != session_id or anchor.pane != pane:
        return False

    result = await db.execute(
        select(Message.id, Message.created_at)
        .where(Message.session_id == session_id, Message.pane == pane)
        .order_by(Message.created_at.asc(), Message.id.asc())
    )
    rows = list(result.all())
    try:
        idx = next(i for i, (mid, _) in enumerate(rows) if mid == from_message_id)
    except StopIteration:
        return False
    ids_to_delete = [mid for mid, _ in rows[idx:]]
    if not ids_to_delete:
        return False
    await db.execute(delete(Message).where(Message.id.in_(ids_to_delete)))
    return True


async def _event_source(payload: ChatRequest) -> AsyncIterator[bytes]:
    """Single streaming endpoint that handles three flows:

    1. Send new user message   -> content set,  replace_from_message_id None
    2. Regenerate assistant     -> content None, replace_from_message_id = assistant msg id
    3. Edit user msg & resend   -> content set,  replace_from_message_id = user msg id

    Partial assistant output is always persisted, so pressing "stop" or
    a client disconnect still leaves the work-so-far visible.
    """
    # Use a fresh session for the entire streaming lifecycle so it survives
    # past the request handler returning the StreamingResponse.
    async with AsyncSessionLocal() as db:
        session = await db.get(Session, payload.session_id)
        if session is None:
            yield _sse({"error": "Session not found"})
            yield _DONE
            return

        cfg = await get_effective_config(db)
        if not cfg.api_key:
            yield _sse(
                {
                    "error": "API key not configured. Open Settings and set OPENAI_API_KEY.",
                }
            )
            yield _DONE
            return

        # 1. Optionally rewind history.
        if payload.replace_from_message_id:
            ok = await _delete_from(
                db, payload.session_id, payload.pane, payload.replace_from_message_id
            )
            if not ok:
                yield _sse({"error": "Target message not found"})
                yield _DONE
                return

        # 2. Optionally add a new user message.
        if payload.content is not None and payload.content.strip():
            db.add(
                Message(
                    session_id=payload.session_id,
                    pane=payload.pane,
                    role="user",
                    content=payload.content,
                )
            )
            if payload.pane == "main" and (
                not session.title or session.title == "新对话"
            ):
                session.title = _derive_title(payload.content)

        await db.commit()

        history = await _load_history(db, payload.session_id, payload.pane)

        if not history:
            yield _sse({"error": "Nothing to send to the model."})
            yield _DONE
            return

        full = ""
        client_alive = True
        cancelled = False

        try:
            try:
                async for delta in stream_chat(cfg, payload.pane, history):
                    full += delta
                    yield _sse({"content": delta})
            except asyncio.CancelledError:
                # Client disconnected (browser closed tab / aborted fetch).
                # The current task is being torn down — the DB connection
                # below us may already be gone, so we cannot commit here.
                # We hand off the partial save to a detached task.
                client_alive = False
                cancelled = True
                raise
            except Exception as exc:  # noqa: BLE001
                if client_alive:
                    yield _sse({"error": f"LLM error: {exc}"})
        finally:
            if cancelled:
                # Save on a fresh DB session that isn't part of the cancelled
                # task chain, so the partial assistant reply still lands.
                if full:
                    asyncio.ensure_future(
                        _save_partial(
                            payload.session_id, payload.pane, full
                        )
                    )
            else:
                if full:
                    db.add(
                        Message(
                            session_id=payload.session_id,
                            pane=payload.pane,
                            role="assistant",
                            content=full,
                        )
                    )
                session.updated_at = _utcnow()
                try:
                    await db.commit()
                except Exception:  # noqa: BLE001
                    pass

        if client_alive:
            yield _DONE


async def _save_partial(session_id: str, pane: str, content: str) -> None:
    """Persist a partially-streamed assistant message using a fresh DB
    session. Runs in a detached task so it survives the cancellation that
    triggered it."""
    try:
        async with AsyncSessionLocal() as db:
            session = await db.get(Session, session_id)
            if session is None:
                return
            db.add(
                Message(
                    session_id=session_id,
                    pane=pane,
                    role="assistant",
                    content=content,
                )
            )
            session.updated_at = _utcnow()
            await db.commit()
    except Exception:  # noqa: BLE001
        pass


@router.post("/stream")
async def chat_stream(
    payload: ChatRequest, db: AsyncSession = Depends(get_db)
) -> StreamingResponse:
    session = await db.get(Session, payload.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if payload.content is None and payload.replace_from_message_id is None:
        raise HTTPException(
            status_code=400,
            detail="Either `content` or `replace_from_message_id` must be set.",
        )

    return StreamingResponse(
        _event_source(payload),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
