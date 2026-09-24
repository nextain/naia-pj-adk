"""Live document store for a team queue.

The database is the source of truth. Callers on other machines use the HTTP
API. The default database is Postgres on localhost and can be replaced by
setting NAIA_QUEUE_DATABASE_URL. memory:// keeps documents in the process
for tests.
"""

from live_queue.store import (
    DEFAULT_DATABASE_URL,
    Conflict,
    MemoryStore,
    Record,
    database_url_from_env,
    open_store,
)

__all__ = [
    "DEFAULT_DATABASE_URL",
    "Conflict",
    "MemoryStore",
    "Record",
    "database_url_from_env",
    "open_store",
]
