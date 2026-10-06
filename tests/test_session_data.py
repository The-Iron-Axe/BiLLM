import json
import tempfile
import unittest
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.models import Base, Message, Session
from backend.routers.sessions import (
    delete_all_sessions,
    export_all_sessions,
    export_session_markdown,
    import_sessions,
    search_sessions,
)
from backend.schemas import BackupImport


class SessionDataTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = create_async_engine(
            f"sqlite+aiosqlite:///{Path(self.tmp.name) / 'test.db'}"
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)

    async def asyncTearDown(self) -> None:
        await self.engine.dispose()
        self.tmp.cleanup()

    async def test_export_import_search_and_markdown(self) -> None:
        async with self.sessions() as db:
            session = Session(title="SQLite 研究")
            db.add(session)
            await db.flush()
            db.add_all(
                [
                    Message(
                        session_id=session.id,
                        pane="main",
                        role="user",
                        content="请研究 SQLite 外键约束",
                    ),
                    Message(
                        session_id=session.id,
                        pane="aux",
                        role="assistant",
                        content="SQLite 默认不启用外键。",
                    ),
                ]
            )
            await db.commit()

            matches = await search_sessions("外键", db)
            self.assertEqual(2, len(matches.results))
            self.assertTrue(all(match.message_id for match in matches.results))

            exported = await export_all_sessions(db)
            backup = json.loads(exported.body)
            imported = await import_sessions(BackupImport.model_validate(backup), db)
            self.assertEqual(1, imported.imported_sessions)
            self.assertEqual(2, imported.imported_messages)

            markdown = await export_session_markdown(session.id, db)
            self.assertIn("SQLite 研究", markdown.body.decode())
            self.assertIn("主助手", markdown.body.decode())

    async def test_clear_all_removes_messages_and_sessions(self) -> None:
        async with self.sessions() as db:
            session = Session()
            db.add(session)
            await db.flush()
            db.add(
                Message(
                    session_id=session.id,
                    pane="main",
                    role="user",
                    content="test",
                )
            )
            await db.commit()

            await delete_all_sessions(db)
            session_count = await db.scalar(select(func.count()).select_from(Session))
            message_count = await db.scalar(select(func.count()).select_from(Message))
            self.assertEqual(0, session_count)
            self.assertEqual(0, message_count)


if __name__ == "__main__":
    unittest.main()
