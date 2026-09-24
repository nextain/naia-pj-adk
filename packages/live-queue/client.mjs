// HTTP client for the live queue. The database stays behind the API.
// NAIA_QUEUE_BASE_URL defaults to the localhost server. A deployed server
// is selected by changing that variable. This file never opens Postgres.

const DEFAULT_BASE_URL = "http://localhost:8096";

export function baseUrlFromEnv(env = process.env) {
  const raw = String(env.NAIA_QUEUE_BASE_URL || "").trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export async function putRecord({ baseUrl, token, collection, id, document, ifMatch }) {
  return request("PUT", `${baseUrl}/v1/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, {
    token,
    ifMatch,
    body: document,
  });
}

export async function getRecord({ baseUrl, token, collection, id }) {
  return request("GET", `${baseUrl}/v1/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { token });
}

export async function listRecords({ baseUrl, token, collection }) {
  return request("GET", `${baseUrl}/v1/${encodeURIComponent(collection)}`, { token });
}

export async function deleteRecord({ baseUrl, token, collection, id }) {
  return request("DELETE", `${baseUrl}/v1/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, { token });
}

async function request(method, url, { token, ifMatch, body } = {}) {
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (ifMatch != null) headers["if-match"] = String(ifMatch);
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(url, { method, headers, body: payload });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(parsed.error || `http_${response.status}`);
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed;
}
