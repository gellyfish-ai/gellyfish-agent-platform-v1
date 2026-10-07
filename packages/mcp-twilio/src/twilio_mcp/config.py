"""Configuration helpers for the Twilio SMS MCP server."""

from __future__ import annotations

import logging
import os
import sys
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"
E164_PATTERN = r"^\+[1-9]\d{7,14}$"


def _load_environment() -> Path | None:
    env_file = os.getenv("TWILIO_ENV_FILE")
    if env_file:
        candidates = [Path(env_file)]
    else:
        # Gellyfish: check the secure credential file first (owned by admin user),
        # then fall back to standard locations
        candidates = [
            Path.home() / ".config" / "gellyfish" / "twilio.env",  # secure (admin user home)
            Path.cwd() / ".env",
            DEFAULT_ENV_FILE,
        ]

    for candidate in candidates:
        if candidate.exists():
            load_dotenv(candidate, override=False)
            return candidate
    return None


LOADED_ENV_FILE = _load_environment()


def setup_logging(level: str = "INFO") -> None:
    """Configure structured logging for the whole application."""
    log_level = getattr(logging, level.upper(), logging.INFO)
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(log_level)
    # Avoid duplicate handlers on reload
    root.handlers = [handler]

    # Quiet noisy libraries
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


class Settings(BaseSettings):
    """Application settings loaded from the process environment."""

    model_config = SettingsConfigDict(populate_by_name=True, extra="ignore")

    account_sid: str = Field(..., alias="TWILIO_ACCOUNT_SID", pattern=r"^AC[0-9A-Fa-f]{32}$")
    auth_token: SecretStr = Field(..., alias="TWILIO_AUTH_TOKEN", min_length=1)
    from_number: str = Field(..., alias="TWILIO_FROM_NUMBER", pattern=E164_PATTERN)

    messaging_service_sid: str | None = Field(default=None, alias="TWILIO_MESSAGING_SERVICE_SID")
    webhook_auth_token: SecretStr | None = Field(default=None, alias="TWILIO_WEBHOOK_AUTH_TOKEN")
    public_webhook_base_url: str | None = Field(default=None, alias="TWILIO_PUBLIC_WEBHOOK_BASE_URL")
    validate_webhook_signatures: bool = Field(default=True, alias="TWILIO_VALIDATE_WEBHOOK_SIGNATURES")

    db_path: Path = Field(default=Path("inbox.db"), alias="TWILIO_DB_PATH")
    webhook_port: int = Field(default=8080, alias="WEBHOOK_PORT", ge=1, le=65535)
    bulk_send_concurrency: int = Field(default=10, alias="TWILIO_BULK_SEND_CONCURRENCY", ge=1, le=20)
    log_level: str = Field(default="INFO", alias="TWILIO_LOG_LEVEL")
    api_retry_attempts: int = Field(default=3, alias="TWILIO_API_RETRY_ATTEMPTS", ge=0, le=10)
    api_retry_delay: float = Field(default=1.0, alias="TWILIO_API_RETRY_DELAY", ge=0.1, le=30.0)

    # MCP transport settings
    mcp_transport: str = Field(default="stdio", alias="MCP_TRANSPORT")
    mcp_host: str = Field(default="0.0.0.0", alias="MCP_HOST")
    mcp_port: int = Field(default=8000, alias="MCP_PORT", ge=1, le=65535)

    @field_validator("messaging_service_sid", mode="before")
    @classmethod
    def _blank_service_sid_to_none(cls, value: object) -> object:
        if value in ("", None):
            return None
        return value

    @field_validator("messaging_service_sid")
    @classmethod
    def _validate_service_sid(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if not value.startswith("MG") or len(value) != 34:
            raise ValueError("TWILIO_MESSAGING_SERVICE_SID must start with 'MG' and contain 34 characters.")
        return value

    @field_validator("webhook_auth_token", mode="before")
    @classmethod
    def _blank_token_to_none(cls, value: object) -> object:
        if value in ("", None):
            return None
        return value

    @field_validator("public_webhook_base_url")
    @classmethod
    def _normalize_public_webhook_base_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        if not value.startswith(("http://", "https://")):
            raise ValueError("TWILIO_PUBLIC_WEBHOOK_BASE_URL must start with http:// or https://.")
        return value.rstrip("/")

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, value: str) -> str:
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        normalized = value.upper()
        if normalized not in allowed:
            raise ValueError(f"log_level must be one of {allowed}")
        return normalized

    @field_validator("mcp_transport")
    @classmethod
    def _validate_mcp_transport(cls, value: str) -> str:
        allowed = {"stdio", "sse", "http"}
        normalized = value.lower()
        if normalized not in allowed:
            raise ValueError(f"MCP_TRANSPORT must be one of {allowed}")
        return normalized

    @property
    def effective_webhook_auth_token(self) -> str:
        if self.webhook_auth_token is not None:
            return self.webhook_auth_token.get_secret_value()
        return self.auth_token.get_secret_value()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
