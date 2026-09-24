import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { baseUrlFromEnv, deleteRecord, getRecord, putRecord } from "./client.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the client defaults to the localhost server and can replace that base URL", () => {
  assert.equal(baseUrlFromEnv({}), "http://localhost:8096");
  assert.equal(baseUrlFromEnv({ NAIA_QUEUE_BASE_URL: "http://localhost:9000/" }), "http://localhost:9000");
});

test("a caller reads back the document it wrote", async () => {
  const server = await startServer();
  try {
    const saved = await putRecord({
      baseUrl: server.baseUrl,
      token: "secret1",
      collection: "items",
      id: "job-7",
      document: { status: "waiting", device: "win-rtx2070" },
    });
    assert.equal(saved.revision, 1);
    const loaded = await getRecord({
      baseUrl: server.baseUrl,
      token: "secret1",
      collection: "items",
      id: "job-7",
    });
    assert.equal(loaded.document.device, "win-rtx2070");
    await deleteRecord({
      baseUrl: server.baseUrl,
      token: "secret1",
      collection: "items",
      id: "job-7",
    });
    await assert.rejects(
      () => getRecord({ baseUrl: server.baseUrl, token: "secret1", collection: "items", id: "job-7" }),
      (error) => error.status === 404,
    );
  } finally {
    server.stop();
  }
});

function startServer() {
  const child = spawn("python3", ["-m", "live_queue", "serve"], {
    cwd: here,
    env: {
      ...process.env,
      PYTHONPATH: here,
      NAIA_QUEUE_DATABASE_URL: "memory://",
      NAIA_QUEUE_BIND: "localhost",
      NAIA_QUEUE_PORT: "0",
      NAIA_QUEUE_API_TOKEN: "secret1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("server did not listen")), 5000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(/LISTENING (\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({
        baseUrl: `http://localhost:${match[1]}`,
        stop() {
          child.kill();
        },
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}`));
    });
  });
}
