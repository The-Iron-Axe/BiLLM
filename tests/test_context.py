import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.models import Base, Message, Session
from backend.routers import sessions as routes
from backend.schemas import ContextOptions, ContextPreviewRequest
from backend.services.config_store import EffectiveConfig
from backend.services.context import ContextBudgetError, build_context


def record(identifier, role, content):
    return {"id": identifier, "role": role, "content": content}


class ContextTests(unittest.TestCase):
    def test_selection_preserves_turn_boundaries_and_history(self):
        history = [record("orphan", "assistant", "leading orphan"),
                   record("u1", "user", "first"), record("a1", "assistant", "answer1"),
                   record("u2", "user", "second"), record("a2", "assistant", "answer2"),
                   record("u3", "user", "third")]
        original = copy.deepcopy(history)
        preview = build_context(history, "system", "unknown-model", ContextOptions(
            excluded_message_ids=["u2"], recent_turns=2, summary="background",
        ))
        self.assertEqual(["first", "answer1", "third"], [m["content"] for m in preview.messages[1:]])
        self.assertIn("background", preview.messages[0]["content"])
        self.assertEqual(3, preview.omitted_count)
        self.assertEqual(history, original)

    def test_budget_trims_complete_turns_once(self):
        history = [record("u1", "user", "u" * 70), record("a1", "assistant", "a" * 70),
                   record("u2", "user", "latest"), record("a2", "assistant", "answer")]
        with patch("backend.services.context.count_messages_tokens",
                   side_effect=lambda contents, model: sum(len(content) for content in contents)) as count:
            preview = build_context(history, "system", "model", ContextOptions(max_context_tokens=128))
        self.assertEqual(["system", "latest", "answer"], [m["content"] for m in preview.messages])
        self.assertEqual(2, preview.omitted_count)
        self.assertEqual(3, count.call_count, "each turn and system must be tokenized only once")

    def test_latest_turn_and_system_are_never_silently_truncated(self):
        with patch("backend.services.context.count_messages_tokens",
                   side_effect=lambda contents, model: sum(len(content) for content in contents)):
            with self.assertRaises(ContextBudgetError):
                build_context([record("u", "user", "x" * 200)], "system", "model",
                              ContextOptions(max_context_tokens=128))

    def test_assistant_exclusion_keeps_question(self):
        preview = build_context([record("u", "user", "question"), record("a", "assistant", "answer")],
                                "system", "model", ContextOptions(excluded_message_ids=["a"]))
        self.assertEqual(["question"], [m["content"] for m in preview.messages[1:]])
        self.assertEqual(1, preview.omitted_count)


class ContextEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{Path(self.tmp.name) / 'context.db'}")
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.cfg = EffectiveConfig("https://example.invalid/v1", "test-key", "main", "aux", "main-system", "aux-system")
        self.config_patch = patch.object(routes, "get_effective_config", AsyncMock(return_value=self.cfg))
        self.config_patch.start()
        async with self.factory() as db:
            session = Session(title="context")
            db.add(session)
            await db.flush()
            self.session_id = session.id
            db.add_all([Message(session_id=session.id, pane="main", role="user", content="main-question"),
                        Message(session_id=session.id, pane="aux", role="user", content="aux-question")])
            await db.commit()

    async def asyncTearDown(self):
        self.config_patch.stop()
        await self.engine.dispose()
        self.tmp.cleanup()

    async def test_preview_is_pane_isolated_and_includes_draft_without_persisting(self):
        async with self.factory() as db:
            preview = await routes.preview_context(self.session_id, ContextPreviewRequest(pane="main", draft="draft"), db)
            self.assertEqual(["main-system", "main-question", "draft"], [m["content"] for m in preview.messages])
            stored = list((await db.execute(select(Message))).scalars())
            self.assertEqual(2, len(stored))

    async def test_summary_is_bounded_and_does_not_mutate_messages(self):
        received = {}
        async def fake_stream(cfg, pane, messages, **kwargs):
            received.update(pane=pane, messages=messages, **kwargs)
            yield "condensed "
            yield "history"
        with patch.object(routes, "stream_chat", fake_stream):
            async with self.factory() as db:
                summary = await routes.summarize_context(self.session_id, ContextPreviewRequest(pane="aux"), db)
                self.assertEqual("condensed history", summary.summary)
                self.assertEqual(2, len(list((await db.execute(select(Message))).scalars())))
        self.assertEqual("aux", received["pane"])
        self.assertEqual(1024, received["max_output_tokens"])
        self.assertTrue(received["messages_are_complete"])
        self.assertNotIn("main-question", str(received["messages"]))

    async def test_summary_provider_error_leaves_history_unchanged(self):
        async def fail(*args, **kwargs):
            raise RuntimeError("offline")
            yield "unreachable"
        with patch.object(routes, "stream_chat", fail):
            async with self.factory() as db:
                with self.assertRaises(HTTPException) as caught:
                    await routes.summarize_context(self.session_id, ContextPreviewRequest(pane="main"), db)
                self.assertEqual(502, caught.exception.status_code)
                self.assertEqual(2, len(list((await db.execute(select(Message))).scalars())))

    async def test_preview_missing_session_returns_404(self):
        async with self.factory() as db:
            with self.assertRaises(HTTPException) as caught:
                await routes.preview_context("missing", ContextPreviewRequest(pane="main"), db)
            self.assertEqual(404, caught.exception.status_code)

    async def test_http_preview_contract_and_summary_budget(self):
        app = FastAPI()
        app.include_router(routes.router)
        async def get_test_db():
            async with self.factory() as db:
                yield db
        app.dependency_overrides[routes.get_db] = get_test_db
        received = {}
        async def fake_stream(cfg, pane, messages, **kwargs):
            received["tokens"] = routes.count_messages_tokens((m["content"] for m in messages), pane) + 3
            yield "summary"
        with patch.object(routes, "stream_chat", fake_stream):
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post(f"/api/sessions/{self.session_id}/context/preview",
                                             json={"pane": "main", "draft": "new"})
                self.assertEqual(200, response.status_code)
                self.assertEqual(2, response.json()["message_count"])
                response = await client.post(f"/api/sessions/{self.session_id}/context/summary", json={
                    "pane": "main", "options": {"max_context_tokens": 256},
                })
                self.assertEqual(200, response.status_code, response.text)
                self.assertEqual("summary", response.json()["summary"])
                self.assertLessEqual(received["tokens"], 256)

    async def test_summary_disconnect_cancels_provider(self):
        import asyncio
        closed = asyncio.Event()
        started = asyncio.Event()
        class DisconnectedRequest:
            async def is_disconnected(self):
                await started.wait()
                return True
        async def fake_stream(*args, **kwargs):
            try:
                started.set()
                yield "partial"
                await asyncio.Event().wait()
            finally:
                closed.set()
        with patch.object(routes, "stream_chat", fake_stream):
            async with self.factory() as db:
                with self.assertRaises(HTTPException) as caught:
                    await routes.summarize_context(self.session_id, ContextPreviewRequest(pane="main"),
                                                   db, DisconnectedRequest())
                self.assertEqual(499, caught.exception.status_code)
                self.assertTrue(closed.is_set())


if __name__ == "__main__":
    unittest.main()
