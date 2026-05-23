from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models import Message, Session, _utcnow
from ..schemas import (
    MessageListResponse,
    MessageOut,
    Pane,
    PaneStats,
    SessionCreate,
    SessionOut,
    SessionUpdate,
)
from ..services.config_store import get_effective_config
from ..services.tokens import count_messages_tokens

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


async def _pane_stats(
    db: AsyncSession, session_id: str, pane: Pane, model: str
) -> PaneStats:
    result = await db.execute(
        select(Message.content).where(
            Message.session_id == session_id, Message.pane == pane
        )
    )
    contents = [c for (c,) in result.all()]
    return PaneStats(
        message_count=len(contents),
        total_tokens=count_messages_tokens(contents, model=model),
    )


def _model_for_pane(pane: Pane, cfg) -> str:  # noqa: ANN001
    return cfg.model_main if pane == "main" else cfg.model_aux


@router.get("", response_model=list[SessionOut])
async def list_sessions(db: AsyncSession = Depends(get_db)) -> list[Session]:
    result = await db.execute(select(Session).order_by(Session.updated_at.desc()))
    return list(result.scalars().all())


@router.post("", response_model=SessionOut)
async def create_session(
    payload: SessionCreate, db: AsyncSession = Depends(get_db)
) -> Session:
    session = Session(title=payload.title or "新对话")
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return session


@router.patch("/{session_id}", response_model=SessionOut)
async def rename_session(
    session_id: str, payload: SessionUpdate, db: AsyncSession = Depends(get_db)
) -> Session:
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    session.title = payload.title
    await db.commit()
    await db.refresh(session)
    return session


@router.delete("/{session_id}", status_code=204, response_class=Response)
async def delete_session(session_id: str, db: AsyncSession = Depends(get_db)) -> Response:
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    await db.delete(session)
    await db.commit()
    return Response(status_code=204)


@router.get("/{session_id}/messages", response_model=MessageListResponse)
async def list_messages(
    session_id: str,
    pane: Pane = Query(...),
    db: AsyncSession = Depends(get_db),
) -> MessageListResponse:
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    result = await db.execute(
        select(Message)
        .where(Message.session_id == session_id, Message.pane == pane)
        .order_by(Message.created_at.asc())
    )
    msgs = list(result.scalars().all())
    cfg = await get_effective_config(db)
    contents = [m.content for m in msgs]
    stats = PaneStats(
        message_count=len(msgs),
        total_tokens=count_messages_tokens(contents, model=_model_for_pane(pane, cfg)),
    )
    return MessageListResponse(
        messages=[MessageOut.model_validate(m) for m in msgs],
        stats=stats,
    )


@router.get("/{session_id}/stats", response_model=PaneStats)
async def session_pane_stats(
    session_id: str,
    pane: Pane = Query(...),
    db: AsyncSession = Depends(get_db),
) -> PaneStats:
    session = await db.get(Session, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    cfg = await get_effective_config(db)
    return await _pane_stats(db, session_id, pane, _model_for_pane(pane, cfg))


@router.delete(
    "/{session_id}/messages/{message_id}",
    status_code=204,
    response_class=Response,
)
async def delete_message(
    session_id: str,
    message_id: str,
    db: AsyncSession = Depends(get_db),
) -> Response:
    msg = await db.get(Message, message_id)
    if msg is None or msg.session_id != session_id:
        raise HTTPException(status_code=404, detail="Message not found")
    await db.delete(msg)
    # Deleting a message counts as session activity, so bump the timestamp
    # to keep the sidebar sort order honest.
    session = await db.get(Session, session_id)
    if session is not None:
        session.updated_at = _utcnow()
    await db.commit()
    return Response(status_code=204)
