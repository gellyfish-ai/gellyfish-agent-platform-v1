"""SQLite store for inbound SMS and delivery status records."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from .config import get_settings


def _db_path() -> Path:
    path = get_settings().db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(), check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def init_db() -> None:
    """Create tables and indexes if they do not exist."""
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS inbox (
                sid           TEXT PRIMARY KEY,
                from_number   TEXT NOT NULL,
                to_number     TEXT NOT NULL,
                body          TEXT,
                num_media     INTEGER DEFAULT 0,
                media_urls    TEXT,
                received_at   TEXT NOT NULL,
                read          INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS delivery_status (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                sid           TEXT NOT NULL,
                status        TEXT NOT NULL,
                error_code    TEXT,
                updated_at    TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_inbox_from ON inbox(from_number);
            CREATE INDEX IF NOT EXISTS idx_inbox_ts ON inbox(received_at);
            CREATE INDEX IF NOT EXISTS idx_status_sid ON delivery_status(sid);
            """
        )


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def store_inbound(data: dict[str, str]) -> None:
    """Persist an inbound message from a Twilio webhook payload."""
    init_db()
    media_urls: list[str] = []
    num_media = int(data.get("NumMedia", 0))
    for index in range(num_media):
        media_url = data.get(f"MediaUrl{index}")
        if media_url:
            media_urls.append(media_url)

    with _conn() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO inbox
            (sid, from_number, to_number, body, num_media, media_urls, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("MessageSid", ""),
                data.get("From", ""),
                data.get("To", ""),
                data.get("Body", ""),
                num_media,
                json.dumps(media_urls),
                _timestamp(),
            ),
        )


def update_delivery_status(data: dict[str, str]) -> None:
    """Store a Twilio delivery status callback."""
    init_db()
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO delivery_status (sid, status, error_code, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                data.get("MessageSid", ""),
                data.get("MessageStatus", ""),
                data.get("ErrorCode", ""),
                _timestamp(),
            ),
        )


def _decode_row(row: sqlite3.Row) -> dict[str, object]:
    decoded = dict(row)
    decoded["media_urls"] = json.loads(decoded.get("media_urls") or "[]")
    decoded["read"] = bool(decoded.get("read", 0))
    return decoded


def get_inbox(
    from_number: str | None = None,
    unread_only: bool = False,
    limit: int = 20,
    offset: int = 0,
) -> list[dict[str, object]]:
    init_db()
    query = "SELECT * FROM inbox WHERE 1=1"
    params: list[object] = []

    if from_number:
        query += " AND from_number = ?"
        params.append(from_number)
    if unread_only:
        query += " AND read = 0"

    query += " ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?"
    params.extend([limit, offset])

    with _conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_decode_row(row) for row in rows]


def count_unread() -> int:
    init_db()
    with _conn() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM inbox WHERE read = 0").fetchone()[0])


def mark_read(sid: str) -> int:
    init_db()
    with _conn() as conn:
        cursor = conn.execute("UPDATE inbox SET read = 1 WHERE sid = ? AND read = 0", (sid,))
        return cursor.rowcount


def mark_all_read(from_number: str | None = None) -> int:
    init_db()
    with _conn() as conn:
        if from_number:
            cursor = conn.execute(
                "UPDATE inbox SET read = 1 WHERE from_number = ? AND read = 0",
                (from_number,),
            )
        else:
            cursor = conn.execute("UPDATE inbox SET read = 1 WHERE read = 0")
        return cursor.rowcount


def get_conversation(number: str, limit: int = 50) -> list[dict[str, object]]:
    init_db()
    with _conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM inbox
            WHERE from_number = ? OR to_number = ?
            ORDER BY received_at ASC
            LIMIT ?
            """,
            (number, number, limit),
        ).fetchall()
    return [_decode_row(row) for row in rows]


def get_read_statuses(sids: Iterable[str]) -> dict[str, bool]:
    init_db()
    unique_sids = sorted({sid for sid in sids if sid})
    if not unique_sids:
        return {}

    placeholders = ", ".join(["?"] * len(unique_sids))
    with _conn() as conn:
        rows = conn.execute(
            f"SELECT sid, read FROM inbox WHERE sid IN ({placeholders})",
            unique_sids,
        ).fetchall()
    return {row["sid"]: bool(row["read"]) for row in rows}


def get_latest_delivery_status(sid: str) -> dict[str, object] | None:
    init_db()
    with _conn() as conn:
        row = conn.execute(
            """
            SELECT sid, status, error_code, updated_at
            FROM delivery_status
            WHERE sid = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (sid,),
        ).fetchone()
    return dict(row) if row else None
