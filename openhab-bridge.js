/**
 * openHAB Item naming, state apply, and export generators.
 * Shared by browser (CAD / 3D) and Node (server.mjs export + proxy helpers).
 */

export const OH_KINDS = ["door", "window", "cabinet", "light", "fan"];

const KIND_PREFIX = {
  door: "Door",
  window: "Window",
  cabinet: "Cabinet",
  light: "Light",
  fan: "Fan",
};

/** Sanitize for openHAB item names: letters, digits, underscore. */
export function sanitizeItemPart(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 48) || "x";
}

/** Default Item name; honors optional obj.ohItem override. */
export function itemNameFor(kind, obj) {
  if (obj?.ohItem && String(obj.ohItem).trim()) {
    return sanitizeItemPart(obj.ohItem);
  }
  const prefix = KIND_PREFIX[kind] || "Dev";
  const id = sanitizeItemPart(obj?.id || "unknown");
  return `A15_${prefix}_${id}`;
}

export function isOnKind(kind) {
  return kind === "light" || kind === "fan";
}

export function boolFromOhState(state) {
  const s = String(state || "").toUpperCase();
  return s === "ON" || s === "OPEN" || s === "1" || s === "TRUE";
}

export function ohCommandFromBool(on) {
  return on ? "ON" : "OFF";
}

/** List all syncable devices in a layout doc. */
export function listActuators(doc) {
  if (!doc) return [];
  const out = [];
  for (const d of doc.doors || []) out.push({ kind: "door", id: d.id, obj: d, item: itemNameFor("door", d) });
  for (const w of doc.windows || []) {
    if (w.style === "fixed") continue;
    out.push({ kind: "window", id: w.id, obj: w, item: itemNameFor("window", w) });
  }
  for (const c of doc.cabinets || []) {
    out.push({ kind: "cabinet", id: c.id, obj: c, item: itemNameFor("cabinet", c) });
  }
  for (const l of doc.lights || []) out.push({ kind: "light", id: l.id, obj: l, item: itemNameFor("light", l) });
  for (const f of doc.fans || []) out.push({ kind: "fan", id: f.id, obj: f, item: itemNameFor("fan", f) });
  return out;
}

export function deviceBool(kind, obj) {
  if (!obj) return false;
  return isOnKind(kind) ? !!obj.on : !!obj.open;
}

export function setDeviceBool(kind, obj, on) {
  if (!obj) return false;
  const next = !!on;
  if (isOnKind(kind)) {
    if (!!obj.on === next) return false;
    obj.on = next;
    return true;
  }
  if (!!obj.open === next) return false;
  obj.open = next;
  return true;
}

/**
 * Apply a map of itemName → state string onto doc.
 * Returns number of devices changed.
 */
export function applyOhStates(doc, stateMap) {
  if (!doc || !stateMap) return 0;
  let n = 0;
  for (const a of listActuators(doc)) {
    if (!(a.item in stateMap)) continue;
    if (setDeviceBool(a.kind, a.obj, boolFromOhState(stateMap[a.item]))) n += 1;
  }
  return n;
}

export function generateItemsFile(doc, { modelName = "Apartment15" } = {}) {
  const lines = [
    `// Apartment15 → openHAB Items`,
    `// Model: ${modelName}`,
    `// Generated: ${new Date().toISOString()}`,
    `// Drop into conf/items/ and reload openHAB (or wait for file watcher).`,
    ``,
    `Group A15_Apartment "${escapeLabel(modelName)}"`,
    ``,
  ];
  for (const a of listActuators(doc)) {
    const label = escapeLabel(a.obj.label || a.obj.type || a.kind);
    const tags = isOnKind(a.kind) ? '["Switchable","Light"]' : '["OpenState","Switchable"]';
    lines.push(`Switch ${a.item} "${label}" (A15_Apartment) ${tags}`);
  }
  lines.push("");
  return lines.join("\n");
}

function escapeLabel(s) {
  return String(s || "").replace(/"/g, "'").slice(0, 80);
}

export function generatePageYaml({
  modelName = "Apartment15",
  publicUrl = "http://192.168.1.100:8765",
  shareToken = "",
  modelId = "",
} = {}) {
  const base = String(publicUrl || "").replace(/\/$/, "");
  let url2d;
  let url3d;
  if (shareToken) {
    url2d = `${base}/view.html?t=${encodeURIComponent(shareToken)}`;
    url3d = `${base}/preview3d.html?t=${encodeURIComponent(shareToken)}&view=1`;
  } else if (modelId) {
    url2d = `${base}/index.html?model=${encodeURIComponent(modelId)}`;
    url3d = `${base}/preview3d.html?model=${encodeURIComponent(modelId)}&view=1`;
  } else {
    url2d = `${base}/index.html`;
    url3d = `${base}/preview3d.html?view=1`;
  }
  return `config:
  label: ${JSON.stringify(modelName + " · Floor")}
  sidebar: true
blocks:
  - component: oh-block
    config:
      title: 2D plan
    slots:
      default:
        - component: oh-grid-row
          config: {}
          slots:
            default:
              - component: oh-grid-col
                config:
                  width: 100
                slots:
                  default:
                    - component: oh-webframe-card
                      config:
                        src: ${JSON.stringify(url2d)}
                        height: 520
                        noBorder: true
                        title: 2D
  - component: oh-block
    config:
      title: 3D preview
    slots:
      default:
        - component: oh-grid-row
          config: {}
          slots:
            default:
              - component: oh-grid-col
                config:
                  width: 100
                slots:
                  default:
                    - component: oh-webframe-card
                      config:
                        src: ${JSON.stringify(url3d)}
                        height: 640
                        noBorder: true
                        title: 3D
masonry: null
grid: []
canvas: []
`;
}

export function generateOpenhabReadme({
  modelName = "Apartment15",
  publicUrl = "http://192.168.1.100:8765",
} = {}) {
  return `Apartment15 → openHAB (Pi)

Model: ${modelName}
Public URL: ${publicUrl}

1) Items
   Copy openhab/apartment15.items into:
     /etc/openhab/items/apartment15.items
   (or $OPENHAB_CONF/items/)
   Reload: openhab-cli console → "openhab:reload" or wait for watcher.

2) API token
   MainUI → profile (bottom-left) → Create API Token.
   Put it in /etc/apartment15.env as A15_OPENHAB_TOKEN=oh....
   Restart: sudo systemctl restart apartment15

3) Pages
   MainUI → Settings → Pages → + → Code
   Paste openhab/pages/apartment15.yaml
   Adjust iframe URLs if your LAN IP differs.

4) Link real devices
   These Switches are virtual. Link each Item to your Thing channels
   (MQTT, Z-Wave, etc.) in the MainUI Model / Items UI.

5) Embed
   Apartment15 must allow framing from MainUI (A15_FRAME_ANCESTORS).
   See deploy/pi/README-PI.md
`;
}

/** Build { itemsFile, pageYaml, readme } for export ZIP. */
export function buildOpenhabExportFiles(doc, opts = {}) {
  const modelName = opts.modelName || "Apartment15";
  const publicUrl = opts.publicUrl || "http://192.168.1.100:8765";
  return {
    itemsFile: generateItemsFile(doc, { modelName }),
    pageYaml: generatePageYaml({
      modelName,
      publicUrl,
      shareToken: opts.shareToken || "",
      modelId: opts.modelId || "",
    }),
    readme: generateOpenhabReadme({ modelName, publicUrl }),
  };
}

/* ——— Browser client (optional; no-op helpers when unused) ——— */

const LS_ENABLED = "a15-openhab-enabled";

export function isOhClientEnabled() {
  try {
    return localStorage.getItem(LS_ENABLED) === "1";
  } catch {
    return false;
  }
}

export function setOhClientEnabled(on) {
  try {
    localStorage.setItem(LS_ENABLED, on ? "1" : "0");
  } catch { /* */ }
}

/**
 * Create a polling bridge. opts:
 *   getDoc, onApplied(changedCount), fetchImpl (default fetch)
 *   pollMs (default 2000)
 */
export function createOpenhabClient(opts = {}) {
  const getDoc = opts.getDoc || (() => null);
  const onApplied = opts.onApplied || (() => {});
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const pollMs = opts.pollMs ?? 2000;
  let timer = null;
  let enabled = isOhClientEnabled();
  let status = { ok: false, configured: false, message: "off" };
  const suppressUntil = new Map(); // item → timestamp
  let lastWrite = 0;

  async function api(path, init) {
    const r = await fetchImpl(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || data.message || `HTTP ${r.status}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function refreshStatus() {
    try {
      const data = await api("/api/openhab/status");
      status = {
        ok: !!data.ok,
        configured: !!data.configured,
        message: data.message || (data.ok ? "connected" : "unavailable"),
        openhabUrl: data.openhabUrl || null,
      };
    } catch (e) {
      status = { ok: false, configured: false, message: String(e.message || e) };
    }
    return status;
  }

  function itemNames() {
    return listActuators(getDoc()).map((a) => a.item);
  }

  async function pullStates() {
    if (!enabled) return 0;
    const names = itemNames();
    if (!names.length) return 0;
    const q = encodeURIComponent(names.join(","));
    const data = await api(`/api/openhab/items?names=${q}`);
    const map = data.states || {};
    const now = Date.now();
    const filtered = {};
    for (const [k, v] of Object.entries(map)) {
      if ((suppressUntil.get(k) || 0) > now) continue;
      filtered[k] = v;
    }
    const doc = getDoc();
    const n = applyOhStates(doc, filtered);
    if (n) onApplied(n);
    return n;
  }

  async function pushDevice(kind, obj) {
    if (!enabled || !obj) return;
    const item = itemNameFor(kind, obj);
    const cmd = ohCommandFromBool(deviceBool(kind, obj));
    suppressUntil.set(item, Date.now() + 2500);
    lastWrite = Date.now();
    try {
      await api(`/api/openhab/items/${encodeURIComponent(item)}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: cmd,
      });
    } catch (e) {
      console.warn("[openhab] push failed", item, e);
    }
  }

  function start() {
    stop();
    if (!enabled) return;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        await pullStates();
      } catch (e) {
        status = { ok: false, configured: status.configured, message: String(e.message || e) };
      }
    };
    refreshStatus().then(tick).catch(() => {});
    timer = setInterval(tick, pollMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function setEnabled(on) {
    enabled = !!on;
    setOhClientEnabled(enabled);
    if (enabled) start();
    else stop();
    return enabled;
  }

  return {
    get enabled() { return enabled; },
    get status() { return status; },
    get lastWrite() { return lastWrite; },
    setEnabled,
    start,
    stop,
    refreshStatus,
    pullStates,
    pushDevice,
    itemNames,
  };
}
