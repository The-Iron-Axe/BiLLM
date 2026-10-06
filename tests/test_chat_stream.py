import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.models import Base, Message, Session
from backend.routers import chat
from backend.schemas import ChatRequest, ContextOptions
from backend.services.config_store import EffectiveConfig
from backend.services import llm
from backend.services.tokens import count_tokens


class ChatStreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{Path(self.tmp.name) / 'chat.db'}")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.config = EffectiveConfig(
            api_base_url="http://provider.invalid", api_key="test-key",
            model_main="test", model_aux="test", system_prompt_main="Main", system_prompt_aux="Aux",
        )
        self.factory_patch = patch.object(chat, "AsyncSessionLocal", self.sessions)
        self.factory_patch.start()
        self.config_patch = patch.object(chat, "get_effective_config", AsyncMock(return_value=self.config))
        self.config_patch.start()
        async with self.sessions() as db:
            session = Session(title="Original")
            db.add(session)
            await db.flush()
            self.session_id = session.id
            self.original_user = Message(session_id=session.id, pane="main", role="user", content="Question")
            self.original_answer = Message(session_id=session.id, pane="main", role="assistant", content="Original answer")
            self.later_user = Message(session_id=session.id, pane="main", role="user", content="Later question")
            self.aux_answer = Message(session_id=session.id, pane="aux", role="assistant", content="Aux context")
            db.add_all([self.original_user, self.original_answer, self.later_user, self.aux_answer])
            await db.commit()

    async def asyncTearDown(self) -> None:
        await chat.shutdown_generations()
        self.config_patch.stop()
        self.factory_patch.stop()
        await self.engine.dispose()
        self.tmp.cleanup()

    async def start(self, **kwargs):
        payload = ChatRequest(session_id=self.session_id, pane=kwargs.pop("pane", "main"), **kwargs)
        async with self.sessions() as db:
            response = await chat.chat_stream(payload, db)
        state = chat._requests[response.headers["x-request-id"]]
        return response, state

    async def collect(self, response) -> list[dict]:
        events = []
        async for raw in response.body_iterator:
            for line in raw.decode().splitlines():
                if line.startswith("data: ") and line != "data: [DONE]":
                    events.append(json.loads(line[6:]))
        return events

    async def history(self, session_id=None, pane="main") -> list[Message]:
        async with self.sessions() as db:
            return await chat._load_history(db, session_id or self.session_id, pane)

    async def test_provider_failure_preserves_original_answer_and_tail(self) -> None:
        async def fail(*_args, **_kwargs):
            raise RuntimeError("provider unavailable")
            yield  # This is an async iterator even when it immediately fails.

        with patch.object(chat, "stream_chat", fail):
            response, state = await self.start(replace_from_message_id=self.original_answer.id)
            with self.assertLogs(chat.logger, level="ERROR"):
                events = await self.collect(response)
        self.assertEqual("failed", state.status)
        self.assertFalse(events[-1]["saved"])
        self.assertIn("error", events[-1])
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history()])

    async def test_successful_replacement_atomically_archives_old_version(self) -> None:
        provider_history = []

        async def succeed(_cfg, _pane, history, **kwargs):
            provider_history.extend(history)
            self.assertTrue(kwargs["messages_are_complete"])
            yield "New answer"

        with patch.object(chat, "stream_chat", succeed):
            response, state = await self.start(replace_from_message_id=self.original_answer.id)
            events = await self.collect(response)
        self.assertTrue(events[-1]["saved"])
        self.assertEqual(["Main", "Question"], [message["content"] for message in provider_history])
        self.assertEqual(["Question", "New answer"], [m.content for m in await self.history()])
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history(state.branch_id)])
        self.assertEqual(["Aux context"], [m.content for m in await self.history(state.branch_id, "aux")])
        async with self.sessions() as db:
            self.assertIn("修改前", (await db.get(Session, state.branch_id)).title)

    async def test_commit_failure_reports_unsaved_and_rolls_back_replacement(self) -> None:
        class FailingSession(AsyncSession):
            async def commit(self):
                raise RuntimeError("disk full")

        failing_factory = async_sessionmaker(self.engine, class_=FailingSession, expire_on_commit=False)

        async def succeed(*_args, **_kwargs):
            yield "New answer"

        with patch.object(chat, "stream_chat", succeed), patch.object(chat, "AsyncSessionLocal", failing_factory):
            response, state = await self.start(replace_from_message_id=self.original_answer.id)
            with self.assertLogs(chat.logger, level="ERROR"):
                events = await self.collect(response)
        self.assertFalse(state.saved)
        self.assertFalse(events[-1]["saved"])
        self.assertIn("保存失败", events[-1]["error"])
        self.assertIsNone(state.branch_id)
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history()])
        async with self.sessions() as db:
            self.assertEqual(1, len(list((await db.execute(select(Session))).scalars())))

    async def test_explicit_stop_saves_partial_once_and_closes_provider(self) -> None:
        emitted, closed = asyncio.Event(), asyncio.Event()

        async def wait_after_delta(*_args, **_kwargs):
            try:
                yield "Partial answer"
                emitted.set()
                await asyncio.Event().wait()
            finally:
                closed.set()

        with patch.object(chat, "stream_chat", wait_after_delta):
            response, state = await self.start(content="New question")
            await asyncio.wait_for(emitted.wait(), 2)
            result = await chat.stop_generation(state.request_id)
            second = await chat.stop_generation(state.request_id)
            events = await self.collect(response)
        self.assertTrue(closed.is_set())
        self.assertEqual("stopped", result["status"])
        self.assertTrue(result["saved"])
        self.assertEqual(result, second)
        self.assertEqual(result, await chat.generation_status(state.request_id))
        self.assertTrue(events[-1]["saved"])
        history = await self.history()
        self.assertEqual(1, sum(message.content == "Partial answer" for message in history))
        self.assertEqual(["New question", "Partial answer"], [m.content for m in history[-2:]])

    async def test_stopped_replacement_puts_partial_in_branch_without_erasing_original(self) -> None:
        emitted = asyncio.Event()

        async def wait_after_delta(*_args, **_kwargs):
            yield "Partial replacement"
            emitted.set()
            await asyncio.Event().wait()

        with patch.object(chat, "stream_chat", wait_after_delta):
            response, state = await self.start(replace_from_message_id=self.original_answer.id)
            await asyncio.wait_for(emitted.wait(), 2)
            result = await chat.stop_generation(state.request_id)
            await self.collect(response)
        self.assertTrue(result["saved"])
        self.assertIn("branch_id", result)
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history()])
        self.assertEqual(["Question", "Partial replacement"], [m.content for m in await self.history(result["branch_id"])])

    async def test_stream_disconnect_persists_partial_before_worker_finishes(self) -> None:
        async def wait_after_delta(*_args, **_kwargs):
            yield "Disconnected partial"
            await asyncio.Event().wait()

        with patch.object(chat, "stream_chat", wait_after_delta):
            response, state = await self.start(content="Question before disconnect")
            await anext(response.body_iterator)
            await response.body_iterator.aclose()
            await asyncio.wait_for(asyncio.shield(state.task), 2)
        self.assertEqual("stopped", state.status)
        self.assertTrue(state.saved)
        self.assertEqual("Disconnected partial", (await self.history())[-1].content)

    async def test_same_pane_and_duplicate_request_id_are_rejected(self) -> None:
        async def wait_provider(*_args, **_kwargs):
            await asyncio.Event().wait()
            yield "never"

        with patch.object(chat, "stream_chat", wait_provider):
            _, first = await self.start(content="First", request_id="unique-request")
            with self.assertRaises(HTTPException) as duplicate_pane:
                await self.start(content="Second")
            self.assertEqual(409, duplicate_pane.exception.status_code)
            async with self.sessions() as db:
                with self.assertRaises(HTTPException) as duplicate_id:
                    await chat.chat_stream(ChatRequest(session_id=self.session_id, pane="aux", content="Aux", request_id="unique-request"), db)
                self.assertEqual(409, duplicate_id.exception.status_code)
                aux_response = await chat.chat_stream(ChatRequest(session_id=self.session_id, pane="aux", content="Allowed auxiliary"), db)
            auxiliary = chat._requests[aux_response.headers["x-request-id"]]
            await chat.stop_generation(first.request_id)
            await chat.stop_generation(auxiliary.request_id)

    async def test_simultaneous_pane_completions_both_save_and_keep_histories_separate(self) -> None:
        barrier = asyncio.Barrier(2)
        provider_histories = {}

        async def finish_together(_cfg, pane, messages, **_kwargs):
            provider_histories[pane] = [message["content"] for message in messages]
            await asyncio.wait_for(barrier.wait(), 2)
            yield f"Answer from {pane}"

        with patch.object(chat, "stream_chat", finish_together):
            main_response, main = await self.start(content="Shared comparison question")
            aux_response, aux = await self.start(pane="aux", content="Shared comparison question")
            main_events, aux_events = await asyncio.gather(self.collect(main_response), self.collect(aux_response))

        self.assertEqual("saved", main.status)
        self.assertEqual("saved", aux.status)
        self.assertTrue(main.saved and aux.saved)
        self.assertEqual("Main", provider_histories["main"][0])
        self.assertEqual("Aux", provider_histories["aux"][0])
        self.assertIn("Original answer", provider_histories["main"])
        self.assertNotIn("Original answer", provider_histories["aux"])
        self.assertNotIn("Aux context", provider_histories["main"])
        self.assertEqual("Shared comparison question", provider_histories["main"][-1])
        self.assertEqual("Shared comparison question", provider_histories["aux"][-1])
        self.assertEqual(["Shared comparison question", "Answer from main"], [message.content for message in (await self.history())[-2:]])
        self.assertEqual(["Aux context", "Shared comparison question", "Answer from aux"], [message.content for message in await self.history(pane="aux")])
        for pane, state, events in [("main", main, main_events), ("aux", aux, aux_events)]:
            self.assertTrue(events[-1]["saved"])
            self.assertEqual(state.message_id, events[-1]["message_id"])
            self.assertEqual(self.session_id, events[-1]["session_id"])
            self.assertGreater(events[-1]["input_tokens_estimate"], 0)
            self.assertEqual(count_tokens(f"Answer from {pane}", "test"), events[-1]["output_tokens_estimate"])
        self.assertNotEqual(main.message_id, aux.message_id)

    async def test_one_comparison_provider_failure_does_not_stop_other_pane(self) -> None:
        barrier = asyncio.Barrier(2)

        async def finish_together(_cfg, pane, _messages, **_kwargs):
            await asyncio.wait_for(barrier.wait(), 2)
            if pane == "main":
                raise RuntimeError("main provider failed")
            yield "Successful auxiliary answer"

        with patch.object(chat, "stream_chat", finish_together):
            main_response, main = await self.start(content="Shared comparison question")
            aux_response, aux = await self.start(pane="aux", content="Shared comparison question")
            with self.assertLogs(chat.logger, level="ERROR"):
                main_events, aux_events = await asyncio.gather(self.collect(main_response), self.collect(aux_response))

        self.assertEqual("failed", main.status)
        self.assertIsNone(main.message_id)
        self.assertIn("error", main_events[-1])
        self.assertEqual(0, main_events[-1]["output_tokens_estimate"])
        self.assertEqual("saved", aux.status)
        self.assertTrue(aux.saved)
        self.assertNotIn("error", aux_events[-1])
        self.assertGreater(aux_events[-1]["input_tokens_estimate"], 0)
        self.assertEqual(count_tokens("Successful auxiliary answer", "test"), aux_events[-1]["output_tokens_estimate"])
        self.assertEqual(["Question", "Original answer", "Later question", "Shared comparison question"], [message.content for message in await self.history()])
        self.assertEqual(["Aux context", "Shared comparison question", "Successful auxiliary answer"], [message.content for message in await self.history(pane="aux")])

    async def test_history_changes_during_generation_are_not_overwritten(self) -> None:
        emitted, proceed = asyncio.Event(), asyncio.Event()

        async def wait_provider(*_args, **_kwargs):
            emitted.set()
            await proceed.wait()
            yield "Replacement"

        with patch.object(chat, "stream_chat", wait_provider):
            response, state = await self.start(replace_from_message_id=self.original_answer.id)
            await asyncio.wait_for(emitted.wait(), 2)
            async with self.sessions() as db:
                message = await db.get(Message, self.later_user.id)
                message.content = "Changed elsewhere"
                await db.commit()
            proceed.set()
            with self.assertLogs(chat.logger, level="ERROR"):
                await self.collect(response)
        self.assertFalse(state.saved)
        self.assertIn("内容已改变", state.error)
        self.assertEqual(["Question", "Original answer", "Changed elsewhere"], [m.content for m in await self.history()])

    async def test_context_options_and_output_limit_reach_provider(self) -> None:
        self.config.max_output_tokens_main = 64
        provider_messages = []

        async def succeed(_cfg, _pane, messages, **kwargs):
            provider_messages.extend(messages)
            self.assertEqual(64, kwargs["max_output_tokens"])
            yield "Limited answer"

        with patch.object(chat, "stream_chat", succeed):
            response, state = await self.start(content="Latest question", context_options=ContextOptions(recent_turns=1, summary="Keep this fact"))
            await self.collect(response)
        self.assertTrue(state.saved)
        self.assertIn("Keep this fact", provider_messages[0]["content"])
        self.assertEqual("Latest question", provider_messages[-1]["content"])
        self.assertNotIn("Original answer", [message["content"] for message in provider_messages])

    async def test_edit_failure_preserves_original_user_and_answer(self) -> None:
        async def fail(*_args, **_kwargs):
            raise RuntimeError("provider unavailable")
            yield

        with patch.object(chat, "stream_chat", fail):
            response, state = await self.start(content="Edited question", replace_from_message_id=self.original_user.id)
            with self.assertLogs(chat.logger, level="ERROR"):
                await self.collect(response)
        self.assertFalse(state.saved)
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history()])

    async def test_excluding_all_user_context_rejects_without_provider_or_data_change(self) -> None:
        provider = AsyncMock()
        with patch.object(chat, "stream_chat", provider):
            response, state = await self.start(
                replace_from_message_id=self.original_answer.id,
                context_options=ContextOptions(excluded_message_ids=[self.original_user.id]),
            )
            await self.collect(response)
        provider.assert_not_called()
        self.assertFalse(state.saved)
        self.assertIn("上下文排除", state.error)
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history()])

    async def test_partial_provider_failure_keeps_original_and_saves_candidate_branch(self) -> None:
        async def fail_after_delta(*_args, **_kwargs):
            yield "Useful partial"
            raise RuntimeError("provider failed midway")

        with patch.object(chat, "stream_chat", fail_after_delta):
            response, state = await self.start(content="Edited question", replace_from_message_id=self.original_user.id)
            with self.assertLogs(chat.logger, level="ERROR"):
                events = await self.collect(response)
        self.assertEqual("failed", state.status)
        self.assertTrue(state.saved)
        self.assertEqual(state.branch_id, events[-1]["session_id"])
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history()])
        self.assertEqual(["Edited question", "Useful partial"], [m.content for m in await self.history(state.branch_id)])

    async def test_successful_edit_archives_original_and_replaces_user_tail(self) -> None:
        async def succeed(_cfg, _pane, messages, **_kwargs):
            self.assertEqual("Edited question", messages[-1]["content"])
            self.assertNotIn("Original answer", [message["content"] for message in messages])
            yield "Answer to edited question"

        with patch.object(chat, "stream_chat", succeed):
            response, state = await self.start(content="Edited question", replace_from_message_id=self.original_user.id)
            await self.collect(response)
        self.assertTrue(state.saved)
        self.assertEqual(["Edited question", "Answer to edited question"], [m.content for m in await self.history()])
        self.assertEqual(["Question", "Original answer", "Later question"], [m.content for m in await self.history(state.branch_id)])

    async def test_shutdown_drains_generation_and_saves_partial(self) -> None:
        emitted, closed = asyncio.Event(), asyncio.Event()

        async def wait_after_delta(*_args, **_kwargs):
            try:
                yield "Shutdown partial"
                emitted.set()
                await asyncio.Event().wait()
            finally:
                closed.set()

        with patch.object(chat, "stream_chat", wait_after_delta):
            _, state = await self.start(content="Shutdown question")
            await asyncio.wait_for(emitted.wait(), 2)
            await chat.shutdown_generations()
        self.assertTrue(closed.is_set())
        self.assertTrue(state.task.done())
        self.assertTrue(state.saved)
        self.assertEqual("Shutdown partial", (await self.history())[-1].content)
        self.assertFalse(chat._requests)
        self.assertFalse(chat._workers)


class ProviderResourceTests(unittest.IsolatedAsyncioTestCase):
    def config(self):
        return EffectiveConfig(
            api_base_url="http://provider.invalid", api_key="test-key",
            model_main="test", model_aux="test", system_prompt_main="Main", system_prompt_aux="Aux",
        )

    def mock_client(self):
        class FakeStream:
            close = AsyncMock()

            def __init__(self):
                self.close = AsyncMock()
                self.sent = False

            def __aiter__(self):
                return self

            async def __anext__(self):
                if self.sent:
                    raise StopAsyncIteration
                self.sent = True
                return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Text"))])

        stream = FakeStream()
        create = AsyncMock(return_value=stream)
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)), close=AsyncMock())
        return client, stream

    async def test_early_close_releases_stream_and_client(self):
        client, stream = self.mock_client()
        with patch.object(llm, "_client", return_value=client):
            generator = llm.stream_chat(self.config(), "main", [{"role": "user", "content": "Question"}])
            self.assertEqual("Text", await anext(generator))
            await generator.aclose()
        stream.close.assert_awaited_once()
        client.close.assert_awaited_once()
        self.assertNotIn("max_tokens", client.chat.completions.create.call_args.kwargs)

    async def test_complete_context_and_output_limit_are_forwarded_once(self):
        client, stream = self.mock_client()
        messages = [{"role": "system", "content": "Main plus summary"}, {"role": "user", "content": "Question"}]
        with patch.object(llm, "_client", return_value=client):
            output = [delta async for delta in llm.stream_chat(self.config(), "main", messages, messages_are_complete=True, max_output_tokens=64)]
        self.assertEqual(["Text"], output)
        self.assertEqual(messages, client.chat.completions.create.call_args.kwargs["messages"])
        self.assertEqual(64, client.chat.completions.create.call_args.kwargs["max_tokens"])
        stream.close.assert_awaited_once()
        client.close.assert_awaited_once()

    async def test_create_failure_still_closes_client(self):
        client, stream = self.mock_client()
        client.chat.completions.create.side_effect = RuntimeError("create failed")
        with patch.object(llm, "_client", return_value=client):
            with self.assertRaises(RuntimeError):
                await anext(llm.stream_chat(self.config(), "main", []))
        client.close.assert_awaited_once()
        stream.close.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
