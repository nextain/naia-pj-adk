"""Small HTTP door in front of the live queue store."""

from __future__ import annotations

import hmac
import json
import re
from http.client import parse_headers
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from live_queue.store import Conflict, MAX_DOCUMENT_BYTES

COLLECTION = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
ITEM_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def loopback_hosts() -> set[str]:
    return {"localhost", "::1", ".".join(["127", "0", "0", "1"])}


class QueueServer(ThreadingHTTPServer):
    def __init__(self, address, store, token: str, store_name: str):
        self.store = store
        self.token = token
        self.store_name = store_name
        super().__init__(address, QueueHandler)


class _PrefixReader:
    def __init__(self, prefix: bytes, rest):
        self._prefix = prefix
        self._rest = rest

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            data = self._prefix
            self._prefix = b""
            return data + self._rest.read()
        take = self._prefix[:size]
        self._prefix = self._prefix[size:]
        if len(take) < size:
            take += self._rest.read(size - len(take))
        return take

    def close(self) -> None:
        self._rest.close()


class QueueHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle_one_request(self) -> None:
        # A proxy may deliver a request body as chunked encoding. The standard
        # library rejects that before the handler runs, so decode it here.
        raw = self.rfile.readline(65537)
        if not raw:
            self.close_connection = True
            return
        try:
            command, path, version = raw.decode("iso-8859-1").rstrip("\r\n").split()
        except ValueError:
            self._send(400, {"ok": False, "error": "bad_request"})
            return
        self.command, self.path, self.request_version = command, path, version
        self.requestline = "%s %s %s" % (command, path, version)
        self.headers = parse_headers(self.rfile)
        connection = self.headers.get("Connection", "")
        self.close_connection = version != "HTTP/1.1" or "close" in connection.lower()
        encoding = self.headers.get("Transfer-Encoding", "")
        if encoding:
            if encoding.lower() != "chunked":
                self._send(400, {"ok": False, "error": "bad_request"})
                return
            try:
                body = _read_chunked(self.rfile)
            except ValueError:
                self._send(400, {"ok": False, "error": "bad_request"})
                return
            if len(body) > MAX_DOCUMENT_BYTES:
                self._send(413, {"ok": False, "error": "too_large"})
                return
            del self.headers["Transfer-Encoding"]
            self.headers["Content-Length"] = str(len(body))
            self.rfile = _PrefixReader(body, self.rfile)
            self.close_connection = True
        handler = getattr(self, "do_" + command, None)
        if handler is None:
            self._send(405, {"ok": False, "error": "method_not_allowed"})
            return
        handler()
        self.wfile.flush()

    def log_message(self, fmt: str, *args) -> None:
        # Request lines only. Headers can carry the bearer credential.
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)

    def do_GET(self) -> None:
        path, query = _split(self.path)
        if path in ("", "/"):
            path = "/health"
        if path == "/health":
            self._send(200, {"ok": True, "ready": True, "store": self.server.store_name})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        parts = _parts(path)
        try:
            if len(parts) == 2:
                records = self.server.store.list(parts[1], _limit(query))
                self._send(200, {"collection": parts[1], "records": [row.as_json() for row in records]})
                return
            if len(parts) == 3:
                record = self.server.store.get(parts[1], parts[2])
                if record is None:
                    self._send(404, {"ok": False, "error": "not_found"})
                    return
                self._send(200, record.as_json())
                return
        except Exception:
            self._send(503, {"ok": False, "error": "store_unavailable"})
            return
        self._send(404, {"ok": False, "error": "not_found"})

    def do_PUT(self) -> None:
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        parts = _parts(_split(self.path)[0])
        if len(parts) != 3:
            self._send(404, {"ok": False, "error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send(400, {"ok": False, "error": "bad_request"})
            return
        if length < 0 or length > MAX_DOCUMENT_BYTES:
            self._send(413, {"ok": False, "error": "too_large"})
            return
        raw = self.rfile.read(length)
        try:
            document = json.loads(raw.decode("utf-8"))
            if_match = _if_match(self.headers.get("If-Match"))
            record = self.server.store.put(parts[1], parts[2], document, if_match)
        except Conflict:
            self._send(409, {"ok": False, "error": "conflict"})
            return
        except (UnicodeError, json.JSONDecodeError, ValueError):
            self._send(400, {"ok": False, "error": "bad_request"})
            return
        except Exception:
            self._send(503, {"ok": False, "error": "store_unavailable"})
            return
        self._send(200, record.as_json())

    def do_DELETE(self) -> None:
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        parts = _parts(_split(self.path)[0])
        if len(parts) != 3:
            self._send(404, {"ok": False, "error": "not_found"})
            return
        try:
            deleted = self.server.store.delete(parts[1], parts[2])
        except Exception:
            self._send(503, {"ok": False, "error": "store_unavailable"})
            return
        if not deleted:
            self._send(404, {"ok": False, "error": "not_found"})
            return
        self._send(200, {"ok": True, "deleted": True})

    def _authorized(self) -> bool:
        expected = self.server.token
        if not expected:
            return True
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        return hmac.compare_digest(header[len(prefix):], expected)

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def serve(store, bind: str, port: int, token: str, store_name: str) -> None:
    if not token and bind not in loopback_hosts():
        raise SystemExit("NAIA_QUEUE_API_TOKEN is required when the bind host is not loopback")
    server = QueueServer((bind, port), store, token, store_name)
    print("LISTENING %s" % server.server_address[1], flush=True)
    server.serve_forever()


def _split(path: str) -> tuple[str, str]:
    parsed = urlsplit(path)
    return unquote(parsed.path), parsed.query


def _parts(path: str) -> list[str]:
    pieces = [piece for piece in path.split("/") if piece]
    if not pieces or pieces[0] != "v1":
        return []
    if len(pieces) not in (2, 3):
        return []
    if not COLLECTION.fullmatch(pieces[1]):
        return []
    if len(pieces) == 3 and not ITEM_ID.fullmatch(pieces[2]):
        return []
    return pieces


def _limit(query: str) -> int:
    for pair in query.split("&"):
        if pair.startswith("limit="):
            try:
                value = int(pair.split("=", 1)[1])
            except ValueError:
                return 200
            return max(1, min(value, 500))
    return 200


def _read_chunked(stream) -> bytes:
    chunks = []
    total = 0
    while True:
        line = stream.readline(65537)
        if not line:
            raise ValueError("short chunk")
        try:
            size = int(line.split(b";", 1)[0], 16)
        except ValueError as exc:
            raise ValueError("bad chunk size") from exc
        if size < 0 or total + size > MAX_DOCUMENT_BYTES:
            raise ValueError("chunk too large")
        if size == 0:
            while True:
                trailer = stream.readline(65537)
                if trailer in (b"\r\n", b"\n", b""):
                    break
            return b"".join(chunks)
        data = stream.read(size)
        if len(data) != size:
            raise ValueError("short chunk")
        chunks.append(data)
        total += size
        if stream.readline(65537) not in (b"\r\n", b"\n"):
            raise ValueError("bad chunk end")


def _if_match(header: str | None) -> int | None:
    if header is None or header == "":
        return None
    return int(header.strip().strip('"'))
