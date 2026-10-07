"""Launcher for the webhook HTTP server and the MCP server (stdio, SSE, or HTTP)."""

from __future__ import annotations

import logging
import threading

import uvicorn

from . import __version__
from .config import get_settings, setup_logging
from .store import init_db
from .webhook import app

logger = logging.getLogger(__name__)


def main() -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    logger.info("Twilio SMS MCP server v%s starting (transport=%s)", __version__, settings.mcp_transport)
    init_db()

    webhook_server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="0.0.0.0",
            port=settings.webhook_port,
            log_level=settings.log_level.lower(),
            access_log=False,
        )
    )
    threading.Thread(target=webhook_server.run, name="twilio-webhook", daemon=True).start()
    logger.info("Starting webhook server on 0.0.0.0:%d", settings.webhook_port)

    if settings.mcp_transport in ("sse", "http"):
        logger.info(
            "MCP %s server on %s:%d (endpoint: /mcp/)",
            settings.mcp_transport,
            settings.mcp_host,
            settings.mcp_port,
        )

    from .server import main as run_mcp_server

    run_mcp_server()


if __name__ == "__main__":
    main()
