#!/usr/bin/env node
/**
 * Apartment15 local API + static server.
 * Routes mirrored in api.php for IIS/Plesk.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { buildZip, randomToken, hashToken } from "./zip-util.mjs";
import { areaScheduleCsv, buildAreaSchedule, docCounts } from "./area-schedule.js";
import { buildOpenhabExportFiles } from "./openhab-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const LAYOUT = path.join(ROOT, "layout.json");
const MODELS_DIR = path.join(ROOT, "models");
const INDEX_PATH = path.join(MODELS_DIR, "index.json");
const ASSETS = path.join(ROOT, "assets");
const DATA_DIR = path.join(ROOT, "data");
const USERS_PATH = path.join(DATA_DIR, "users.json");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const PORT = Number(process.env.PORT || 8765);
const MAX_BODY = 28 * 1024 * 1024;
const AUTH_REQUIRED = process.env.A15_AUTH; // "1" enforce sessions; unset/"0" = open mutate
const CORS_ORIGIN = process.env.A15_CORS || "*";
const PUBLIC_URL = (process.env.A15_PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const OPENHAB_URL = (process.env.A15_OPENHAB_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const OPENHAB_TOKEN = String(process.env.A15_OPENHAB_TOKEN || "").trim();
const FRAME_ANCESTORS = String(
  process.env.A15_FRAME_ANCESTORS || "http://192.168.1.100:8080 http://127.0.0.1:8080"
).trim();

function authEnforced() {
  // Default off so local CAD keeps working. Set A15_AUTH=1 to require sessions.
  return AUTH_REQUIRED === "1";
}

for (const d of [ASSETS, MODELS_DIR, DATA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
};

function reqId() {
  return crypto.randomBytes(4).toString("hex");
}

function logLine(id, method, pathName, code, ms, userId) {
  console.log(JSON.stringify({
    t: new Date().toISOString(), id, method, path: pathName, code, ms,
    user: userId || null,
  }));
}

function send(res, code, body, type = "text/plain; charset=utf-8", extra = {}) {
  const headers = {
    "Content-Type": type,
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,PUT,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-User, X-Model-Id, X-HTTP-Method-Override",
    "Cache-Control": "no-store",
    // Allow openHAB MainUI to iframe CAD / 3D (do not set X-Frame-Options: DENY)
    "Content-Security-Policy": `frame-ancestors ${FRAME_ANCESTORS}`,
    ...extra,
  };
  res.writeHead(code, headers);
  res.end(body);
}

function openhabConfigured() {
  return !!OPENHAB_TOKEN;
}

function openhabAuthHeader() {
  // openHAB API token: Basic auth with token as username and empty password
  const token = Buffer.from(`${OPENHAB_TOKEN}:`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function openhabFetch(restPath, { method = "GET", body, contentType } = {}) {
  if (!openhabConfigured()) {
    const err = new Error("openHAB token not configured (A15_OPENHAB_TOKEN)");
    err.status = 503;
    err.code = "openhab_unconfigured";
    throw err;
  }
  const url = `${OPENHAB_URL}${restPath.startsWith("/") ? restPath : `/${restPath}`}`;
  const headers = {
    Accept: "application/json",
    Authorization: openhabAuthHeader(),
  };
  if (contentType) headers["Content-Type"] = contentType;
  const init = { method, headers };
  if (body != null) init.body = body;
  let r;
  try {
    r = await fetch(url, init);
  } catch (e) {
    const err = new Error(`openHAB unreachable: ${e.message || e}`);
    err.status = 502;
    err.code = "openhab_unreachable";
    throw err;
  }
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* plain */ }
  return { ok: r.ok, status: r.status, text, json };
}

function sendJson(res, code, obj) {
  const payload = code >= 400 && obj && obj.ok == null
    ? { ok: false, ...obj }
    : obj;
  send(res, code, JSON.stringify(payload, null, 2), "application/json; charset=utf-8");
}

function sendErr(res, code, error, errCode = "error") {
  sendJson(res, code, { ok: false, error: String(error), code: errCode });
}

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { status: 413, code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error("invalid JSON");
    err.status = 400;
    err.code = "invalid_json";
    throw err;
  }
}

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function emptyDoc() {
  return {
    version: 2,
    updatedAt: nowIso(),
    gridMm: 50,
    snapMm: 50,
    units: "metric",
    wallHeightMm: 2600,
    wallThicknessMm: 120,
    flooring: "hardwood",
    layers: [],
    walls: [],
    openings: [],
    doors: [],
    windows: [],
    lights: [],
    fans: [],
    sockets: [],
    cabinets: [],
    rooms: [],
    images: [],
    groups: [],
  };
}

function readJsonFile(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(p, obj) {
  atomicWrite(p, JSON.stringify(obj, null, 2));
}

function readIndex() {
  return readJsonFile(INDEX_PATH, { models: [] });
}

function writeIndex(idx) {
  writeJsonFile(INDEX_PATH, idx);
}

function modelDir(id) {
  return path.join(MODELS_DIR, id);
}
function currentPath(id) {
  return path.join(modelDir(id), "current.json");
}
function versionPath(id, vid) {
  return path.join(modelDir(id), "versions", `${vid}.json`);
}
function findModel(idx, id) {
  return (idx.models || []).find((m) => m.id === id) || null;
}

function syncLayoutMirror(doc) {
  try { atomicWrite(LAYOUT, JSON.stringify(doc, null, 2)); } catch { /* */ }
}

function readCurrent(id) {
  return JSON.parse(fs.readFileSync(currentPath(id), "utf8"));
}

function writeCurrent(id, doc) {
  doc.updatedAt = nowIso();
  doc.modelId = id;
  if (doc.version == null) doc.version = 2;
  atomicWrite(currentPath(id), JSON.stringify(doc, null, 2));
  syncLayoutMirror(doc);
  return doc;
}

function publicModel(m, { includeShares = false } = {}) {
  const out = {
    id: m.id,
    name: m.name,
    owner: m.owner,
    ownerUserId: m.ownerUserId || null,
    plan: m.plan || null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    versionCount: (m.versions || []).length,
    latestVersion: (m.versions || [])[(m.versions || []).length - 1] || null,
    versions: m.versions || [],
  };
  if (includeShares) {
    out.shares = (m.shares || [])
      .filter((s) => !s.revoked)
      .map((s) => ({
        id: s.id,
        label: s.label,
        versionId: s.versionId || null,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt || null,
      }));
  }
  return out;
}

function ensureMigrated() {
  const idx = readIndex();
  if ((idx.models || []).length) return idx;
  let seed = emptyDoc();
  try { seed = JSON.parse(fs.readFileSync(LAYOUT, "utf8")); } catch { /* */ }
  const id = uid("mdl");
  const vid = uid("v");
  const t = nowIso();
  fs.mkdirSync(path.join(modelDir(id), "versions"), { recursive: true });
  const doc = { ...seed, updatedAt: t, modelId: id };
  atomicWrite(currentPath(id), JSON.stringify(doc, null, 2));
  atomicWrite(versionPath(id, vid), JSON.stringify({
    ...doc,
    _version: { id: vid, label: "v1 · Initial", note: "Migrated from layout.json", createdAt: t },
  }, null, 2));
  idx.models = [{
    id, name: "Apartment #15", owner: "local", ownerUserId: null,
    createdAt: t, updatedAt: t,
    versions: [{ id: vid, label: "v1 · Initial", note: "Migrated from layout.json", createdAt: t }],
    shares: [],
  }];
  writeIndex(idx);
  syncLayoutMirror(doc);
  return idx;
}

/* ——— Auth store ——— */
function readUsers() {
  return readJsonFile(USERS_PATH, { users: [] });
}
function writeUsers(u) {
  writeJsonFile(USERS_PATH, u);
}
function readSessions() {
  return readJsonFile(SESSIONS_PATH, { sessions: [] });
}
function writeSessions(s) {
  writeJsonFile(SESSIONS_PATH, s);
}

function scryptHash(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const iter = 120000;
  const hash = crypto.pbkdf2Sync(String(password), salt, iter, 32, "sha256");
  return `pbkdf2$${iter}$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split("$");
    if (parts[0] === "pbkdf2") {
      const iter = Number(parts[1]) || 120000;
      const salt = Buffer.from(parts[2], "hex");
      const expect = Buffer.from(parts[3], "hex");
      const hash = crypto.pbkdf2Sync(String(password), salt, iter, expect.length, "sha256");
      return crypto.timingSafeEqual(hash, expect);
    }
    if (parts[0] === "scrypt") {
      const salt = Buffer.from(parts[1], "hex");
      const expect = Buffer.from(parts[2], "hex");
      const hash = crypto.scryptSync(String(password), salt, expect.length);
      return crypto.timingSafeEqual(hash, expect);
    }
    return false;
  } catch {
    return false;
  }
}
function scryptVerify(password, stored) {
  return verifyPassword(password, stored);
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    plan: u.plan || "free",
    createdAt: u.createdAt,
  };
}

function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function getSessionUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  // Share tokens are public read credentials — never treat as sessions
  if (findShareByToken(token)) return null;
  const store = readSessions();
  const th = hashToken(token);
  const now = Date.now();
  store.sessions = (store.sessions || []).filter((s) => new Date(s.expiresAt).getTime() > now);
  writeSessions(store);
  const sess = store.sessions.find((s) => s.tokenHash === th);
  if (!sess) return null;
  const users = readUsers();
  return users.users.find((u) => u.id === sess.userId) || null;
}

function rejectShareBearer(req, res) {
  const token = bearerToken(req);
  if (token && findShareByToken(token)) {
    sendErr(res, 403, "share tokens are read-only", "share_readonly");
    return true;
  }
  return false;
}

function requireUser(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendErr(res, 401, "authentication required", "auth_required");
    return null;
  }
  return user;
}

function canAccessModel(user, meta, { mutate = false } = {}) {
  if (!meta) return false;
  if (!authEnforced() && !user) return true;
  if (!user) return false;
  if (meta.ownerUserId && meta.ownerUserId === user.id) return true;
  if (!meta.ownerUserId && meta.owner === user.email) return true;
  if (!meta.ownerUserId && meta.owner === "local" && !mutate) return true;
  return false;
}

function assertModelAccess(req, res, meta, { mutate = true } = {}) {
  if (mutate && rejectShareBearer(req, res)) return { user: null, ok: false };
  const user = getSessionUser(req);
  if (!authEnforced()) return { user, ok: true };
  if (!user) {
    sendErr(res, 401, "authentication required", "auth_required");
    return { user: null, ok: false };
  }
  if (!canAccessModel(user, meta, { mutate })) {
    sendErr(res, 403, "forbidden", "forbidden");
    return { user, ok: false };
  }
  return { user, ok: true };
}

function findShareByToken(token) {
  const idx = ensureMigrated();
  const th = hashToken(token);
  for (const m of idx.models || []) {
    for (const s of m.shares || []) {
      if (s.tokenHash === th) return { model: m, share: s, idx };
    }
  }
  return null;
}

function collectAssetFiles(doc) {
  const files = [];
  for (const im of doc?.images || []) {
    const src = String(im.src || "");
    const m = src.match(/^\.?\/?assets\/([^/?#]+)$/);
    if (m) {
      const fp = path.join(ASSETS, m[1]);
      if (fs.existsSync(fp)) files.push({ name: `assets/${m[1]}`, path: fp });
    }
  }
  return files;
}

ensureMigrated();
if (!fs.existsSync(USERS_PATH)) writeUsers({ users: [] });
if (!fs.existsSync(SESSIONS_PATH)) writeSessions({ sessions: [] });

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const id = reqId();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let method = (req.method || "GET").toUpperCase();
  const override = req.headers["x-http-method-override"];
  if (method === "POST" && override) method = String(override).toUpperCase();
  const pathname = decodeURIComponent(url.pathname);
  let userForLog = null;

  const done = (code) => {
    logLine(id, method, pathname, code, Date.now() - started, userForLog);
  };

  try {
    if (method === "OPTIONS") {
      send(res, 204, "");
      done(204);
      return;
    }

    /* Health */
    if (pathname === "/api/health") {
      let writable = false;
      try {
        const probe = path.join(DATA_DIR, ".health");
        atomicWrite(probe, "ok");
        writable = true;
      } catch { /* */ }
      const idx = readIndex();
      sendJson(res, 200, {
        ok: true,
        writable,
        models: (idx.models || []).length,
        auth: authEnforced(),
        time: nowIso(),
      });
      done(200);
      return;
    }

    /* Auth */
    if (pathname === "/api/auth/register" && method === "POST") {
      const body = parseJsonBody(await readBody(req));
      const email = String(body.email || "").trim().toLowerCase().slice(0, 120);
      const password = String(body.password || "");
      const name = String(body.name || email.split("@")[0] || "User").trim().slice(0, 64);
      if (!email.includes("@") || password.length < 8) {
        sendErr(res, 400, "valid email and password (8+ chars) required", "invalid_input");
        done(400);
        return;
      }
      const store = readUsers();
      if (store.users.some((u) => u.email === email)) {
        sendErr(res, 409, "email already registered", "email_taken");
        done(409);
        return;
      }
      const user = {
        id: uid("usr"),
        email,
        name,
        passwordHash: hashPassword(password),
        plan: "free",
        createdAt: nowIso(),
      };
      store.users.push(user);
      writeUsers(store);
      const token = randomToken(32);
      const sessions = readSessions();
      sessions.sessions.push({
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
      });
      writeSessions(sessions);
      userForLog = user.id;
      sendJson(res, 201, { ok: true, user: publicUser(user), token });
      done(201);
      return;
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      const body = parseJsonBody(await readBody(req));
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const store = readUsers();
      const user = store.users.find((u) => u.email === email);
      if (!user || !scryptVerify(password, user.passwordHash)) {
        sendErr(res, 401, "invalid email or password", "invalid_credentials");
        done(401);
        return;
      }
      const token = randomToken(32);
      const sessions = readSessions();
      sessions.sessions.push({
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
      });
      writeSessions(sessions);
      userForLog = user.id;
      sendJson(res, 200, { ok: true, user: publicUser(user), token });
      done(200);
      return;
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      const token = bearerToken(req);
      if (token) {
        const sessions = readSessions();
        const th = hashToken(token);
        sessions.sessions = (sessions.sessions || []).filter((s) => s.tokenHash !== th);
        writeSessions(sessions);
      }
      sendJson(res, 200, { ok: true });
      done(200);
      return;
    }

    if (pathname === "/api/auth/me" && method === "GET") {
      const user = getSessionUser(req);
      if (!user) {
        sendErr(res, 401, "authentication required", "auth_required");
        done(401);
        return;
      }
      userForLog = user.id;
      sendJson(res, 200, { ok: true, user: publicUser(user) });
      done(200);
      return;
    }

    /* Public share resolve */
    const shareGet = pathname.match(/^\/api\/shares\/([^/]+)\/?$/);
    if (shareGet && method === "GET") {
      const token = decodeURIComponent(shareGet[1]);
      const hit = findShareByToken(token);
      if (!hit || hit.share.revoked) {
        sendErr(res, 404, "share not found", "share_not_found");
        done(404);
        return;
      }
      if (hit.share.expiresAt && new Date(hit.share.expiresAt).getTime() < Date.now()) {
        sendErr(res, 410, "share expired", "share_expired");
        done(410);
        return;
      }
      let doc;
      if (hit.share.versionId) {
        try {
          const snap = JSON.parse(fs.readFileSync(versionPath(hit.model.id, hit.share.versionId), "utf8"));
          const { _version, ...rest } = snap;
          doc = rest;
        } catch {
          sendErr(res, 404, "shared version missing", "version_missing");
          done(404);
          return;
        }
      } else {
        doc = readCurrent(hit.model.id);
      }
      sendJson(res, 200, {
        ok: true,
        model: { id: hit.model.id, name: hit.model.name },
        share: {
          id: hit.share.id,
          label: hit.share.label,
          versionId: hit.share.versionId || null,
        },
        doc,
      });
      done(200);
      return;
    }

    /* openHAB proxy (token stays on server) */
    if (pathname === "/api/openhab/status" || pathname === "/api/openhab/status/") {
      if (method !== "GET") {
        sendErr(res, 405, "Method not allowed", "method");
        done(405);
        return;
      }
      if (!openhabConfigured()) {
        sendJson(res, 200, {
          ok: false,
          configured: false,
          message: "Set A15_OPENHAB_TOKEN in /etc/apartment15.env",
          openhabUrl: OPENHAB_URL,
          publicUrl: PUBLIC_URL,
        });
        done(200);
        return;
      }
      try {
        const r = await openhabFetch("/rest/items?limit=1");
        sendJson(res, 200, {
          ok: r.ok,
          configured: true,
          message: r.ok ? "connected" : `openHAB HTTP ${r.status}`,
          openhabUrl: OPENHAB_URL,
          publicUrl: PUBLIC_URL,
        });
        done(200);
      } catch (e) {
        sendJson(res, 200, {
          ok: false,
          configured: true,
          message: e.message || "unreachable",
          openhabUrl: OPENHAB_URL,
          publicUrl: PUBLIC_URL,
        });
        done(200);
      }
      return;
    }

    if (pathname === "/api/openhab/items" || pathname === "/api/openhab/items/") {
      if (method === "GET") {
        if (!openhabConfigured()) {
          sendJson(res, 200, {
            ok: false,
            configured: false,
            states: {},
            message: "Set A15_OPENHAB_TOKEN",
          });
          done(200);
          return;
        }
        const names = String(url.searchParams.get("names") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!names.length) {
          sendJson(res, 200, { ok: true, states: {} });
          done(200);
          return;
        }
        const states = {};
        await Promise.all(names.map(async (name) => {
          try {
            const r = await openhabFetch(`/rest/items/${encodeURIComponent(name)}/state`);
            if (r.ok) states[name] = r.text.trim();
            else states[name] = null;
          } catch {
            states[name] = null;
          }
        }));
        sendJson(res, 200, { ok: true, states });
        done(200);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    const ohItemMatch = pathname.match(/^\/api\/openhab\/items\/([^/]+)\/?$/);
    if (ohItemMatch) {
      const itemName = decodeURIComponent(ohItemMatch[1]);
      if (method === "POST") {
        const raw = await readBody(req, 256);
        const cmd = String(raw || "").trim().toUpperCase();
        if (cmd !== "ON" && cmd !== "OFF") {
          sendErr(res, 400, "body must be ON or OFF", "invalid_input");
          done(400);
          return;
        }
        try {
          const r = await openhabFetch(`/rest/items/${encodeURIComponent(itemName)}`, {
            method: "POST",
            body: cmd,
            contentType: "text/plain",
          });
          if (!r.ok) {
            sendErr(res, r.status >= 400 && r.status < 600 ? r.status : 502,
              r.text || `openHAB HTTP ${r.status}`, "openhab_error");
            done(r.status);
            return;
          }
          sendJson(res, 200, { ok: true, item: itemName, command: cmd });
          done(200);
        } catch (e) {
          sendErr(res, e.status || 502, e.message || "openHAB error", e.code || "openhab_error");
          done(e.status || 502);
        }
        return;
      }
      if (method === "GET") {
        try {
          const r = await openhabFetch(`/rest/items/${encodeURIComponent(itemName)}/state`);
          if (!r.ok) {
            sendErr(res, r.status, r.text || "item missing", "openhab_error");
            done(r.status);
            return;
          }
          sendJson(res, 200, { ok: true, item: itemName, state: r.text.trim() });
          done(200);
        } catch (e) {
          sendErr(res, e.status || 502, e.message || "openHAB error", e.code || "openhab_error");
          done(e.status || 502);
        }
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    /* Assets */
    if (pathname === "/api/asset" || pathname === "/api/asset/") {
      if (method === "POST") {
        const user = getSessionUser(req);
        if (AUTH_REQUIRED === "1" && !user) {
          sendErr(res, 401, "authentication required", "auth_required");
          done(401);
          return;
        }
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        const dataUrl = String(parsed.dataUrl || "");
        const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (!m) {
          sendErr(res, 400, "expected data URL image", "invalid_input");
          done(400);
          return;
        }
        const mime = m[1].toLowerCase();
        const ext =
          mime.includes("jpeg") || mime.includes("jpg") ? ".jpg"
            : mime.includes("webp") ? ".webp"
              : mime.includes("gif") ? ".gif"
                : ".png";
        const safeBase = String(parsed.name || "trace").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40) || "trace";
        const fileName = `${Date.now()}_${safeBase}${ext}`;
        const buf = Buffer.from(m[2], "base64");
        if (buf.length > 25 * 1024 * 1024) {
          sendErr(res, 400, "image too large (25MB max)", "too_large");
          done(400);
          return;
        }
        atomicWrite(path.join(ASSETS, fileName), buf);
        sendJson(res, 200, { ok: true, url: `./assets/${fileName}`, name: fileName });
        done(200);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    /* Models list / create */
    if (pathname === "/api/models" || pathname === "/api/models/") {
      const idx = ensureMigrated();
      if (method === "GET") {
        const user = getSessionUser(req);
        userForLog = user?.id;
        let list = idx.models || [];
        if (user) {
          list = list.filter((m) =>
            m.ownerUserId === user.id
            || (!m.ownerUserId && (m.owner === user.email || m.owner === getLegacyOwner(req)))
          );
        } else if (!authEnforced()) {
          const owner = url.searchParams.get("owner");
          if (owner) list = list.filter((m) => m.owner === owner || m.owner === "local");
        } else {
          sendErr(res, 401, "authentication required", "auth_required");
          done(401);
          return;
        }
        sendJson(res, 200, { ok: true, models: list.map((m) => publicModel(m, { includeShares: true })) });
        done(200);
        return;
      }
      if (method === "POST") {
        const user = getSessionUser(req);
        if (AUTH_REQUIRED === "1" && !user) {
          sendErr(res, 401, "authentication required", "auth_required");
          done(401);
          return;
        }
        userForLog = user?.id;
        const body = parseJsonBody(await readBody(req));
        const owner = user?.email || String(body.owner || req.headers["x-user"] || "local").trim().slice(0, 64) || "local";
        const name = String(body.name || "Untitled model").trim().slice(0, 80) || "Untitled model";
        const source = body.source || "empty";
        let doc = emptyDoc();
        if (source === "layout" || source === "current") {
          try { doc = JSON.parse(fs.readFileSync(LAYOUT, "utf8")); } catch { /* */ }
        } else if (source === "model" && body.copyFromId) {
          const srcMeta = findModel(idx, body.copyFromId);
          const gate = assertModelAccess(req, res, srcMeta, { mutate: false });
          if (!gate.ok && user) return done(403);
          doc = readCurrent(body.copyFromId);
        } else if (body.doc && typeof body.doc === "object") {
          doc = body.doc;
        }
        const mid = uid("mdl");
        const vid = uid("v");
        const t = nowIso();
        fs.mkdirSync(path.join(modelDir(mid), "versions"), { recursive: true });
        doc = { ...doc, modelId: mid, updatedAt: t };
        atomicWrite(currentPath(mid), JSON.stringify(doc, null, 2));
        const vLabel = "v1 · Initial";
        atomicWrite(versionPath(mid, vid), JSON.stringify({
          ...doc,
          _version: { id: vid, label: vLabel, note: body.note || "", createdAt: t },
        }, null, 2));
        const meta = {
          id: mid,
          name,
          owner,
          ownerUserId: user?.id || null,
          createdAt: t,
          updatedAt: t,
          versions: [{ id: vid, label: vLabel, note: body.note || "", createdAt: t }],
          shares: [],
        };
        idx.models.push(meta);
        writeIndex(idx);
        sendJson(res, 201, { ok: true, model: publicModel(meta, { includeShares: true }), doc });
        done(201);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    /* Model shares */
    const sharesMatch = pathname.match(/^\/api\/models\/([^/]+)\/shares\/?$/);
    if (sharesMatch) {
      const mid = sharesMatch[1];
      const idx = ensureMigrated();
      const meta = findModel(idx, mid);
      if (!meta) {
        sendErr(res, 404, "model not found", "not_found");
        done(404);
        return;
      }
      const gate = assertModelAccess(req, res, meta, { mutate: true });
      if (!gate.ok) { done(res.statusCode || 401); return; }
      userForLog = gate.user?.id;
      if (method === "GET") {
        sendJson(res, 200, { ok: true, shares: publicModel(meta, { includeShares: true }).shares });
        done(200);
        return;
      }
      if (method === "POST") {
        const body = parseJsonBody(await readBody(req));
        const token = randomToken(24);
        const share = {
          id: uid("shr"),
          tokenHash: hashToken(token),
          label: String(body.label || "Public link").trim().slice(0, 80),
          versionId: body.versionId || null,
          createdAt: nowIso(),
          expiresAt: body.expiresAt || null,
          revoked: false,
        };
        if (share.versionId && !(meta.versions || []).some((v) => v.id === share.versionId)) {
          sendErr(res, 400, "version not found", "version_missing");
          done(400);
          return;
        }
        meta.shares = meta.shares || [];
        meta.shares.push(share);
        meta.updatedAt = nowIso();
        writeIndex(idx);
        const linkPath = `/view.html?t=${encodeURIComponent(token)}`;
        sendJson(res, 201, {
          ok: true,
          share: {
            id: share.id,
            label: share.label,
            versionId: share.versionId,
            createdAt: share.createdAt,
            expiresAt: share.expiresAt,
            token,
            url: linkPath,
          },
        });
        done(201);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    const shareOne = pathname.match(/^\/api\/models\/([^/]+)\/shares\/([^/]+)\/?$/);
    if (shareOne && method === "DELETE") {
      const mid = shareOne[1];
      const sid = shareOne[2];
      const idx = ensureMigrated();
      const meta = findModel(idx, mid);
      if (!meta) {
        sendErr(res, 404, "model not found", "not_found");
        done(404);
        return;
      }
      const gate = assertModelAccess(req, res, meta, { mutate: true });
      if (!gate.ok) { done(401); return; }
      userForLog = gate.user?.id;
      meta.shares = (meta.shares || []).map((s) =>
        s.id === sid ? { ...s, revoked: true } : s
      );
      meta.updatedAt = nowIso();
      writeIndex(idx);
      sendJson(res, 200, { ok: true });
      done(200);
      return;
    }

    /* Export pack */
    const exportMatch = pathname.match(/^\/api\/models\/([^/]+)\/export\/?$/);
    if (exportMatch && method === "POST") {
      const mid = exportMatch[1];
      const idx = ensureMigrated();
      const meta = findModel(idx, mid);
      if (!meta) {
        sendErr(res, 404, "model not found", "not_found");
        done(404);
        return;
      }
      const gate = assertModelAccess(req, res, meta, { mutate: false });
      if (!gate.ok) { done(401); return; }
      userForLog = gate.user?.id;
      const body = parseJsonBody(await readBody(req));
      let doc;
      if (body.versionId) {
        const snap = JSON.parse(fs.readFileSync(versionPath(mid, body.versionId), "utf8"));
        const { _version, ...rest } = snap;
        doc = rest;
      } else {
        doc = readCurrent(mid);
      }
      const activeShare = (meta.shares || []).find((s) => !s.revoked);
      const oh = buildOpenhabExportFiles(doc, {
        modelName: meta.name,
        modelId: mid,
        publicUrl: PUBLIC_URL,
        // Share tokens are stored hashed only — use modelId URLs in YAML
        shareToken: "",
      });
      const entries = [
        { name: "layout.json", data: JSON.stringify(doc, null, 2) },
        {
          name: "meta.json",
          data: JSON.stringify({
            modelId: mid,
            name: meta.name,
            exportedAt: nowIso(),
            counts: docCounts(doc),
            areas: buildAreaSchedule(doc),
            shareHint: activeShare ? "Create a fresh share link from the app if needed." : null,
            publicUrl: PUBLIC_URL,
          }, null, 2),
        },
        { name: "areas.csv", data: areaScheduleCsv(doc) },
        {
          name: "README.txt",
          data: `Apartment15 export pack\nModel: ${meta.name}\nExported: ${nowIso()}\n\nOpen layout.json in the CAD editor (Import JSON).\nSee openhab/ for Pi + openHAB Items and MainUI page YAML.\n`,
        },
        { name: "openhab/apartment15.items", data: oh.itemsFile },
        { name: "openhab/pages/apartment15.yaml", data: oh.pageYaml },
        { name: "openhab/README.txt", data: oh.readme },
      ];
      for (const f of collectAssetFiles(doc)) {
        entries.push({ name: f.name, data: fs.readFileSync(f.path) });
      }
      const zip = buildZip(entries);
      const fname = `${String(meta.name).replace(/[^a-zA-Z0-9._-]+/g, "_") || "model"}.zip`;
      send(res, 200, zip, "application/zip", {
        "Content-Disposition": `attachment; filename="${fname}"`,
      });
      done(200);
      return;
    }

    /* Single model */
    const modelMatch = pathname.match(/^\/api\/models\/([^/]+)\/?$/);
    if (modelMatch) {
      const mid = modelMatch[1];
      const idx = ensureMigrated();
      const meta = findModel(idx, mid);
      if (!meta) {
        sendErr(res, 404, "model not found", "not_found");
        done(404);
        return;
      }
      if (method === "GET") {
        const gate = assertModelAccess(req, res, meta, { mutate: false });
        if (!gate.ok) { done(401); return; }
        userForLog = gate.user?.id;
        const doc = readCurrent(mid);
        sendJson(res, 200, { ok: true, model: publicModel(meta, { includeShares: true }), doc });
        done(200);
        return;
      }
      if (method === "PUT") {
        const gate = assertModelAccess(req, res, meta, { mutate: true });
        if (!gate.ok) { done(401); return; }
        userForLog = gate.user?.id;
        const body = parseJsonBody(await readBody(req));
        const docIn = body.doc || body;
        if (!docIn || typeof docIn !== "object" || Array.isArray(docIn)) {
          sendErr(res, 400, "invalid doc", "invalid_doc");
          done(400);
          return;
        }
        const doc = writeCurrent(mid, docIn);
        meta.updatedAt = doc.updatedAt;
        writeIndex(idx);
        sendJson(res, 200, { ok: true, model: publicModel(meta, { includeShares: true }), doc });
        done(200);
        return;
      }
      if (method === "PATCH") {
        const gate = assertModelAccess(req, res, meta, { mutate: true });
        if (!gate.ok) { done(401); return; }
        userForLog = gate.user?.id;
        const body = parseJsonBody(await readBody(req));
        if (body.name != null) meta.name = String(body.name).trim().slice(0, 80) || meta.name;
        if (body.owner != null && process.env.A15_AUTH === "0") {
          meta.owner = String(body.owner).trim().slice(0, 64) || meta.owner;
        }
        meta.updatedAt = nowIso();
        writeIndex(idx);
        sendJson(res, 200, { ok: true, model: publicModel(meta, { includeShares: true }) });
        done(200);
        return;
      }
      if (method === "DELETE") {
        const gate = assertModelAccess(req, res, meta, { mutate: true });
        if (!gate.ok) { done(401); return; }
        userForLog = gate.user?.id;
        fs.rmSync(modelDir(mid), { recursive: true, force: true });
        idx.models = idx.models.filter((m) => m.id !== mid);
        writeIndex(idx);
        sendJson(res, 200, { ok: true });
        done(200);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    /* Versions */
    const versionsMatch = pathname.match(/^\/api\/models\/([^/]+)\/versions\/?$/);
    if (versionsMatch) {
      const mid = versionsMatch[1];
      const idx = ensureMigrated();
      const meta = findModel(idx, mid);
      if (!meta) {
        sendErr(res, 404, "model not found", "not_found");
        done(404);
        return;
      }
      const gate = assertModelAccess(req, res, meta, { mutate: method !== "GET" });
      if (!gate.ok) { done(401); return; }
      userForLog = gate.user?.id;
      if (method === "GET") {
        sendJson(res, 200, { ok: true, modelId: mid, versions: meta.versions || [] });
        done(200);
        return;
      }
      if (method === "POST") {
        const body = parseJsonBody(await readBody(req));
        const doc = body.doc ? writeCurrent(mid, body.doc) : readCurrent(mid);
        const vid = uid("v");
        const t = nowIso();
        const n = (meta.versions || []).length + 1;
        const label = String(body.label || `v${n}`).trim().slice(0, 80) || `v${n}`;
        const note = String(body.note || "").trim().slice(0, 240);
        fs.mkdirSync(path.join(modelDir(mid), "versions"), { recursive: true });
        atomicWrite(versionPath(mid, vid), JSON.stringify({
          ...doc, updatedAt: t, _version: { id: vid, label, note, createdAt: t },
        }, null, 2));
        meta.versions = meta.versions || [];
        meta.versions.push({ id: vid, label, note, createdAt: t });
        meta.updatedAt = t;
        writeIndex(idx);
        sendJson(res, 201, { ok: true, model: publicModel(meta, { includeShares: true }), version: meta.versions.at(-1) });
        done(201);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    const versionOne = pathname.match(/^\/api\/models\/([^/]+)\/versions\/([^/]+)\/?$/);
    if (versionOne) {
      const mid = versionOne[1];
      const vid = versionOne[2];
      const idx = ensureMigrated();
      const meta = findModel(idx, mid);
      if (!meta) {
        sendErr(res, 404, "model not found", "not_found");
        done(404);
        return;
      }
      const vmeta = (meta.versions || []).find((v) => v.id === vid);
      if (!vmeta) {
        sendErr(res, 404, "version not found", "not_found");
        done(404);
        return;
      }
      const gate = assertModelAccess(req, res, meta, { mutate: method !== "GET" });
      if (!gate.ok) { done(401); return; }
      userForLog = gate.user?.id;
      if (method === "GET") {
        const doc = JSON.parse(fs.readFileSync(versionPath(mid, vid), "utf8"));
        sendJson(res, 200, { ok: true, model: publicModel(meta), version: vmeta, doc });
        done(200);
        return;
      }
      if (method === "POST") {
        const snap = JSON.parse(fs.readFileSync(versionPath(mid, vid), "utf8"));
        const { _version, ...rest } = snap;
        const doc = writeCurrent(mid, rest);
        meta.updatedAt = doc.updatedAt;
        writeIndex(idx);
        sendJson(res, 200, { ok: true, model: publicModel(meta), doc, restoredFrom: vmeta });
        done(200);
        return;
      }
      if (method === "DELETE") {
        if ((meta.versions || []).length <= 1) {
          sendErr(res, 400, "keep at least one version", "last_version");
          done(400);
          return;
        }
        fs.rmSync(versionPath(mid, vid), { force: true });
        meta.versions = meta.versions.filter((v) => v.id !== vid);
        meta.updatedAt = nowIso();
        writeIndex(idx);
        sendJson(res, 200, { ok: true, model: publicModel(meta) });
        done(200);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    /* Legacy layout */
    if (pathname === "/api/layout" || pathname === "/api/layout/") {
      const idx = ensureMigrated();
      const modelId = url.searchParams.get("model") || req.headers["x-model-id"] || idx.models[0]?.id;
      const meta = findModel(idx, modelId);
      if (!meta) {
        sendErr(res, 404, "no models", "not_found");
        done(404);
        return;
      }
      if (method === "GET") {
        const gate = assertModelAccess(req, res, meta, { mutate: false });
        if (!gate.ok) { done(401); return; }
        sendJson(res, 200, readCurrent(meta.id));
        done(200);
        return;
      }
      if (method === "PUT") {
        const gate = assertModelAccess(req, res, meta, { mutate: true });
        if (!gate.ok) { done(401); return; }
        const parsed = parseJsonBody(await readBody(req));
        if (!parsed || typeof parsed !== "object") {
          sendErr(res, 400, "invalid", "invalid_json");
          done(400);
          return;
        }
        const doc = writeCurrent(meta.id, parsed);
        meta.updatedAt = doc.updatedAt;
        writeIndex(idx);
        sendJson(res, 200, doc);
        done(200);
        return;
      }
      sendErr(res, 405, "Method not allowed", "method");
      done(405);
      return;
    }

    /* Static */
    let filePath = pathname === "/" ? "/index.html" : pathname;
    filePath = path.normalize(path.join(ROOT, filePath));
    if (!filePath.startsWith(ROOT)) {
      send(res, 403, "Forbidden");
      done(403);
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        send(res, 404, "Not found");
        done(404);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      send(res, 200, data, MIME[ext] || "application/octet-stream");
      done(200);
    });
  } catch (err) {
    const code = err.status || 500;
    sendErr(res, code, err.message || "server error", err.code || "server_error");
    done(code);
  }
});

function getLegacyOwner(req) {
  return String(req.headers["x-user"] || "").trim();
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Apartment #15 CAD → http://127.0.0.1:${PORT}/`);
  console.log(`Public URL        → ${PUBLIC_URL}`);
  console.log(`Health            → http://127.0.0.1:${PORT}/api/health`);
  console.log(`openHAB proxy     → /api/openhab/* → ${OPENHAB_URL} (${openhabConfigured() ? "token set" : "NO TOKEN"})`);
  console.log(`Auth              → POST /api/auth/register|login`);
  console.log(`Set A15_AUTH=1 to require login for mutate / list`);
});
