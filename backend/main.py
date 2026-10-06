from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .database import init_db
from .routers import chat, sessions, settings
from .services.config_store import ConfigStoreError, ensure_config_file


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_config_file()
    await init_db()
    try:
        yield
    finally:
        await chat.shutdown_generations()


app = FastAPI(title="billm", lifespan=lifespan)


@app.exception_handler(ConfigStoreError)
async def config_store_error_handler(
    _request: Request, exc: ConfigStoreError
) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={"detail": f"配置文件无效：{exc}"},
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions.router)
app.include_router(chat.router)
app.include_router(settings.router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
