/** Shared model + version + auth + share client for CAD and 3D preview. */

const USER_KEY = "a15-user";
const MODEL_KEY = "a15-active-model";
const TOKEN_KEY = "a15-auth-token";
const FETCH_TIMEOUT_MS = 25000;

export function getUser() {
  try {
    return localStorage.getItem(USER_KEY) || "";
  } catch {
    return "";
  }
}

export function setUser(name) {
  const n = String(name || "").trim().slice(0, 64);
  try {
    if (n) localStorage.setItem(USER_KEY, n);
    else localStorage.removeItem(USER_KEY);
  } catch { /* */ }
  return n;
}

export function ensureUser() {
  let u = getUser();
  if (u) return u;
  u = setUser("local") || "local";
  return u;
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* */ }
}

export function getActiveModelId() {
  try {
    return localStorage.getItem(MODEL_KEY) || "";
  } catch {
    return "";
  }
}

export function setActiveModelId(id) {
  try {
    if (id) localStorage.setItem(MODEL_KEY, id);
    else localStorage.removeItem(MODEL_KEY);
  } catch { /* */ }
}

function headers(extra = {}) {
  const h = { ...extra };
  const u = getUser();
  if (u) h["X-User"] = u;
  const m = getActiveModelId();
  if (m) h["X-Model-Id"] = m;
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = "error", data = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function rawFetch(path, method, body, extraHeaders, signal) {
  const needsBody = body != null || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  return fetch(path, {
    cache: "no-store",
    signal,
    method,
    headers: {
      ...headers(extraHeaders || {}),
      ...(needsBody ? { "Content-Type": "application/json" } : {}),
    },
    body: body == null && (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE")
      ? "{}"
      : body,
  });
}

async function parseResponse(r) {
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    throw new ApiError(data?.error || text || r.statusText, {
      status: r.status,
      code: data?.code || "http_error",
      data,
    });
  }
  return data;
}

async function api(path, opts = {}) {
  const method = String(opts.method || "GET").toUpperCase();
  const needsOverride = method === "PUT" || method === "PATCH" || method === "DELETE";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout ?? FETCH_TIMEOUT_MS);
  const body = opts.body;
  const extraHeaders = opts.headers || {};
  delete opts.timeout;

  try {
    // Prefer native verbs (local Node). Fall back to POST + override for IIS/Plesk.
    let r = await rawFetch(path, method, body, extraHeaders, ctrl.signal);
    if (needsOverride && (r.status === 405 || r.status === 501)) {
      r = await rawFetch(
        path,
        "POST",
        body == null ? "{}" : body,
        { ...extraHeaders, "X-HTTP-Method-Override": method },
        ctrl.signal,
      );
    }
    if (opts.rawResponse) return r;
    return await parseResponse(r);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === "AbortError") {
      throw new ApiError("Request timed out", { code: "timeout" });
    }
    throw new ApiError(err?.message || "Network error", { code: "network" });
  } finally {
    clearTimeout(timer);
  }
}

export async function register({ email, password, name }) {
  const data = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, name }),
  });
  if (data?.token) setToken(data.token);
  if (data?.user?.email) setUser(data.user.email);
  return data;
}

export async function login({ email, password }) {
  const data = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (data?.token) setToken(data.token);
  if (data?.user?.email) setUser(data.user.email);
  return data;
}

export async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch { /* */ }
  setToken("");
}

export async function me() {
  return api("/api/auth/me");
}

export async function health() {
  return api("/api/health");
}

export async function listModels(owner) {
  const q = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  return api(`/api/models${q}`);
}

export async function getModel(id) {
  return api(`/api/models/${encodeURIComponent(id)}`);
}

export async function createModel({ name, source = "empty", copyFromId, doc, note } = {}) {
  const owner = ensureUser();
  const data = await api("/api/models", {
    method: "POST",
    body: JSON.stringify({ name, owner, source, copyFromId, doc, note }),
  });
  if (data?.model?.id) setActiveModelId(data.model.id);
  return data;
}

export async function saveModelDoc(id, doc) {
  return api(`/api/models/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ doc }),
  });
}

export async function renameModel(id, name) {
  return api(`/api/models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteModel(id) {
  return api(`/api/models/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listVersions(id) {
  return api(`/api/models/${encodeURIComponent(id)}/versions`);
}

export async function snapshotVersion(id, { label, note, doc } = {}) {
  return api(`/api/models/${encodeURIComponent(id)}/versions`, {
    method: "POST",
    body: JSON.stringify({ label, note, doc }),
  });
}

export async function restoreVersion(id, versionId) {
  return api(`/api/models/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`, {
    method: "POST",
    body: "{}",
  });
}

export async function deleteVersion(id, versionId) {
  return api(`/api/models/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`, {
    method: "DELETE",
  });
}

export async function createShare(id, { label, versionId, expiresAt } = {}) {
  return api(`/api/models/${encodeURIComponent(id)}/shares`, {
    method: "POST",
    body: JSON.stringify({ label, versionId, expiresAt }),
  });
}

export async function listShares(id) {
  return api(`/api/models/${encodeURIComponent(id)}/shares`);
}

export async function revokeShare(id, shareId) {
  return api(`/api/models/${encodeURIComponent(id)}/shares/${encodeURIComponent(shareId)}`, {
    method: "DELETE",
  });
}

export async function getShare(token) {
  return api(`/api/shares/${encodeURIComponent(token)}`);
}

export async function exportPack(id, { versionId } = {}) {
  const r = await api(`/api/models/${encodeURIComponent(id)}/export`, {
    method: "POST",
    body: JSON.stringify({ versionId: versionId || null }),
    rawResponse: true,
  });
  if (!r.ok) {
    let data = null;
    try { data = await r.json(); } catch { /* */ }
    throw new ApiError(data?.error || r.statusText, { status: r.status, code: data?.code, data });
  }
  return r.blob();
}

export async function loadActiveModel() {
  ensureUser();
  const { models } = await listModels(getUser());
  let id = getActiveModelId();
  // URL ?model= wins
  try {
    const q = new URLSearchParams(location.search).get("model");
    if (q) {
      id = q;
      setActiveModelId(q);
    }
  } catch { /* */ }
  let hit = (models || []).find((m) => m.id === id);
  if (!hit) {
    hit = models?.[0] || null;
    if (!hit) {
      const created = await createModel({ name: "Apartment #15", source: "layout" });
      return { model: created.model, doc: created.doc, models: [created.model] };
    }
    setActiveModelId(hit.id);
    id = hit.id;
  }
  const full = await getModel(id);
  return { model: full.model, doc: full.doc, models };
}

export function draftKeyForModel(modelId) {
  const uid = getToken() ? (getUser() || "user") : "anon";
  return `apartment15-layout-v2-draft:${uid}:${modelId || "default"}`;
}

export function shareUrlFromPath(urlPath) {
  try {
    return new URL(urlPath, location.origin).href;
  } catch {
    return urlPath;
  }
}
