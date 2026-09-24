import json
import socket
import threading
import unittest
import urllib.error
import urllib.request

from live_queue.http_app import loopback_hosts
from live_queue.store import (
    DEFAULT_DATABASE_URL,
    Conflict,
    MemoryStore,
    database_url_from_env,
    open_store,
    replace_database_name,
)


class StoreTests(unittest.TestCase):
    def test_default_database_is_localhost(self):
        self.assertEqual(database_url_from_env({}), DEFAULT_DATABASE_URL)
        self.assertEqual(DEFAULT_DATABASE_URL, "postgresql://localhost:5432/naia_comm")

    def test_database_url_can_be_replaced(self):
        chosen = "postgresql://localhost:5432/other_queue"
        self.assertEqual(database_url_from_env({"NAIA_QUEUE_DATABASE_URL": chosen}), chosen)
        self.assertIsInstance(open_store("memory://"), MemoryStore)

    def test_replace_database_name_keeps_the_server(self):
        source = "postgresql://db.example:5432/any_llm_gateway_dev?sslmode=require"
        self.assertEqual(
            replace_database_name(source, "naia_comm"),
            "postgresql://db.example:5432/naia_comm?sslmode=require",
        )

    def test_revision_conflict_keeps_the_current_document(self):
        store = MemoryStore()
        first = store.put("items", "job-1", {"status": "waiting"}, None)
        with self.assertRaises(Conflict):
            store.put("items", "job-1", {"status": "lost"}, first.revision + 5)
        self.assertEqual(store.get("items", "job-1").document["status"], "waiting")
        second = store.put("items", "job-1", {"status": "claimed"}, first.revision)
        self.assertEqual(second.revision, 2)

    def test_document_must_be_an_object(self):
        store = MemoryStore()
        with self.assertRaises(ValueError):
            store.put("items", "job-1", ["nope"], None)


class HttpTests(unittest.TestCase):
    def test_round_trip_and_auth(self):
        store = MemoryStore()
        server = _start(store, "secret1")
        port = server.server_address[1]
        try:
            health = _json("GET", port, "/health")
            self.assertEqual(health["store"], "memory")
            self.assertTrue(health["ready"])
            with self.assertRaises(urllib.error.HTTPError) as missing:
                _json("PUT", port, "/v1/items/job-1", {"status": "waiting"})
            self.assertEqual(missing.exception.code, 401)
            saved = _json(
                "PUT", port, "/v1/items/job-1", {"status": "waiting"},
                headers={"Authorization": "Bearer secret1"},
            )
            self.assertEqual(saved["revision"], 1)
            listed = _json("GET", port, "/v1/items", headers={"Authorization": "Bearer secret1"})
            self.assertEqual(listed["records"][0]["id"], "job-1")
            with self.assertRaises(urllib.error.HTTPError) as conflict:
                _json(
                    "PUT", port, "/v1/items/job-1", {"status": "other"},
                    headers={"Authorization": "Bearer secret1", "If-Match": "9"},
                )
            self.assertEqual(conflict.exception.code, 409)
            deleted = _json("DELETE", port, "/v1/items/job-1", headers={"Authorization": "Bearer secret1"})
            self.assertTrue(deleted["deleted"])
        finally:
            server.shutdown()

    def test_chunked_put_is_stored(self):
        server = _start(MemoryStore(), "secret1")
        port = server.server_address[1]
        body = b'{"status":"waiting"}'
        chunk = b"PUT /v1/items/job-9 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer secret1\r\nTransfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\n0\r\n\r\n" % (len(body), body)
        try:
            with socket.create_connection(("localhost", port), timeout=5) as sock:
                sock.sendall(chunk)
                raw = b""
                while b"\r\n\r\n" not in raw:
                    raw += sock.recv(4096)
                header, _, rest = raw.partition(b"\r\n\r\n")
                length = 0
                for line in header.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":", 1)[1].strip())
                while len(rest) < length:
                    rest += sock.recv(4096)
            payload = json.loads(rest[:length].decode())
            self.assertEqual(payload["document"]["status"], "waiting")
            self.assertTrue(header.startswith(b"HTTP/1.1 200"))
        finally:
            server.shutdown()

    def test_non_loopback_without_a_credential_is_refused(self):
        from live_queue.http_app import serve as serve_app

        bind = ".".join(["10", "0", "0", "1"])
        self.assertNotIn(bind, loopback_hosts())
        with self.assertRaises(SystemExit):
            serve_app(MemoryStore(), bind, 0, "", "memory")


def _start(store, token):
    from live_queue.http_app import QueueServer

    server = QueueServer(("localhost", 0), store, token, "memory")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def _json(method, port, path, payload=None, headers=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        "http://localhost:%s%s" % (port, path),
        data=data,
        method=method,
        headers=headers or {},
    )
    if data is not None:
        request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
