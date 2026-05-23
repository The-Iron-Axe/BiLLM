from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parent.parent / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        protected_namespaces=("settings_",),
    )

    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    model_main: str = "gpt-4o"
    model_aux: str = "gpt-4o-mini"
    database_url: str = "sqlite+aiosqlite:///./billm.db"


settings = Settings()
