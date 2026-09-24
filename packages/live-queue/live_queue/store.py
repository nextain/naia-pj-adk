"""Document collections stored in Postgres or in process memory."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

DEFAULT_DATABASE_URL = "postgresql://localhost:5432/naia_comm"
MAX_DOCUMENT_BYTES = 262144

SCHEMA = """
CREATE TABLE IF NOT EXISTS live_queue_records (
    collection text NOT NULL,
    id text NOT NULL,
    document jsonb NOT NULL,
    revision bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS live_queue_records_collection_updated
    ON live_queue_records (collection, updated_at DESC);
"""


class Conflict(Exception):
    """The caller's expected revision is not the current one."""


@dataclass(frozen=True)
class Record:
    collection: str
    id: str
    document: dict[str, Any]
    revision: int
    updated_at: str

    def as_json(self) -> dict[str, Any]:
        return {
            "collection": self.collection,
            "id": self.id,
            "document": self.document,
            "revision": self.revision,
            "updated_at": self.updated_at,
        }


def database_url_from_env(env: dict[str, str]) -> str:
    raw = env.get("NAIA_QUEUE_DATABASE_URL", "").strip()
    return raw or DEFAULT_DATABASE_URL


def open_store(url: str):
    if url == "memory://":
        return MemoryStore()
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        return PostgresStore(url)
    raise ValueError("NAIA_QUEUE_DATABASE_URL must be memory:// or a postgres URL")


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _check_document(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("document must be a JSON object")
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_DOCUMENT_BYTES:
        raise ValueError("document is too large")
    return document


class MemoryStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rows: dict[tuple[str, str], Record] = {}

    def put(self, collection: str, item_id: str, document: dict[str, Any], if_match: int | None) -> Record:
        document = _check_document(document)
        with self._lock:
            current = self._rows.get((collection, item_id))
            if if_match is not None and (current.revision if current else 0) != if_match:
                raise Conflict()
            revision = 1 if current is None else current.revision + 1
            record = Record(collection, item_id, document, revision, _now())
            self._rows[(collection, item_id)] = record
            return record

    def get(self, collection: str, item_id: str) -> Record | None:
        with self._lock:
            return self._rows.get((collection, item_id))

    def list(self, collection: str, limit: int) -> list[Record]:
        with self._lock:
            rows = [row for (name, _), row in self._rows.items() if name == collection]
        rows.sort(key=lambda row: row.updated_at, reverse=True)
        return rows[:limit]

    def delete(self, collection: str, item_id: str) -> bool:
        with self._lock:
            return self._rows.pop((collection, item_id), None) is not None


class PostgresStore:
    def __init__(self, url: str) -> None:
        self._url = url
        self._ready = False

    def ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(SCHEMA)
            conn.commit()
        self._ready = True

    def _connect(self):
        import psycopg

        return psycopg.connect(self._url, connect_timeout=5)

    def put(self, collection: str, item_id: str, document: dict[str, Any], if_match: int | None) -> Record:
        from psycopg.types.json import Json

        document = _check_document(document)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT revision FROM live_queue_records WHERE collection = %s AND id = %s FOR UPDATE",
                (collection, item_id),
            ).fetchone()
            current = int(row[0]) if row else 0
            if if_match is not None and current != if_match:
                conn.rollback()
                raise Conflict()
            if row is None:
                stored = conn.execute(
                    """
                    INSERT INTO live_queue_records (collection, id, document, revision, updated_at)
                    VALUES (%s, %s, %s, 1, now())
                    RETURNING revision, updated_at
                    """,
                    (collection, item_id, Json(document)),
                ).fetchone()
            else:
                stored = conn.execute(
                    """
                    UPDATE live_queue_records
                    SET document = %s, revision = revision + 1, updated_at = now()
                    WHERE collection = %s AND id = %s
                    RETURNING revision, updated_at
                    """,
                    (Json(document), collection, item_id),
                ).fetchone()
            conn.commit()
        return Record(collection, item_id, document, int(stored[0]), _stamp(stored[1]))

    def get(self, collection: str, item_id: str) -> Record | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT document, revision, updated_at
                FROM live_queue_records
                WHERE collection = %s AND id = %s
                """,
                (collection, item_id),
            ).fetchone()
        if row is None:
            return None
        return Record(collection, item_id, _object(row[0]), int(row[1]), _stamp(row[2]))

    def list(self, collection: str, limit: int) -> list[Record]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, document, revision, updated_at
                FROM live_queue_records
                WHERE collection = %s
                ORDER BY updated_at DESC
                LIMIT %s
                """,
                (collection, limit),
            ).fetchall()
        return [
            Record(collection, row[0], _object(row[1]), int(row[2]), _stamp(row[3]))
            for row in rows
        ]

    def delete(self, collection: str, item_id: str) -> bool:
        with self._connect() as conn:
            deleted = conn.execute(
                "DELETE FROM live_queue_records WHERE collection = %s AND id = %s",
                (collection, item_id),
            )
            conn.commit()
            return deleted.rowcount > 0


def replace_database_name(url: str, database: str) -> str:
    """Point a postgres URL at another database on the same server."""
    parts = urlsplit(url)
    if parts.scheme not in ("postgresql", "postgres") or not parts.path:
        raise ValueError("postgres URL is required")
    return urlunsplit((parts.scheme, parts.netloc, "/" + database, parts.query, ""))


def _object(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        parsed = json.loads(value)
    else:
        parsed = value
    if not isinstance(parsed, dict):
        raise ValueError("stored document is not an object")
    return parsed


def _stamp(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)
