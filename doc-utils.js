/** Shared document helpers: clone, groups, history, live sync. */

export function clone(v) {
  try {
    if (typeof structuredClone === "function") return structuredClone(v);
  } catch { /* fall through */ }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

export function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((g, i) => ({
      id: g?.id || `grp_${i}_${Math.random().toString(36).slice(2, 7)}`,
      label: g?.label || `Group ${i + 1}`,
      members: Array.isArray(g?.members)
        ? g.members
          .filter((m) => m && m.kind && m.id)
          .map((m) => ({ kind: String(m.kind), id: String(m.id) }))
        : [],
    }))
    .filter((g) => g.members.length > 0);
}

/** Attach/normalize top-level fields both editors must preserve. */
export function applySharedDocFields(src, dest) {
  if (!dest || typeof dest !== "object") return dest;
  const s = src && typeof src === "object" ? src : {};
  dest.groups = normalizeGroups(s.groups ?? dest.groups);
  if (s.site && typeof s.site === "object") {
    dest.site = {
      lat: Number(s.site.lat) || dest.site?.lat,
      lon: Number(s.site.lon) || dest.site?.lon,
      preset: s.site.preset || dest.site?.preset || null,
      dayOfYear: s.site.dayOfYear ?? dest.site?.dayOfYear,
      syncRealtime: !!s.site.syncRealtime,
    };
  }
  if (s.modelId) dest.modelId = s.modelId;
  if (s.gridMm != null) {
    const n = Number(s.gridMm);
    dest.gridMm = Number.isFinite(n) && n >= 1 ? n : 50;
  }
  if (s.snapMm != null) {
    const n = Number(s.snapMm);
    dest.snapMm = Number.isFinite(n) && n >= 1 ? n : 50;
  }
  return dest;
}

export function pruneGroups(doc) {
  if (!doc) return;
  const alive = new Set();
  for (const kind of ["door", "window", "light", "fan", "socket", "cabinet", "wall", "opening", "room", "image"]) {
    const key =
      kind === "cabinet" ? "cabinets"
        : kind === "door" ? "doors"
          : kind === "window" ? "windows"
            : kind === "light" ? "lights"
              : kind === "fan" ? "fans"
                : kind === "socket" ? "sockets"
                  : kind === "wall" ? "walls"
                    : kind === "opening" ? "openings"
                      : kind === "room" ? "rooms"
                        : kind === "image" ? "images"
                          : null;
    for (const o of doc[key] || []) alive.add(`${kind}:${o.id}`);
  }
  doc.groups = normalizeGroups(doc.groups).map((g) => ({
    ...g,
    members: g.members.filter((m) => alive.has(`${m.kind}:${m.id}`)),
  })).filter((g) => g.members.length > 0);
}

export function findGroupsFor(doc, kind, id) {
  return normalizeGroups(doc?.groups).filter((g) =>
    (g.members || []).some((m) => m.kind === kind && m.id === id)
  );
}

export function uidGroup() {
  return `grp_${Math.random().toString(36).slice(2, 9)}`;
}

export function groupMembers(doc, items, label) {
  if (!doc || !items?.length) return null;
  if (!doc.groups) doc.groups = [];
  const g = {
    id: uidGroup(),
    label: label || `Group ${doc.groups.length + 1}`,
    members: items.map((it) => ({ kind: it.kind, id: it.id })),
  };
  for (const existing of doc.groups) {
    existing.members = (existing.members || []).filter(
      (m) => !items.some((it) => it.kind === m.kind && it.id === m.id)
    );
  }
  doc.groups = normalizeGroups(doc.groups).filter((x) => x.members.length > 0);
  doc.groups.push(g);
  return g;
}

export function ungroupMembers(doc, items) {
  if (!doc || !items?.length) return 0;
  const hit = new Set();
  for (const it of items) {
    for (const g of findGroupsFor(doc, it.kind, it.id)) hit.add(g.id);
  }
  if (!hit.size) return 0;
  doc.groups = normalizeGroups(doc.groups).filter((g) => !hit.has(g.id));
  return hit.size;
}

/** Simple undo/redo stack factory. */
export function createHistory({ max = 50, onChange } = {}) {
  let past = [];
  let future = [];
  return {
    get length() { return past.length; },
    get futureLength() { return future.length; },
    clear() { past = []; future = []; },
    push(doc) {
      if (!doc) return;
      past.push(clone(doc));
      if (past.length > max) past.shift();
      future = [];
      onChange?.("push");
    },
    undo(doc) {
      if (!past.length || !doc) return null;
      future.push(clone(doc));
      const prev = past.pop();
      onChange?.("undo");
      return prev;
    },
    redo(doc) {
      if (!future.length || !doc) return null;
      past.push(clone(doc));
      const next = future.pop();
      onChange?.("redo");
      return next;
    },
  };
}

const SYNC_CHANNEL = "a15-layout-sync-v1";

/** Cross-tab live sync via BroadcastChannel. */
export function createLiveSync({ modelId, onRemote }) {
  let ch = null;
  let lastSent = 0;
  let ignoreUntil = 0;
  try {
    ch = new BroadcastChannel(SYNC_CHANNEL);
  } catch {
    return { publish() {}, close() {}, get modelId() { return modelId; }, setModelId() {} };
  }
  let activeId = modelId || null;
  ch.onmessage = (ev) => {
    try {
      const msg = ev.data;
      if (!msg || msg.v !== 1) return;
      if (msg.modelId && activeId && msg.modelId !== activeId) return;
      if (msg.t && msg.t <= ignoreUntil) return;
      if (msg.type === "doc" && msg.doc && typeof msg.doc === "object") {
        onRemote?.(msg.doc, msg);
      }
    } catch (err) {
      console.warn("live sync message ignored", err);
    }
  };
  return {
    get modelId() { return activeId; },
    setModelId(id) { activeId = id || null; },
    publish(doc, meta = {}) {
      if (!ch || !doc) return;
      const t = Date.now();
      lastSent = t;
      ignoreUntil = t; // ignore our own echo
      try {
        ch.postMessage({
          v: 1,
          type: "doc",
          modelId: activeId,
          t,
          updatedAt: doc.updatedAt,
          doc,
          ...meta,
        });
      } catch { /* */ }
    },
    close() {
      try { ch?.close(); } catch { /* */ }
      ch = null;
    },
  };
}
