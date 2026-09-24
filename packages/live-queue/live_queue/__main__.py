"""Run the live queue HTTP API."""

from __future__ import annotations

import os
import sys

from live_queue.http_app import serve
from live_queue.store import database_url_from_env, open_store


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if args != ["serve"]:
        raise SystemExit("usage: python -m live_queue serve")
    url = database_url_from_env(os.environ)
    store = open_store(url)
    if url != "memory://":
        store.ensure_schema()
    bind = os.environ.get("NAIA_QUEUE_BIND", "localhost").strip() or "localhost"
    port = int(os.environ.get("NAIA_QUEUE_PORT", "8096"))
    expected = os.environ.get("NAIA_QUEUE_API_TOKEN", "")
    store_name = "memory" if url == "memory://" else "postgres"
    serve(store, bind, port, expected, store_name)


if __name__ == "__main__":
    main()
