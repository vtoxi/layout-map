/** Apartment #15 floor-plan CAD */
import * as Models from "./models-client.js";
import { installClientGuards } from "./client-guards.js";
import { ensureAuthed, openAuthModal } from "./auth-ui.js";
import {
  REF_WALL_H,
  HEIGHT_PRESETS,
  applyDefaultWallHeight,
  applyDefaultWallThickness,
  syncLegacyWallHeights,
  scaleH,
  near,
  ceilingMm,
} from "./layout-heights.js";
import {
  placementAllowed as physPlacement,
  resolveMove,
  findRoomAt,
} from "./placement-physics.js";
import {
  applySharedDocFields,
  pruneGroups,
  groupMembers as groupMembersUtil,
  ungroupMembers as ungroupMembersUtil,
  findGroupsFor,
  createLiveSync,
} from "./doc-utils.js";
import { createOpenhabClient } from "./openhab-bridge.js";
import * as Catalog from "./catalog-client.js";

installClientGuards({
  toast: (text, kind) => {
    try { toast(text, kind); } catch { /* toast may not exist yet */ }
  },
});

let DRAFT_KEY = "apartment15-layout-v2-draft";
let activeModel = null; // public model meta
let modelsCache = [];
const S = 0.1;
const MAX_Y = 12600;
const HIT_MM = 180;
const OPENING_DEFAULT = 900;
const DOOR_HEIGHT_DEFAULT = 2100;
const WINDOW_WIDTH_DEFAULT = 1200;
const WINDOW_HEIGHT_DEFAULT = 1200;
const WINDOW_SILL_DEFAULT = 900;

const DOOR_STYLES = [
  { id: "swing", label: "Swing (single)" },
  { id: "double", label: "Double swing" },
  { id: "sliding", label: "Sliding" },
  { id: "pocket", label: "Pocket" },
  { id: "bifold", label: "Bifold" },
];
const WINDOW_STYLES = [
  { id: "fixed", label: "Fixed" },
  { id: "casement", label: "Casement" },
  { id: "sliding", label: "Sliding" },
  { id: "awning", label: "Awning" },
  { id: "double", label: "Double hung" },
];
const LIGHT_SHAPES = [
  { id: "bulb", label: "Bulb" },
  { id: "tube", label: "Tube / linear" },
  { id: "spot", label: "Spot" },
  { id: "panel", label: "Panel" },
];
const SOCKET_STYLES = [
  { id: "single", label: "Single" },
  { id: "double", label: "Double" },
  { id: "usb", label: "USB combo" },
  { id: "floor", label: "Floor outlet" },
  { id: "panel", label: "Electric board / DB" },
];
const CABINET_KINDS = [
  { id: "base", label: "Base (doors + counter)", heightMm: 900 },
  { id: "drawer", label: "Base (drawers + counter)", heightMm: 900 },
  { id: "wall", label: "Wall / upper", heightMm: 720 },
  { id: "tall", label: "Tall / pantry", heightMm: 2100 },
];
const CABINET_DOOR_OPTIONS = [1, 2, 3, 4, 5, 6];
const CABINET_DRAWER_OPTIONS = [2, 3, 4, 5];

/** Furniture catalog — file DB under ./catalog/, lazy-loaded via catalog-client.js */
const CURTAIN_STYLES = [
  { id: "cloth", label: "Cloth drapes" },
  { id: "sheer", label: "Sheer / voile" },
  { id: "vertical", label: "Vertical blinds" },
  { id: "horizontal", label: "Horizontal blinds" },
  { id: "roman", label: "Roman shade" },
  { id: "panel", label: "Panel track" },
];
const CURTAIN_FOLD_MODES = [
  { id: "both", label: "Draw both sides" },
  { id: "left", label: "Stack left" },
  { id: "right", label: "Stack right" },
];
/** Tiny color fallback until catalog/meta.json loads. */
const FURNITURE_COLORS_FALLBACK = [
  { id: "cream", hex: "#e8dcc8", label: "Cream" },
  { id: "linen", hex: "#c4b59a", label: "Linen" },
  { id: "charcoal", hex: "#3a4048", label: "Charcoal" },
  { id: "navy", hex: "#2a3a5a", label: "Navy" },
  { id: "sage", hex: "#6a7a68", label: "Sage" },
  { id: "terracotta", hex: "#a85a40", label: "Terracotta" },
  { id: "blush", hex: "#c89090", label: "Blush" },
  { id: "white", hex: "#f0f2f5", label: "White" },
  { id: "wood", hex: "#8a7050", label: "Wood" },
  { id: "walnut", hex: "#5a4030", label: "Walnut" },
  { id: "slate", hex: "#5a6a7a", label: "Slate" },
  { id: "gold", hex: "#c9a227", label: "Gold" },
];

/** Furnish panel lazy-load UI state */
let furnUi = {
  ready: false,
  loading: false,
  error: null,
  cat: "Storage",
  search: "",
};

function furnitureColors() {
  const c = Catalog.getColors();
  return c.length ? c : FURNITURE_COLORS_FALLBACK;
}
function curtainStyles() {
  const c = Catalog.getCurtainStyles();
  return c.length ? c : CURTAIN_STYLES;
}
function foldModes() {
  const m = Catalog.getFoldModes();
  return m.length ? m : CURTAIN_FOLD_MODES;
}
function furnitureDef(typeId) {
  return Catalog.getItem(typeId);
}
function furnitureTypeOptions() {
  const stubs = Catalog.listStubs();
  if (stubs.length) return stubs;
  const cur = placeCabinet?.type || "cabinet";
  const def = furnitureDef(cur);
  return [{ id: def.id, label: def.label, cat: def.cat || "Storage" }];
}

async function ensureFurnishCatalog() {
  if (furnUi.ready || furnUi.loading) return furnUi.ready;
  furnUi.loading = true;
  furnUi.error = null;
  lastInspectorKey = "";
  try { renderInspector(); } catch { /* */ }
  try {
    await Catalog.prefetchForFurnish(furnUi.cat);
    // Prefer last-used category if still valid
    const cats = Catalog.listCategories();
    if (cats.length && !cats.some((c) => c.label === furnUi.cat)) {
      furnUi.cat = cats[0].label;
      await Catalog.loadCategory(furnUi.cat);
    }
    furnUi.ready = true;
  } catch (err) {
    console.error(err);
    furnUi.error = err?.message || String(err);
  } finally {
    furnUi.loading = false;
    lastInspectorKey = "";
    try { renderInspector(); draw(); } catch { /* */ }
  }
  return furnUi.ready;
}

async function selectFurnCategory(catLabel) {
  furnUi.cat = catLabel;
  furnUi.search = "";
  lastInspectorKey = "";
  try { renderInspector(); } catch { /* */ }
  try {
    await Catalog.loadCategory(catLabel);
  } catch (err) {
    console.error(err);
    furnUi.error = err?.message || String(err);
  }
  lastInspectorKey = "";
  try { renderInspector(); draw(); } catch { /* */ }
}

async function applyFurniturePresetAsync(typeId) {
  try {
    await Catalog.ensureItem(typeId);
  } catch (err) {
    console.error(err);
  }
  applyFurniturePreset(typeId);
  lastInspectorKey = "";
  try { renderInspector(); draw(); } catch { /* */ }
}

function normalizeHexColor(c, fallback = "#8a7050") {
  const s = String(c || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return fallback;
}
function colorSwatchRow(current, dataAttr = "data-furn-color") {
  return furnitureColors().map((c) =>
    `<button type="button" class="color-swatch ${normalizeHexColor(current) === c.hex ? "on" : ""}" ${dataAttr}="${c.hex}" title="${c.label}" style="background:${c.hex}"></button>`
  ).join("");
}

/** Seed for brand-new documents — freeform Photoshop-style layers (not type-locked). */
const DEFAULT_LAYERS = [
  { id: "ly_1", name: "Layer 1", visible: true, locked: false, opacity: 1 },
];

/** Legacy type → layer id (migration only when an object has no layerId). */
const LEGACY_KIND_LAYER = {
  image: "ly_ref",
  room: "ly_rooms",
  wall: "ly_walls",
  opening: "ly_openings",
  door: "ly_doors",
  window: "ly_windows",
  cabinet: "ly_furniture",
  light: "ly_devices",
  fan: "ly_devices",
  socket: "ly_devices",
};

const LEGACY_LAYER_NAMES = {
  ly_ref: "Reference",
  ly_rooms: "Rooms",
  ly_walls: "Walls",
  ly_openings: "Openings",
  ly_doors: "Doors",
  ly_windows: "Windows",
  ly_furniture: "Furniture",
  ly_devices: "Devices",
};

const TOOLS = [
  { id: "select", label: "Select", tip: "Select & move", shortcut: "V", group: "navigate" },
  { id: "pan", label: "Pan", tip: "Pan view (or hold Space)", shortcut: "Space", group: "navigate" },
  { id: "wall", label: "Wall", tip: "Draw wall · Shift = ortho", shortcut: "W", group: "draw" },
  { id: "split", label: "Split", tip: "Split wall at point", shortcut: "S", group: "draw" },
  { id: "join", label: "Join", tip: "Join meeting walls into a polyline", shortcut: "J", group: "draw" },
  { id: "explode", label: "Explode", tip: "Explode polyline wall into segments", shortcut: "X", group: "draw" },
  { id: "cut", label: "Cut", tip: "Cut / trim wall", shortcut: "C", group: "draw" },
  { id: "room", label: "Room", tip: "Polygon room", shortcut: "R", group: "draw" },
  { id: "opening", label: "Opening", tip: "Passage opening", shortcut: "O", group: "openings" },
  { id: "door", label: "Door", tip: "Place door on wall", shortcut: "D", group: "openings" },
  { id: "window", label: "Window", tip: "Place window · sill + size", shortcut: "N", group: "openings" },
  { id: "cabinet", label: "Furnish", tip: "Place furniture · bed, sofa, table, cabinet…", shortcut: "B", group: "furnish" },
  { id: "light", label: "Light", tip: "Place light fixture", shortcut: "L", group: "devices" },
  { id: "fan", label: "Fan", tip: "Place ceiling fan", shortcut: "F", group: "devices" },
  { id: "socket", label: "Socket", tip: "Place socket / outlet", shortcut: "K", group: "devices" },
  { id: "measure", label: "Measure", tip: "Measure distance", shortcut: "M", group: "annotate" },
];

const TOOL_GROUPS = [
  { id: "navigate", label: "View" },
  { id: "draw", label: "Draw" },
  { id: "openings", label: "Openings" },
  { id: "furnish", label: "Furnish" },
  { id: "devices", label: "Devices" },
  { id: "annotate", label: "Annotate" },
];

const TOOL_ICONS = {
  select: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 8.5-6.2 1.6L9.5 21z" fill="currentColor"/></svg>`,
  pan: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M7.5 7.5 12 3l4.5 4.5M7.5 16.5 12 21l4.5-4.5M7.5 7.5 3 12l4.5 4.5M16.5 7.5 21 12l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  wall: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h16v8H4zM4 8V6m16 2V6M4 16v2m16-2v2M8 8v8m8-8v8" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`,
  split: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h6M14 12h6M12 4v16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="12" cy="12" r="2.25" fill="currentColor"/></svg>`,
  join: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h6M14 12h6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M10 9v6M14 9v6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`,
  cut: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 19 5M8.5 8.5a2.5 2.5 0 1 1-3.5-3.5 2.5 2.5 0 0 1 3.5 3.5zm10.5 10.5a2.5 2.5 0 1 1-3.5-3.5 2.5 2.5 0 0 1 3.5 3.5z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`,
  room: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 5 8l7-4 7 5-2 9z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="5" cy="8" r="1.4" fill="currentColor"/><circle cx="12" cy="4" r="1.4" fill="currentColor"/><circle cx="19" cy="9" r="1.4" fill="currentColor"/><circle cx="17" cy="18" r="1.4" fill="currentColor"/><circle cx="6" cy="18" r="1.4" fill="currentColor"/></svg>`,
  opening: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12M20 6v12M8 7h8v10H8z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><path d="M10 12h4" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-dasharray="2 2"/></svg>`,
  door: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 20V5h9a1 1 0 0 1 1 1v14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M7 20h12M7 5H5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/><circle cx="14.5" cy="12.5" r="1.1" fill="currentColor"/><path d="M16 5c3.5 2 5 5.5 5 8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".7"/></svg>`,
  window: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v12H5zM12 6v12M5 12h14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/></svg>`,
  cabinet: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h16v5H4zM6 9h5v5H6zM13 9h5v5h-5zM8 6h8v3H8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
  light: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.75"/></svg>`,
  fan: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 10c2-4 6-5 8-3-1 3-4 5-8 3zm0 4c-2 4-6 5-8 3 1-3 4-5 8-3zm2 0c4 2 5 6 3 8-3-1-5-4-3-8zm-4 0c-4-2-5-6-3-8 3 1 5 4 3 8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  socket: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="9.5" cy="10.5" r="1.3" fill="currentColor"/><circle cx="14.5" cy="10.5" r="1.3" fill="currentColor"/><path d="M9 15.5h6" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>`,
  measure: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17 17 4l3 3L7 20z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><path d="M8 13l3 3M11 10l3 3M14 7l3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};

let placeLight = {
  shape: "bulb",
  colorTempK: 3000,
  intensity: 1,
  lengthMm: 1200,
  rotationDeg: 0,
};
let placeFan = {
  blades: 3,
  diameterMm: 1200,
  hangMm: 320,
  speed: 2,
  rotationDeg: 0,
};
let placeSocket = {
  style: "single",
  rotationDeg: 0,
};
let placeCabinet = {
  type: "cabinet",
  kind: "base",
  doors: 2,
  drawers: 3,
  widthMm: 900,
  depthMm: 600,
  heightMm: 900,
  rotationDeg: 0,
  colorHex: "#a89070",
  curtainStyle: "cloth",
  foldMode: "both",
};

function applyFurniturePreset(typeId) {
  const def = furnitureDef(typeId);
  placeCabinet.type = def.id;
  placeCabinet.widthMm = def.widthMm;
  placeCabinet.depthMm = def.depthMm;
  placeCabinet.heightMm = def.heightMm;
  placeCabinet.colorHex = normalizeHexColor(def.color, placeCabinet.colorHex);
  if (def.hasDoors) {
    placeCabinet.doors = def.doors || 2;
    if (def.isCabinet || def.id === "cabinet" || def.id === "kitchen_island") {
      placeCabinet.kind = placeCabinet.kind === "wall" || placeCabinet.kind === "tall" || placeCabinet.kind === "drawer"
        ? placeCabinet.kind
        : "base";
      if (def.id === "kitchen_island") placeCabinet.kind = "base";
    }
  } else {
    placeCabinet.doors = 0;
  }
  if (def.isCurtain) {
    placeCabinet.curtainStyle = def.curtainStyle || placeCabinet.curtainStyle || "cloth";
  }
}

let placeDoor = {
  style: "swing",
  widthMm: OPENING_DEFAULT,
  heightMm: DOOR_HEIGHT_DEFAULT,
  sillMm: 0,
  hingeAt: "start",
  openSide: 1,
  openAngle: 85,
};
let placeWindow = {
  style: "sliding",
  widthMm: WINDOW_WIDTH_DEFAULT,
  heightMm: WINDOW_HEIGHT_DEFAULT,
  sillMm: WINDOW_SILL_DEFAULT,
};
/** @type {null | { kind: "door"|"window", wallId: string, t: number, t0: number, t1: number, hinge: {x:number,y:number}, closedDeg: number, p0: {x:number,y:number}, p1: {x:number,y:number} }} */
let placeHover = null;
let lastInspectorKey = "";

const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const mmX = (x) => x * S;
const mmY = (y) => (MAX_Y - y) * S;
function unit(dx, dy) {
  const L = Math.hypot(dx, dy) || 1;
  return { x: dx / L, y: dy / L };
}

/** Display units — document always stores millimetres. */
const MM_PER_INCH = 25.4;
function unitsMode() {
  return doc?.units === "imperial" ? "imperial" : "metric";
}
function isImperial() {
  return unitsMode() === "imperial";
}
function uSuffix() {
  return isImperial() ? "in" : "mm";
}
function uLabel(base) {
  return `${base} (${uSuffix()})`;
}
/** Format mm → display number string in current units. */
function fmtNum(mm, digits = 1) {
  if (mm == null || !Number.isFinite(Number(mm))) return "0";
  if (!isImperial()) return String(Math.round(Number(mm)));
  const inches = Number(mm) / MM_PER_INCH;
  return String(Math.round(inches * 10 ** digits) / 10 ** digits);
}
function fmtLen(mm) {
  return `${fmtNum(mm)} ${uSuffix()}`;
}
function fmtSize2(a, b) {
  return `${fmtNum(a)} × ${fmtNum(b)} ${uSuffix()}`;
}
function fmtSize3(a, b, c) {
  return `${fmtNum(a)}×${fmtNum(b)}×${fmtNum(c)} ${uSuffix()}`;
}
/** Parse UI value in current units → mm. Accepts ft/in like 3'6". */
function parseLen(raw, fallbackMm = 0) {
  if (raw == null || raw === "") return fallbackMm;
  const s = String(raw).trim().toLowerCase().replace(/,/g, "");
  if (!isImperial()) {
    const n = Number(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : fallbackMm;
  }
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(?:'|′|ft\.?)\s*(-?\d+(?:\.\d+)?)?\s*(?:"|″|in\.?)?$/);
  if (m) {
    const feet = parseFloat(m[1]) || 0;
    const inches = m[2] != null && m[2] !== "" ? parseFloat(m[2]) : 0;
    return Math.round((feet * 12 + inches) * MM_PER_INCH);
  }
  const n = parseFloat(s.replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n)) return fallbackMm;
  return Math.round(n * MM_PER_INCH);
}
function lenStep(coarse = false) {
  return isImperial() ? (coarse ? 1 : 0.5) : (coarse ? 50 : 10);
}
function lenMin(mmMin) {
  const n = Number(fmtNum(mmMin));
  return Number.isFinite(n) ? n : 0;
}
function lenAttrs(extra = {}) {
  const min = extra.minMm != null ? ` min="${lenMin(extra.minMm)}"` : "";
  const step = ` step="${lenStep(!!extra.coarse)}"`;
  return `data-len="1" type="number"${min}${step}`;
}
/** Read a length field: UI units → mm (metric identity). */
function readLen(input, fallbackMm = 0) {
  if (input?.dataset?.len != null) return parseLen(input.value, fallbackMm);
  const n = Number(input?.value);
  return Number.isFinite(n) ? n : fallbackMm;
}

/** Polyline wall helpers — `points[]` is source of truth; `a`/`b` mirror first/last. */
const WALL_JOIN_TOL = 40;

function wallPoints(w) {
  if (!w) return [];
  if (Array.isArray(w.points) && w.points.length >= 2) {
    return w.points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  }
  if (w.a && w.b) return [{ x: w.a.x, y: w.a.y }, { x: w.b.x, y: w.b.y }];
  return [];
}
function syncWallAb(w) {
  if (!w) return w;
  let pts = wallPoints(w);
  if (pts.length < 2) return w;
  // Drop near-duplicate consecutive vertices
  let cleaned = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(cleaned[cleaned.length - 1], pts[i]) > 1) cleaned.push(pts[i]);
  }
  if (cleaned.length < 2) cleaned.push(pts[pts.length - 1]);
  // Closed ring: repeated first vertex → flag + drop duplicate
  if (cleaned.length >= 3 && dist(cleaned[0], cleaned[cleaned.length - 1]) <= WALL_JOIN_TOL) {
    w.closed = true;
    cleaned = cleaned.slice(0, -1);
  }
  w.points = cleaned;
  w.a = { ...cleaned[0] };
  w.b = { ...cleaned[cleaned.length - 1] };
  return w;
}
function normalizeWall(w, defaults = {}) {
  const th = w.thickness ?? defaults.wallThicknessMm ?? 120;
  const ht = w.height ?? defaults.wallHeightMm ?? REF_WALL_H;
  const out = {
    ...w,
    id: w.id || uid("w"),
    thickness: th,
    height: ht,
    elevMm: Math.max(0, Number(w.elevMm) || 0),
    closed: !!w.closed,
  };
  if (Array.isArray(w.points) && w.points.length >= 2) {
    out.points = w.points.map((p) => ({ x: p.x, y: p.y }));
  } else if (w.a && w.b) {
    out.points = [{ x: w.a.x, y: w.a.y }, { x: w.b.x, y: w.b.y }];
  } else {
    out.points = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
  }
  return syncWallAb(out);
}
function wallEdges(w) {
  const pts = wallPoints(w);
  const edges = [];
  for (let i = 0; i < pts.length - 1; i++) {
    edges.push({ i, a: pts[i], b: pts[i + 1], len: dist(pts[i], pts[i + 1]) || 1 });
  }
  // Closed outline: implicit edge from last → first
  if (w.closed && pts.length >= 3) {
    edges.push({
      i: pts.length - 1,
      a: pts[pts.length - 1],
      b: pts[0],
      len: dist(pts[pts.length - 1], pts[0]) || 1,
      closing: true,
    });
  }
  return edges;
}
function wallLen(w) {
  return wallEdges(w).reduce((s, e) => s + e.len, 0) || 1;
}
/** Resize first segment only when 2-pt; for polylines scale whole chain from start. */
function setWallLength(w, lengthMm) {
  syncWallAb(w);
  const pts = wallPoints(w);
  if (pts.length < 2) return;
  const cur = wallLen(w);
  const target = Math.max(100, Number(lengthMm) || cur);
  if (!Number.isFinite(cur) || cur < 1e-6) return;
  const scale = target / cur;
  const origin = pts[0];
  for (let i = 1; i < pts.length; i++) {
    pts[i] = {
      x: origin.x + (pts[i].x - origin.x) * scale,
      y: origin.y + (pts[i].y - origin.y) * scale,
    };
  }
  w.points = pts;
  syncWallAb(w);
  reframeDoorsOnWall(w.id);
}
function pointAt(w, t) {
  const edges = wallEdges(w);
  if (!edges.length) return { x: 0, y: 0 };
  const L = edges.reduce((s, e) => s + e.len, 0) || 1;
  let rem = Math.max(0, Math.min(1, t)) * L;
  for (const e of edges) {
    if (rem <= e.len || e === edges[edges.length - 1]) {
      const u = e.len > 1e-9 ? rem / e.len : 0;
      const uu = Math.max(0, Math.min(1, u));
      return { x: e.a.x + (e.b.x - e.a.x) * uu, y: e.a.y + (e.b.y - e.a.y) * uu };
    }
    rem -= e.len;
  }
  const last = edges[edges.length - 1];
  return { ...last.b };
}
function projectWall(w, p) {
  const edges = wallEdges(w);
  if (!edges.length) return { t: 0, q: { x: 0, y: 0 }, dist: Infinity, L: 1 };
  const Ltot = edges.reduce((s, e) => s + e.len, 0) || 1;
  let best = null;
  let acc = 0;
  for (const e of edges) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const L2 = dx * dx + dy * dy || 1;
    let u = ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / L2;
    u = Math.max(0, Math.min(1, u));
    const q = { x: e.a.x + dx * u, y: e.a.y + dy * u };
    const d = dist(p, q);
    const t = (acc + u * e.len) / Ltot;
    if (!best || d < best.dist) best = { t, q, dist: d, L: Ltot, edge: e.i, u };
    acc += e.len;
  }
  return best;
}
function nearEnds(a, b, tol = WALL_JOIN_TOL) {
  return dist(a, b) <= tol;
}
function collinear(w1, w2, angTol = 0.08) {
  // Compare last edge of w1 with first edge of w2 for join eligibility
  const e1 = wallEdges(w1);
  const e2 = wallEdges(w2);
  if (!e1.length || !e2.length) return false;
  const a1 = Math.atan2(e1[e1.length - 1].b.y - e1[e1.length - 1].a.y, e1[e1.length - 1].b.x - e1[e1.length - 1].a.x);
  const a2 = Math.atan2(e2[0].b.y - e2[0].a.y, e2[0].b.x - e2[0].a.x);
  let d = Math.abs(a1 - a2) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d <= angTol;
}
/** True if entire wall is a single straight segment (for length UI). */
function wallIsStraight(w) {
  return !w?.closed && wallPoints(w).length === 2;
}
function wallSegments(doc, wall) {
  const opens = (doc.openings || [])
    .filter((o) => o.wallId === wall.id)
    .map((o) => [Math.min(o.t0, o.t1), Math.max(o.t0, o.t1)])
    .sort((a, b) => a[0] - b[0]);
  const segs = [];
  let t = 0;
  for (const [a, b] of opens) {
    if (a > t + 1e-6) segs.push([t, a]);
    t = Math.max(t, b);
  }
  if (t < 1 - 1e-6) segs.push([t, 1]);
  return segs;
}

/* ---------- state ---------- */
let doc = null;
let tool = "select";
let operate = false;
let ohClient = null;
let snapOn = true;
let selected = null; // primary { kind, id, grip? } — always selection[0]
let selection = []; // multi-select [{ kind, id, grip? }, ...]

function ensureOhClient() {
  if (ohClient) return ohClient;
  ohClient = createOpenhabClient({
    getDoc: () => doc,
    onApplied() {
      draw();
    },
  });
  if (ohClient.enabled) ohClient.start();
  return ohClient;
}

function syncOhMenuLabel() {
  const el = document.getElementById("ohSyncMenu");
  if (!el) return;
  const c = ensureOhClient();
  const st = c.status;
  if (!c.enabled) {
    el.textContent = "Enable openHAB sync";
    return;
  }
  el.textContent = st.ok
    ? "Disable openHAB sync · connected"
    : `Disable openHAB sync · ${st.message || "…"}`;
}

async function toggleOhSync() {
  const c = ensureOhClient();
  const next = !c.enabled;
  c.setEnabled(next);
  await c.refreshStatus();
  if (next) {
    try {
      await c.pullStates();
      draw();
    } catch { /* */ }
  }
  syncOhMenuLabel();
  toast(next
    ? (c.status.ok ? "openHAB sync on" : `openHAB: ${c.status.message}`)
    : "openHAB sync off",
  next && !c.status.ok ? "err" : "ok");
  msg(next ? "openHAB sync enabled" : "openHAB sync disabled");
}
let joinPick = null;
let history = [];
let future = [];
let viewBox = { x: -160, y: 0, w: 1320, h: 1280 };
let pan = null;
let drag = null;
let marquee = null; // { x0,y0,x1,y1 } in mm
let draft = null; // tool-specific
let clipboard = null; // [{ kind, obj, opening? }, ...] or legacy single
let spaceDown = false;
let shiftDown = false;
let dirty = false;
let serverOk = true;
let cursorMm = { x: 0, y: 0 };
let measurePts = null;
let activeLayerId = "ly_1";
let liveSync = null;

/** Points along wall from arc-length t0..t1, including intermediate vertices. */
function wallSpanPoints(w, t0, t1) {
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  const out = [pointAt(w, a)];
  const pts = wallPoints(w);
  const L = wallLen(w) || 1;
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += dist(pts[i - 1], pts[i]);
    const t = acc / L;
    if (t > a + 1e-6 && t < b - 1e-6) out.push({ ...pts[i] });
  }
  const end = pointAt(w, b);
  if (dist(out[out.length - 1], end) > 1) out.push(end);
  return out;
}


function syncPrimary() {
  selected = selection[0] || null;
}
function isInSelection(kind, id) {
  return selection.some((s) => s.kind === kind && s.id === id);
}
function setSelection(list) {
  selection = (list || []).map((s) => ({ kind: s.kind, id: s.id, grip: s.grip || null }));
  syncPrimary();
  lastInspectorKey = "";
}
function setSelected(kind, id, { additive = false, grip = null } = {}) {
  if (!kind || !id) {
    setSelection([]);
    return;
  }
  if (additive) {
    if (isInSelection(kind, id)) {
      setSelection(selection.filter((s) => !(s.kind === kind && s.id === id)));
    } else {
      setSelection([...selection, { kind, id, grip }]);
    }
  } else {
    setSelection([{ kind, id, grip }]);
  }
}
function selectionObjects() {
  return selection.map((s) => ({ ...s, o: findDocObj(s.kind, s.id) })).filter((x) => x.o);
}
function findDocObj(kind, id) {
  if (!doc) return null;
  if (kind === "wall") return doc.walls.find((x) => x.id === id);
  if (kind === "door") return doc.doors.find((x) => x.id === id);
  if (kind === "window") return (doc.windows || []).find((x) => x.id === id);
  if (kind === "light") return doc.lights.find((x) => x.id === id);
  if (kind === "fan") return doc.fans.find((x) => x.id === id);
  if (kind === "socket") return (doc.sockets || []).find((x) => x.id === id);
  if (kind === "cabinet") return (doc.cabinets || []).find((x) => x.id === id);
  if (kind === "room") return doc.rooms.find((x) => x.id === id);
  if (kind === "image") return doc.images.find((x) => x.id === id);
  if (kind === "opening") return doc.openings.find((x) => x.id === id);
  return null;
}
function clearSelection() {
  setSelection([]);
}

const wrap = document.getElementById("svgWrap");
const svg = document.getElementById("plan");
const toolsEl = document.getElementById("tools");
const inspector = document.getElementById("inspector");
const objList = document.getElementById("objList");
const layersEl = document.getElementById("layers");
const banner = document.getElementById("banner");
const fileImport = document.getElementById("fileImport");
const fileImage = document.getElementById("fileImage");

function msg(t) {
  document.getElementById("statMsg").textContent = t;
}
function toast(text, kind = "ok") {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  host.appendChild(el);
  window.setTimeout(() => el.remove(), 2800);
}
function setBanner(text) {
  if (!text) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  banner.textContent = text;
  banner.classList.remove("hidden");
}
function syncStatus() {
  const t = TOOLS.find((x) => x.id === tool);
  const toolLabel = operate
    ? "Operate mode"
    : t
      ? `${t.label}${t.shortcut ? ` (${t.shortcut})` : ""}`
      : tool;
  document.getElementById("statTool").textContent = toolLabel;
  document.getElementById("statSnap").textContent = [
    snapOn ? `Snap ${fmtLen(doc?.snapMm || 50)}` : "Snap off",
    shiftDown ? "Ortho XY" : null,
    isImperial() ? "Imperial" : "Metric",
  ].filter(Boolean).join(" · ");
  document.getElementById("statCursor").textContent = isImperial()
    ? `${fmtNum(cursorMm.x)}, ${fmtNum(cursorMm.y)} in`
    : `${Math.round(cursorMm.x)}, ${Math.round(cursorMm.y)} mm`;
  wrap.classList.toggle("pan", tool === "pan" || spaceDown);
  document.querySelectorAll("#tools .tool-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool && !operate);
  });
  document.querySelectorAll("[data-act=mode-cad]").forEach((b) => b.classList.toggle("active", !operate));
  document.querySelectorAll("[data-act=mode-operate]").forEach((b) => b.classList.toggle("active", operate));
  document.querySelectorAll("[data-act=units-metric]").forEach((b) => b.classList.toggle("active", !isImperial()));
  document.querySelectorAll("[data-act=units-imperial]").forEach((b) => b.classList.toggle("active", isImperial()));
  toolsEl.classList.toggle("operate-mode", !!operate);
  syncOhMenuLabel();
}

function pushHistory() {
  if (!doc) return;
  history.push(clone(doc));
  if (history.length > 50) history.shift();
  future = [];
  dirty = true;
  saveDraft();
}
function undo() {
  if (!history.length) return;
  future.push(clone(doc));
  doc = history.pop();
  clearSelection();
  dirty = true;
  saveDraft();
  draw();
  msg("Undo");
}
function redo() {
  if (!future.length) return;
  history.push(clone(doc));
  doc = future.pop();
  clearSelection();
  dirty = true;
  saveDraft();
  draw();
  msg("Redo");
}

function saveDraft() {
  if (!doc) return;
  try {
    const slim = clone(doc);
    // avoid blowing localStorage with huge embedded images
    for (const im of slim.images || []) {
      if (typeof im.src === "string" && im.src.startsWith("data:") && im.src.length > 200000) {
        im.src = "";
        im._draftDropped = true;
      }
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), doc: slim }));
  } catch { /* ignore quota */ }
}

function syncDraftKey() {
  DRAFT_KEY = Models.draftKeyForModel(activeModel?.id || Models.getActiveModelId());
}

function syncModelChrome() {
  const userEl = document.getElementById("modelUser");
  const modelEl = document.getElementById("modelSelect");
  const verEl = document.getElementById("versionSelect");
  if (userEl && document.activeElement !== userEl) userEl.value = Models.getUser() || "";
  if (modelEl) {
    const opts = modelsCache.map((m) => {
      const mine = m.owner === Models.getUser() ? "" : ` (${m.owner})`;
      return `<option value="${m.id}" ${activeModel?.id === m.id ? "selected" : ""}>${m.name}${mine}</option>`;
    }).join("");
    modelEl.innerHTML = opts || `<option value="">No models</option>`;
  }
  if (verEl) {
    const vers = activeModel?.versions || [];
    verEl.innerHTML = [
      `<option value="">Working copy</option>`,
      ...vers.slice().reverse().map((v) => `<option value="${v.id}">${v.label}</option>`),
    ].join("");
  }
  const brand = document.querySelector(".topbar-titles strong");
  if (brand && activeModel) brand.textContent = activeModel.name;
  const sub = document.querySelector(".topbar-titles span");
  if (sub && activeModel) {
    const n = activeModel.versionCount ?? (activeModel.versions || []).length;
    sub.textContent = `CAD · ${n} version${n === 1 ? "" : "s"} · ${activeModel.owner}`;
  }
}

async function refreshModelsList() {
  const data = await Models.listModels(Models.getUser());
  modelsCache = data.models || [];
  if (activeModel) {
    activeModel = modelsCache.find((m) => m.id === activeModel.id) || activeModel;
  }
  syncModelChrome();
}

async function loadShared() {
  try {
    Models.ensureUser();
    const { model, doc: remote, models } = await Models.loadActiveModel();
    activeModel = model;
    modelsCache = models || [];
    syncDraftKey();
    let draftWrap = null;
    try { draftWrap = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { /* */ }
    const sharedT = Date.parse(remote?.updatedAt || 0) || 0;
    const draftT = draftWrap?.savedAt || 0;
    if (draftWrap?.doc && draftT > sharedT + 2000) {
      doc = normalize(draftWrap.doc);
      dirty = true;
      setBanner("Local draft is newer than saved model — Save to publish, or Reset to discard.");
    } else {
      doc = normalize(remote);
      dirty = false;
      setBanner("");
    }
    serverOk = true;
    syncModelChrome();
    return;
  } catch (err) {
    console.warn(err);
    serverOk = false;
  }
  // fallback legacy
  syncDraftKey();
  let shared = null;
  try {
    const r = await fetch("./layout.json", { cache: "no-store" });
    if (r.ok) shared = await r.json();
  } catch { /* */ }
  let draftWrap = null;
  try { draftWrap = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { /* */ }
  if (shared && draftWrap?.doc) {
    const sharedT = Date.parse(shared.updatedAt || 0) || 0;
    const draftT = draftWrap.savedAt || 0;
    if (draftT > sharedT + 2000) {
      doc = normalize(draftWrap.doc);
      dirty = true;
      setBanner("Local draft is newer — Save when the server is online.");
      return;
    }
  }
  if (shared) { doc = normalize(shared); dirty = false; setBanner(""); return; }
  if (draftWrap?.doc) {
    doc = normalize(draftWrap.doc);
    dirty = true;
    setBanner("Working from local draft (models API offline).");
    return;
  }
  msg("Missing layout");
  doc = { version: 2, gridMm: 50, snapMm: 50, units: "metric", walls: [], openings: [], doors: [], windows: [], lights: [], fans: [], sockets: [], cabinets: [], rooms: [] };
}

function openModal({ title, bodyHtml, okLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal");
    const titleEl = document.getElementById("modalTitle");
    const body = document.getElementById("modalBody");
    const ok = document.getElementById("modalOk");
    if (!modal || !body || !ok) { resolve(null); return; }
    titleEl.textContent = title;
    body.innerHTML = bodyHtml;
    ok.textContent = okLabel;
    ok.classList.toggle("danger", !!danger);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    const first = body.querySelector("input, textarea, select");
    first?.focus();
    first?.select?.();

    function close(result) {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
      modal.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      ok.onclick = null;
      resolve(result);
    }
    function onClick(e) {
      if (e.target.closest("[data-modal-dismiss]")) close(null);
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(null); }
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        ok.click();
      }
    }
    ok.onclick = () => {
      const values = {};
      body.querySelectorAll("[data-field]").forEach((el) => {
        values[el.dataset.field] = el.value;
      });
      close(values);
    };
    modal.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
  });
}

async function promptText({ title, label, value = "", okLabel = "OK" }) {
  const res = await openModal({
    title,
    okLabel,
    bodyHtml: `<label>${label}<input data-field="text" type="text" value="${String(value).replace(/"/g, "&quot;")}" /></label>`,
  });
  if (!res) return null;
  return res.text ?? "";
}

async function confirmModal({ title, message, okLabel = "Confirm", danger = false }) {
  const res = await openModal({
    title,
    okLabel,
    danger,
    bodyHtml: `<p class="modal-msg">${message}</p>`,
  });
  return !!res;
}

async function switchToModel(id) {
  if (!id || id === activeModel?.id) return;
  if (dirty && !(await confirmModal({
    title: "Switch model",
    message: "Unsaved changes stay in this model's local draft. Continue?",
    okLabel: "Switch",
  }))) return;
  saveDraft();
  Models.setActiveModelId(id);
  history = [];
  future = [];
  clearSelection();
  liveSync?.setModelId(id);
  await loadShared();
  draw();
  msg(`Opened ${activeModel?.name || "model"}`);
  toast(`Model: ${activeModel?.name || id}`);
}

async function createNewModel() {
  const name = await promptText({ title: "New model", label: "Name", value: "Untitled model", okLabel: "Create" });
  if (name == null) return;
  if (dirty) saveDraft();
  const data = await Models.createModel({
    name: name.trim() || "Untitled model",
    source: "empty",
  });
  activeModel = data.model;
  Models.setActiveModelId(data.model.id);
  syncDraftKey();
  history = [];
  future = [];
  clearSelection();
  doc = normalize(data.doc);
  dirty = false;
  liveSync?.setModelId(data.model.id);
  await refreshModelsList();
  draw();
  toast("Created model");
  msg("New model");
}

async function duplicateModel() {
  if (!activeModel) return;
  const name = await promptText({
    title: "Duplicate model",
    label: "Name",
    value: `${activeModel.name} copy`,
    okLabel: "Duplicate",
  });
  if (name == null) return;
  const data = await Models.createModel({
    name: name.trim() || `${activeModel.name} copy`,
    source: "model",
    copyFromId: activeModel.id,
    doc,
  });
  activeModel = data.model;
  Models.setActiveModelId(data.model.id);
  syncDraftKey();
  history = [];
  future = [];
  doc = normalize(data.doc);
  dirty = false;
  liveSync?.setModelId(data.model.id);
  await refreshModelsList();
  draw();
  toast("Duplicated model");
}

async function renameActiveModel() {
  if (!activeModel) return;
  const name = await promptText({ title: "Rename model", label: "Name", value: activeModel.name, okLabel: "Rename" });
  if (name == null || !name.trim()) return;
  const data = await Models.renameModel(activeModel.id, name.trim());
  activeModel = data.model;
  await refreshModelsList();
  toast("Renamed");
}

async function saveVersionSnapshot() {
  if (!activeModel || !doc) return;
  const n = (activeModel.versions || []).length + 1;
  const res = await openModal({
    title: "Save version",
    okLabel: "Save version",
    bodyHtml: `
      <label>Label<input data-field="label" type="text" value="v${n}" /></label>
      <label>Note (optional)<textarea data-field="note" placeholder="What changed…"></textarea></label>`,
  });
  if (!res) return;
  await saveShared({ quiet: true });
  const data = await Models.snapshotVersion(activeModel.id, {
    label: (res.label || "").trim() || `v${n}`,
    note: res.note || "",
    doc,
  });
  activeModel = data.model;
  await refreshModelsList();
  toast(`Version saved · ${data.version?.label || res.label}`);
  msg("Version snapshot");
}

async function restoreSelectedVersion() {
  const verEl = document.getElementById("versionSelect");
  const vid = verEl?.value;
  if (!activeModel) return;
  if (!vid) {
    // reload working copy from server
    const full = await Models.getModel(activeModel.id);
    pushHistory();
    doc = normalize(full.doc);
    clearSelection();
    dirty = false;
    saveDraft();
    draw();
    msg("Reloaded working copy");
    return;
  }
  if (!(await confirmModal({
    title: "Restore version",
    message: "Restore this version into the working copy? Current working state is kept in undo.",
    okLabel: "Restore",
  }))) return;
  pushHistory();
  const data = await Models.restoreVersion(activeModel.id, vid);
  doc = normalize(data.doc);
  activeModel = data.model;
  clearSelection();
  dirty = false;
  saveDraft();
  await refreshModelsList();
  draw();
  toast(`Restored ${data.restoredFrom?.label || "version"}`);
  msg("Version restored");
}

async function publishShareLink() {
  if (!activeModel?.id) { toast("No model", "err"); return; }
  try {
    await saveShared({ quiet: true });
  } catch { /* draft ok */ }
  const verEl = document.getElementById("versionSelect");
  const versionId = verEl?.value || null;
  try {
    const data = await Models.createShare(activeModel.id, {
      label: versionId ? "Version share" : "Working copy",
      versionId: versionId || undefined,
    });
    const path = data?.share?.url || `/view.html?t=${data?.share?.token}`;
    const full = Models.shareUrlFromPath(path);
    try {
      await navigator.clipboard.writeText(full);
      toast("Share link copied");
    } catch {
      await openModal({
        title: "Share link",
        okLabel: "Done",
        bodyHtml: `<label>Copy this link<input data-field="link" type="text" value="${full.replace(/"/g, "&quot;")}" readonly /></label>`,
      });
    }
    msg("Share published");
  } catch (err) {
    if (err?.status === 401 || err?.code === "auth_required") {
      const ok = await ensureAuthed({ toast, force: true });
      if (ok) return publishShareLink();
    }
    throw err;
  }
}

async function exportModelPack() {
  if (!activeModel?.id) { toast("No model", "err"); return; }
  try {
    const blob = await Models.exportPack(activeModel.id);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(activeModel.name || "model").replace(/[^a-zA-Z0-9._-]+/g, "_")}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Export pack downloaded");
  } catch (err) {
    if (err?.status === 401 || err?.code === "auth_required") {
      const ok = await ensureAuthed({ toast, force: true });
      if (ok) return exportModelPack();
    }
    throw err;
  }
}

async function deleteActiveModel() {
  if (!activeModel) return;
  if (!(await confirmModal({
    title: "Delete model",
    message: `Delete model “${activeModel.name}” and all its versions? This cannot be undone.`,
    okLabel: "Delete",
    danger: true,
  }))) return;
  const id = activeModel.id;
  await Models.deleteModel(id);
  Models.setActiveModelId("");
  activeModel = null;
  liveSync?.setModelId(null);
  await loadShared();
  history = [];
  future = [];
  draw();
  toast("Model deleted");
}

function normalizeLight(l) {
  return {
    id: l.id || uid("lt"),
    x: l.x ?? 0,
    y: l.y ?? 0,
    on: !!l.on,
    label: l.label || "Light",
    shape: l.shape || "bulb",
    colorTempK: Math.max(2200, Math.min(6500, Number(l.colorTempK) || 3000)),
    intensity: Math.max(0, Math.min(2, Number(l.intensity) ?? 1)),
    lengthMm: Math.max(300, Number(l.lengthMm) || 1200),
    rotationDeg: Number(l.rotationDeg) || 0,
    elevMm: Number(l.elevMm) || 0,
    mountFrac: l.mountFrac != null ? Number(l.mountFrac) : (1 - HEIGHT_PRESETS.lightBelowCeiling),
    layerId: l.layerId || null,
  };
}
function normalizeFan(f) {
  return {
    id: f.id || uid("fn"),
    x: f.x ?? 0,
    y: f.y ?? 0,
    on: !!f.on,
    label: f.label || "Fan",
    blades: Math.max(2, Math.min(6, Number(f.blades) || 3)),
    diameterMm: Math.max(600, Number(f.diameterMm) || 1200),
    hangMm: Math.max(80, Math.min(1200, Number(f.hangMm) || 320)),
    speed: Math.max(0, Math.min(3, Number(f.speed) ?? 2)),
    rotationDeg: Number(f.rotationDeg) || 0,
    layerId: f.layerId || null,
  };
}
function defaultSocketElev(style) {
  if (style === "floor") return HEIGHT_PRESETS.socketFloor;
  if (style === "panel" || style === "board") return HEIGHT_PRESETS.panelBoard;
  return HEIGHT_PRESETS.socket;
}
function normalizeSocket(s) {
  const style = SOCKET_STYLES.some((x) => x.id === s.style) ? s.style : "single";
  return {
    id: s.id || uid("sk"),
    x: s.x ?? 0,
    y: s.y ?? 0,
    label: s.label || (style === "panel" ? "Electric board" : "Socket"),
    style,
    rotationDeg: Number(s.rotationDeg) || 0,
    elevMm: s.elevMm != null ? Math.max(0, Number(s.elevMm) || 0) : defaultSocketElev(style),
    layerId: s.layerId || null,
  };
}
function normalizeCabinet(c) {
  const type = c.type || "cabinet";
  const def = furnitureDef(type);
  const isCab = !!(def.isCabinet || type === "cabinet" || type === "kitchen_island");
  const kind = isCab
    ? (CABINET_KINDS.some((k) => k.id === c.kind) ? c.kind : "base")
    : (c.kind || null);
  const kindDef = CABINET_KINDS.find((k) => k.id === kind);
  const doors = def.hasDoors && kind !== "drawer"
    ? Math.max(1, Math.min(6, Number(c.doors) || def.doors || 2))
    : (def.hasDoors && kind === "drawer" ? 0 : (def.hasDoors ? Math.max(1, Math.min(6, Number(c.doors) || def.doors || 2)) : 0));
  const drawers = isCab && kind === "drawer"
    ? Math.max(2, Math.min(5, Number(c.drawers) || 3))
    : (isCab ? Math.max(2, Math.min(5, Number(c.drawers) || 3)) : undefined);
  const curtainStyle = def.isCurtain
    ? (curtainStyles().some((s) => s.id === c.curtainStyle)
      ? c.curtainStyle
      : (def.curtainStyle || "cloth"))
    : undefined;
  const foldMode = def.isCurtain
    ? (foldModes().some((m) => m.id === c.foldMode) ? c.foldMode : "both")
    : undefined;
  const minD = def.isCurtain || type === "mirror" || type === "tv" || type === "wall_art" ? 40 : 150;
  return {
    id: c.id || uid("fur"),
    type,
    x: c.x ?? 0,
    y: c.y ?? 0,
    label: c.label || def.label,
    kind: isCab ? kind : undefined,
    doors: kind === "drawer" ? 0 : doors,
    drawers: isCab ? drawers : undefined,
    curtainStyle,
    foldMode,
    colorHex: normalizeHexColor(c.colorHex || def.color, def.color),
    widthMm: Math.max(200, Number(c.widthMm) || def.widthMm),
    depthMm: Math.max(minD, Number(c.depthMm) || def.depthMm),
    heightMm: Math.max(20, Number(c.heightMm) || (kindDef?.heightMm ?? def.heightMm)),
    rotationDeg: Number(c.rotationDeg) || 0,
    open: (def.hasDoors || def.hasOpen) ? !!c.open : false,
    layerId: c.layerId || null,
  };
}
function kelvinFill(k) {
  const t = Math.max(2200, Math.min(6500, k || 3000));
  if (t < 3000) return "#ff9a4a";
  if (t < 3500) return "#ffb86b";
  if (t < 4500) return "#ffe0a0";
  if (t < 5500) return "#fff6d0";
  return "#dce9ff";
}
function ensureDevicesVisible() {
  // Prefer showing the active layer; legacy docs may still have ly_devices
  const L = getLayer(activeLayerOrFirst()) || getLayer("ly_devices");
  if (L && L.visible === false) {
    L.visible = true;
  }
}
function ensureFurnitureVisible() {
  const L = getLayer(activeLayerOrFirst()) || getLayer("ly_furniture");
  if (L && L.visible === false) {
    L.visible = true;
  }
}

function normalizeRoom(r) {
  const wallIds = Array.isArray(r.wallIds)
    ? r.wallIds.map(String).filter(Boolean)
    : [];
  if (Array.isArray(r.points) && r.points.length >= 3) {
    return {
      id: r.id || uid("rm"),
      label: r.label || "Room",
      points: r.points.map((p) => ({ x: p.x, y: p.y })),
      wallIds,
      layerId: r.layerId || null,
    };
  }
  const x = r.x ?? 0, y = r.y ?? 0, w = r.w ?? 1000, h = r.h ?? 1000;
  return {
    id: r.id || uid("rm"),
    label: r.label || "Room",
    points: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    wallIds,
    layerId: r.layerId || null,
  };
}
function roomPoints(r) {
  return normalizeRoom(r).points;
}
function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const hit = ((yi > p.y) !== (yj > p.y))
      && (p.x < ((xj - xi) * (p.y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}
function roomLit(r) {
  const pts = roomPoints(r);
  return doc.lights.some((l) => l.on && pointInPoly(l, pts));
}
function defaultWallHeight() {
  return doc?.wallHeightMm ?? REF_WALL_H;
}
function defaultDoorHeight() {
  return scaleH(DOOR_HEIGHT_DEFAULT, REF_WALL_H, defaultWallHeight());
}
function defaultWindowHeight() {
  return scaleH(WINDOW_HEIGHT_DEFAULT, REF_WALL_H, defaultWallHeight());
}
function defaultWindowSill() {
  return scaleH(WINDOW_SILL_DEFAULT, REF_WALL_H, defaultWallHeight());
}
function nearPlace(value, preset, fromH) {
  return near(value, preset) || near(value, scaleH(preset, REF_WALL_H, fromH));
}
function wallHeight(w) {
  return ceilingMm(doc, w);
}
function wallElev(w) {
  return Math.max(0, Number(w?.elevMm) || 0);
}
function wallThickness(w) {
  return w.thickness ?? doc?.wallThicknessMm ?? 120;
}

function normalizeOpening(o) {
  return {
    id: o.id || uid("o"),
    wallId: o.wallId,
    t0: o.t0,
    t1: o.t1,
    type: o.type || "passage", // passage | door | window
    heightMm: o.heightMm ?? (o.type === "window" ? defaultWindowHeight() : defaultDoorHeight()),
    sillMm: o.sillMm ?? (o.type === "window" ? defaultWindowSill() : 0),
    layerId: o.layerId || null,
  };
}
function normalizeDoor(d) {
  const openDelta = d.openDelta ?? 85;
  const openSide = d.openSide != null ? (Number(d.openSide) >= 0 ? 1 : -1) : (openDelta >= 0 ? 1 : -1);
  const openAngle = Math.abs(d.openAngle ?? openDelta ?? 85) || 85;
  return {
    id: d.id || uid("door"),
    openingId: d.openingId || null,
    hinge: d.hinge ? { ...d.hinge } : { x: 0, y: 0 },
    len: d.len ?? d.widthMm ?? OPENING_DEFAULT,
    widthMm: d.widthMm ?? d.len ?? OPENING_DEFAULT,
    heightMm: d.heightMm ?? defaultDoorHeight(),
    sillMm: d.sillMm ?? 0,
    style: d.style || "swing",
    hingeAt: d.hingeAt === "end" ? "end" : "start",
    openSide,
    openAngle,
    openDelta: openSide * openAngle, // legacy sync
    closedOffsetDeg: Number(d.closedOffsetDeg) || 0,
    closedDeg: d.closedDeg ?? 0,
    open: !!d.open,
    label: d.label || "Door",
    layerId: d.layerId || null,
  };
}
function normalizeWindow(w) {
  return {
    id: w.id || uid("win"),
    openingId: w.openingId || null,
    wallId: w.wallId || null,
    style: w.style || "sliding",
    widthMm: w.widthMm ?? WINDOW_WIDTH_DEFAULT,
    heightMm: w.heightMm ?? defaultWindowHeight(),
    sillMm: w.sillMm ?? defaultWindowSill(),
    label: w.label || "Window",
    open: !!w.open,
    layerId: w.layerId || null,
  };
}
function openingWidth(o) {
  const w = doc.walls.find((x) => x.id === o.wallId);
  if (!w) return 0;
  return Math.abs(o.t1 - o.t0) * wallLen(w);
}
function setOpeningWidth(o, widthMm) {
  const w = doc.walls.find((x) => x.id === o.wallId);
  if (!w) return;
  const L = wallLen(w);
  const mid = (Math.min(o.t0, o.t1) + Math.max(o.t0, o.t1)) / 2;
  const half = (Math.max(100, widthMm) / 2) / L;
  o.t0 = Math.max(0, mid - half);
  o.t1 = Math.min(1, mid + half);
}
function setOpeningCenter(o, centerT) {
  const w = doc.walls.find((x) => x.id === o.wallId);
  if (!w) return;
  const L = wallLen(w) || 1;
  const width = Math.max(200, openingWidth(o));
  const half = (width / 2) / L;
  let t0 = centerT - half;
  let t1 = centerT + half;
  if (t0 < 0) { t1 = Math.min(1, t1 - t0); t0 = 0; }
  if (t1 > 1) { t0 = Math.max(0, t0 - (t1 - 1)); t1 = 1; }
  o.t0 = t0;
  o.t1 = t1;
}
/** Move one end of an opening along its wall (mouse resize). */
function setOpeningEnd(o, which, p) {
  const w = doc.walls.find((x) => x.id === o.wallId);
  if (!w) return;
  const L = wallLen(w) || 1;
  const minT = 200 / L;
  const { t } = projectWall(w, p);
  let t0 = Math.min(o.t0, o.t1);
  let t1 = Math.max(o.t0, o.t1);
  if (which === "t0") {
    t0 = Math.max(0, Math.min(t, t1 - minT));
  } else {
    t1 = Math.min(1, Math.max(t, t0 + minT));
  }
  o.t0 = t0;
  o.t1 = t1;
}
function openingEnds(o) {
  const wall = doc.walls.find((x) => x.id === o.wallId);
  if (!wall || !o) return null;
  const t0 = Math.min(o.t0, o.t1);
  const t1 = Math.max(o.t0, o.t1);
  return {
    wall,
    t0,
    t1,
    p0: pointAt(wall, t0),
    p1: pointAt(wall, t1),
    mid: pointAt(wall, (t0 + t1) / 2),
  };
}
function openingMid(o) {
  const ends = openingEnds(o);
  return ends ? ends.mid : { x: 0, y: 0 };
}
function syncDoorToOpening(d) {
  if (!d.openingId) return;
  const o = doc.openings.find((x) => x.id === d.openingId);
  if (!o) return;
  setOpeningWidth(o, d.widthMm || d.len);
  o.type = "door";
  o.heightMm = d.heightMm ?? defaultDoorHeight();
  o.sillMm = d.sillMm ?? 0;
  d.len = d.widthMm || d.len;
  applyDoorFrame(d);
}
function syncDoorFromOpening(d) {
  if (!d.openingId) return;
  const o = doc.openings.find((x) => x.id === d.openingId);
  if (!o) return;
  d.widthMm = Math.round(openingWidth(o));
  d.len = d.widthMm;
  applyDoorFrame(d);
}
/** Derive hinge, leaf direction, and closedDeg from opening + hingeAt / openSide.
 *  openSide is wall-relative: +1 = left of opening start→end, −1 = right.
 *  swingSign is the plan rotation sign so the leaf always swings into that side. */
function doorFrame(d) {
  const o = d.openingId ? doc.openings.find((x) => x.id === d.openingId) : null;
  let ends = o ? openingEnds(o) : null;
  if (!ends && d._ghostSeg) {
    const wall = doc.walls.find((w) => w.id === d._ghostSeg.wallId);
    if (wall && d._ghostSeg.p0 && d._ghostSeg.p1) {
      ends = {
        wall,
        t0: d._ghostSeg.t0,
        t1: d._ghostSeg.t1,
        p0: d._ghostSeg.p0,
        p1: d._ghostSeg.p1,
        mid: {
          x: (d._ghostSeg.p0.x + d._ghostSeg.p1.x) / 2,
          y: (d._ghostSeg.p0.y + d._ghostSeg.p1.y) / 2,
        },
      };
    }
  }
  const openSide = d.openSide != null ? (Number(d.openSide) >= 0 ? 1 : -1) : ((d.openDelta ?? 85) >= 0 ? 1 : -1);
  const openAngle = Math.abs(d.openAngle ?? d.openDelta ?? 85) || 85;
  if (!ends) {
    const ang = ((d.closedDeg || 0) * Math.PI) / 180;
    const u = { x: Math.cos(ang), y: Math.sin(ang) };
    const n = { x: -u.y, y: u.x };
    return {
      hinge: { ...(d.hinge || { x: 0, y: 0 }) },
      u,
      n,
      openSide,
      swingSign: openSide,
      openAngle,
      closedDeg: d.closedDeg || 0,
      widthMm: d.widthMm || d.len || OPENING_DEFAULT,
      wall: null,
      halfTh: 60,
      p0: d.hinge,
      p1: {
        x: (d.hinge?.x || 0) + Math.cos(ang) * (d.widthMm || OPENING_DEFAULT),
        y: (d.hinge?.y || 0) + Math.sin(ang) * (d.widthMm || OPENING_DEFAULT),
      },
    };
  }
  const along = unit(ends.p1.x - ends.p0.x, ends.p1.y - ends.p0.y);
  // Left-hand normal of opening start → end (wall-relative open side)
  const wallN = { x: -along.y, y: along.x };
  const hingeAtEnd = d.hingeAt === "end";
  const hinge = hingeAtEnd ? { ...ends.p1 } : { ...ends.p0 };
  // Leaf extends from hinge toward the other jamb
  const u = hingeAtEnd ? { x: -along.x, y: -along.y } : along;
  const targetN = { x: wallN.x * openSide, y: wallN.y * openSide };
  const cross = u.x * targetN.y - u.y * targetN.x;
  const swingSign = cross >= 0 ? 1 : -1;
  const closedDeg = ((Math.atan2(u.y, u.x) * 180) / Math.PI) + (d.closedOffsetDeg || 0);
  const halfTh = (ends.wall.thickness ?? doc.wallThicknessMm ?? 120) / 2;
  return {
    hinge,
    u,
    n: wallN,
    openSide,
    swingSign,
    openAngle,
    closedDeg,
    widthMm: d.widthMm || d.len || openingWidth(o) || OPENING_DEFAULT,
    wall: ends.wall,
    halfTh,
    p0: ends.p0,
    p1: ends.p1,
  };
}
function applyDoorFrame(d) {
  const f = doorFrame(d);
  d.hinge = { ...f.hinge };
  d.closedDeg = f.closedDeg;
  d.openSide = f.openSide;
  d.openAngle = f.openAngle;
  d.openDelta = f.swingSign * f.openAngle;
  return f;
}
function flipDoorSwing(d) {
  d.openSide = (d.openSide ?? 1) * -1;
  applyDoorFrame(d);
}
function flipDoorHinge(d) {
  d.hingeAt = d.hingeAt === "end" ? "start" : "end";
  applyDoorFrame(d);
}
function setDoorHinge(d, hingeAt) {
  d.hingeAt = hingeAt === "end" ? "end" : "start";
  applyDoorFrame(d);
}
function setDoorOpenSide(d, side) {
  d.openSide = Number(side) >= 0 ? 1 : -1;
  applyDoorFrame(d);
}
function syncWindowToOpening(win) {
  if (!win.openingId) return;
  const o = doc.openings.find((x) => x.id === win.openingId);
  if (!o) return;
  setOpeningWidth(o, win.widthMm);
  o.type = "window";
  o.heightMm = win.heightMm;
  o.sillMm = win.sillMm;
  win.wallId = o.wallId;
}
function syncWindowFromOpening(win) {
  if (!win.openingId) return;
  const o = doc.openings.find((x) => x.id === win.openingId);
  if (!o) return;
  win.widthMm = Math.round(openingWidth(o));
  win.wallId = o.wallId;
}
function refreshInspectorSizeFields(kind, obj) {
  if (!selected || selected.kind !== kind || selected.id !== obj.id) return;
  const set = (prop, val) => {
    const input = inspector.querySelector(`[data-prop="${prop}"]`);
    if (input && document.activeElement !== input) {
      input.value = input.dataset.len != null ? fmtNum(val) : String(Math.round(val));
    }
  };
  if (kind === "door") {
    set("widthMm", obj.widthMm || obj.len);
    set("heightMm", obj.heightMm ?? DOOR_HEIGHT_DEFAULT);
    set("sillMm", obj.sillMm ?? 0);
  } else if (kind === "window") {
    set("widthMm", obj.widthMm);
    set("heightMm", obj.heightMm);
    set("sillMm", obj.sillMm);
    const head = inspector.querySelector("[data-head-elev]");
    if (head) head.textContent = `Head elevation = sill + height = ${fmtLen(obj.sillMm + obj.heightMm)}`;
  }
  const badge = inspector.querySelector("[data-size-badge]");
  if (badge) {
    if (kind === "door") badge.textContent = fmtSize2(obj.widthMm || obj.len, obj.heightMm ?? DOOR_HEIGHT_DEFAULT);
    else badge.textContent = `${fmtSize2(obj.widthMm, obj.heightMm)} · sill ${fmtLen(obj.sillMm)}`;
  }
}

function drawResizeGrips(g, kind, id, p0, p1, mid, sizeLabel) {
  g.appendChild(el("line", {
    x1: mmX(p0.x), y1: mmY(p0.y), x2: mmX(p1.x), y2: mmY(p1.y),
    stroke: "#c9a227", "stroke-width": 10, opacity: "0.35", "stroke-linecap": "butt",
    "pointer-events": "none",
  }));
  const tag = el("text", {
    x: mmX(mid.x), y: mmY(mid.y) - 18,
    fill: "#e8c86a", "font-size": 12, "font-weight": "650", "text-anchor": "middle",
  });
  tag.textContent = sizeLabel;
  tag.style.pointerEvents = "none";
  g.appendChild(tag);
  for (const [grip, p] of [["t0", p0], ["t1", p1]]) {
    g.appendChild(el("circle", {
      cx: mmX(p.x), cy: mmY(p.y), r: 8,
      fill: "#0b1220", stroke: "#4f9fd4", "stroke-width": 3,
      "data-kind": kind, "data-id": id, "data-grip": grip,
      style: "cursor: ew-resize",
    }));
    g.appendChild(el("circle", {
      cx: mmX(p.x), cy: mmY(p.y), r: 16,
      fill: "transparent",
      "data-kind": kind, "data-id": id, "data-grip": grip,
      style: "cursor: ew-resize",
    }));
  }
}

function normalize(d) {
  const layers = Array.isArray(d.layers) && d.layers.length
    ? d.layers.map((L, i) => ({
      id: L.id || `ly_${i + 1}`,
      name: L.name || LEGACY_LAYER_NAMES[L.id] || `Layer ${i + 1}`,
      visible: L.visible !== false,
      locked: !!L.locked,
      opacity: clamp01(L.opacity ?? 1),
    }))
    : clone(DEFAULT_LAYERS);
  const wallHeightMm = d.wallHeightMm ?? REF_WALL_H;
  const wallThicknessMm = d.wallThicknessMm ?? 120;
  const flooringStyles = ["hardwood", "oak", "tile", "concrete", "carpet", "marble", "dark"];
  const flooring = flooringStyles.includes(d.flooring) ? d.flooring : "hardwood";
  const n = {
    version: 2,
    updatedAt: d.updatedAt || new Date().toISOString(),
    gridMm: d.gridMm ?? 50,
    snapMm: d.snapMm ?? 50,
    units: d.units === "imperial" ? "imperial" : "metric",
    wallHeightMm,
    wallThicknessMm,
    flooring,
    layers,
    images: (d.images || []).map((im) => ({
      id: im.id || uid("img"),
      layerId: im.layerId || null,
      name: im.name || "Trace image",
      src: im.src || "",
      x: im.x ?? 0,
      y: im.y ?? 0,
      w: im.w ?? 10000,
      h: im.h ?? 10000,
      opacity: clamp01(im.opacity ?? 0.45),
    })),
    walls: (d.walls || []).map((w) => normalizeWall(w, { wallThicknessMm, wallHeightMm })),
    openings: (d.openings || []).map(normalizeOpening),
    doors: (d.doors || []).map(normalizeDoor),
    windows: (d.windows || []).map(normalizeWindow),
    lights: (d.lights || []).map(normalizeLight),
    fans: (d.fans || []).map(normalizeFan),
    sockets: (d.sockets || []).map(normalizeSocket),
    cabinets: (d.cabinets || []).map(normalizeCabinet),
    rooms: (d.rooms || []).map(normalizeRoom),
  };
  applySharedDocFields(d, n);
  assignObjectLayerIds(n);
  if (!n.layers.some((L) => L.id === activeLayerId)) {
    activeLayerId = n.layers[n.layers.length - 1]?.id || n.layers[0]?.id || "ly_1";
  }
  const upgraded = upgradeDocument(n);
  syncPlaceToolHeights(upgraded);
  return upgraded;
}

function syncPlaceToolHeights(n) {
  if (!n) return;
  const h = n.wallHeightMm ?? REF_WALL_H;
  placeDoor.heightMm = scaleH(DOOR_HEIGHT_DEFAULT, REF_WALL_H, h);
  placeWindow.heightMm = scaleH(WINDOW_HEIGHT_DEFAULT, REF_WALL_H, h);
  placeWindow.sillMm = scaleH(WINDOW_SILL_DEFAULT, REF_WALL_H, h);
}

/**
 * Re-apply new schema defaults and re-stick doors/windows to walls.
 * Safe to run on every load — keeps legacy layouts current.
 */
function upgradeDocument(n) {
  const prev = doc;
  doc = n;
  try {
    // Re-link door openings + hinge to current wall geometry
    for (const d of n.doors || []) {
      const o = d.openingId ? n.openings.find((x) => x.id === d.openingId) : null;
      if (o) {
        o.type = "door";
        if (d.widthMm || d.len) setOpeningWidth(o, d.widthMm || d.len);
        o.heightMm = d.heightMm ?? o.heightMm ?? DOOR_HEIGHT_DEFAULT;
        o.sillMm = d.sillMm ?? 0;
        d.heightMm = o.heightMm;
        d.sillMm = o.sillMm ?? 0;
        d.widthMm = Math.round(openingWidth(o)) || d.widthMm;
        d.len = d.widthMm;
      }
      if (!d.style) d.style = "swing";
      if (d.hingeAt !== "end") d.hingeAt = "start";
      if (d.openSide == null) d.openSide = 1;
      if (d.openAngle == null) d.openAngle = Math.abs(d.openDelta ?? 85) || 85;
      applyDoorFrame(d);
    }
    for (const win of n.windows || []) {
      const o = win.openingId ? n.openings.find((x) => x.id === win.openingId) : null;
      if (o) {
        o.type = "window";
        win.wallId = o.wallId;
        if (win.widthMm) setOpeningWidth(o, win.widthMm);
        o.heightMm = win.heightMm ?? o.heightMm ?? WINDOW_HEIGHT_DEFAULT;
        o.sillMm = win.sillMm ?? o.sillMm ?? WINDOW_SILL_DEFAULT;
        win.heightMm = o.heightMm;
        win.sillMm = o.sillMm;
        win.widthMm = Math.round(openingWidth(o)) || win.widthMm;
      }
      if (!win.style) win.style = "sliding";
    }
    for (const f of n.fans || []) {
      if (f.hangMm == null) f.hangMm = 320;
      if (f.blades == null) f.blades = 3;
      if (f.diameterMm == null) f.diameterMm = 1200;
    }
    for (const c of n.cabinets || []) {
      const def = furnitureDef(c.type || "cabinet");
      if (!c.colorHex) c.colorHex = normalizeHexColor(def.color);
      if (def.isCurtain && !c.curtainStyle) c.curtainStyle = "cloth";
      if (c.widthMm == null) c.widthMm = def.widthMm;
      if (c.depthMm == null) c.depthMm = def.depthMm;
      if (c.heightMm == null) c.heightMm = def.heightMm;
    }
    for (const w of n.walls || []) {
      if (w.elevMm == null) w.elevMm = 0;
      if (w.height == null) w.height = n.wallHeightMm;
      if (w.thickness == null) w.thickness = n.wallThicknessMm;
    }
    syncLegacyWallHeights(n);
  } finally {
    doc = prev;
  }
  return n;
}

function reframeDoorsOnWall(wallId) {
  if (!doc || !wallId) return;
  for (const d of doc.doors || []) {
    const o = d.openingId ? doc.openings.find((x) => x.id === d.openingId) : null;
    if (o && o.wallId === wallId) applyDoorFrame(d);
  }
}

function clamp01(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

function getLayer(id) {
  return doc?.layers?.find((L) => L.id === id) || null;
}
function ensureLayerOnList(layers, id, name) {
  if (!id || !layers) return id;
  if (layers.some((L) => L.id === id)) return id;
  layers.push({
    id,
    name: name || LEGACY_LAYER_NAMES[id] || id,
    visible: true,
    locked: false,
    opacity: 1,
  });
  return id;
}
function defaultLayerIdForKind(kind) {
  return LEGACY_KIND_LAYER[kind] || activeLayerId || "ly_1";
}
function objectLayerId(obj, kind) {
  return obj?.layerId || defaultLayerIdForKind(kind);
}
function layerOfObject(obj, kind) {
  return getLayer(objectLayerId(obj, kind));
}
function objectLayerVisible(obj, kind) {
  const L = layerOfObject(obj, kind);
  return !L || L.visible !== false;
}
function objectLayerLocked(obj, kind) {
  const L = layerOfObject(obj, kind);
  return !!(L && L.locked);
}
/** @deprecated use objectLayerVisible — kept for call sites that only have a kind */
function layerVisible(kind) {
  const L = getLayer(defaultLayerIdForKind(kind));
  return !L || L.visible !== false;
}
function layerLocked(kind) {
  const L = getLayer(defaultLayerIdForKind(kind));
  return !!(L && L.locked);
}
function layerOpacity(kind) {
  const L = getLayer(defaultLayerIdForKind(kind));
  return L ? clamp01(L.opacity ?? 1) : 1;
}
function assignObjectLayerIds(n) {
  if (!n?.layers) return;
  const assign = (list, kind) => {
    for (const o of list || []) {
      const prefer = o.layerId || defaultLayerIdForKind(kind);
      o.layerId = ensureLayerOnList(n.layers, prefer, LEGACY_LAYER_NAMES[prefer]);
    }
  };
  assign(n.images, "image");
  assign(n.rooms, "room");
  assign(n.walls, "wall");
  assign(n.openings, "opening");
  assign(n.doors, "door");
  assign(n.windows, "window");
  assign(n.lights, "light");
  assign(n.fans, "fan");
  assign(n.sockets, "socket");
  assign(n.cabinets, "cabinet");
}
function activeLayerOrFirst() {
  if (getLayer(activeLayerId)) return activeLayerId;
  activeLayerId = doc?.layers?.[doc.layers.length - 1]?.id || doc?.layers?.[0]?.id || "ly_1";
  return activeLayerId;
}
function ensureLayerGroup(parent, layerId) {
  const L = getLayer(layerId);
  if (L && L.visible === false) return null;
  let g = parent.querySelector(`:scope > g[data-layer="${layerId}"]`);
  if (!g) {
    g = el("g", { "data-layer": layerId, opacity: clamp01(L?.opacity ?? 1) });
    parent.appendChild(g);
  }
  return g;
}

async function saveShared({ quiet = false } = {}) {
  if (!doc) return;
  doc.updatedAt = new Date().toISOString();
  doc.version = 2;
  try {
    if (!activeModel?.id) {
      const created = await Models.createModel({ name: "Apartment #15", source: "empty", doc });
      activeModel = created.model;
      Models.setActiveModelId(created.model.id);
      syncDraftKey();
    }
    const data = await Models.saveModelDoc(activeModel.id, doc);
    doc = normalize(data.doc);
    activeModel = data.model || activeModel;
    dirty = false;
    saveDraft();
    serverOk = true;
    setBanner("");
    liveSync?.setModelId(activeModel.id);
    liveSync?.publish(doc, { source: "cad", saved: true });
    await refreshModelsList();
    if (!quiet) {
      msg(`Saved · ${activeModel.name}`);
      toast(`Saved · ${activeModel.name}`);
    }
    draw();
  } catch (err) {
    serverOk = false;
    saveDraft();
    setBanner("Save server offline — draft kept locally. Use Export JSON or run: node server.mjs");
    msg("Save failed");
    if (!quiet) toast("Save failed — draft kept locally", "err");
    console.warn(err);
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(activeModel?.name || "layout").replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  msg("Exported JSON");
}

async function resetSeed() {
  await restoreSelectedVersion();
}

/* ---------- snap ---------- */
function snapPoint(p) {
  if (!snapOn || !doc) return p;
  const g = doc.snapMm || 50;
  let best = { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g, score: dist(p, { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }) };
  const candidates = [];
  for (const w of doc.walls) {
    candidates.push(w.a, w.b, pointAt(w, 0.5));
  }
  for (const c of candidates) {
    const d = dist(p, c);
    if (d < best.score && d < HIT_MM) best = { ...c, score: d };
  }
  return { x: best.x, y: best.y };
}

function placementOk(kind, obj, x, y, extra = {}) {
  return physPlacement({
    doc,
    kind,
    obj,
    x,
    y,
    walls: doc?.walls || [],
    from: extra.from || null,
    stickyRoom: extra.stickyRoom || null,
    ignoreObjects: !!extra.ignoreObjects,
    ignoreIds: extra.ignoreIds || null,
  });
}

function resolveDeviceMove(kind, obj, fromX, fromY, toX, toY, stickyRoom = null) {
  return resolveMove({
    doc,
    kind,
    obj,
    fromX,
    fromY,
    toX,
    toY,
    walls: doc?.walls || [],
    stickyRoom,
    snapFn: (x, y) => snapPoint({ x, y }),
  });
}

/** Hold Shift: lock to horizontal or vertical from origin. */
function orthoPoint(origin, p) {
  if (!shiftDown || !origin) return p;
  const dx = Math.abs(p.x - origin.x);
  const dy = Math.abs(p.y - origin.y);
  if (dx >= dy) return { x: p.x, y: origin.y };
  return { x: origin.x, y: p.y };
}

function clientToMm(clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const local = pt.matrixTransform(ctm.inverse());
  return { x: local.x / S, y: MAX_Y - local.y / S };
}

function el(name, attrs = {}) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) n.setAttribute(k, String(v));
  }
  return n;
}

/* ---------- hit testing ---------- */
function hitWall(p, tol = HIT_MM) {
  let best = null;
  for (const w of doc.walls) {
    const pr = projectWall(w, p);
    if (pr.dist <= tol && (!best || pr.dist < best.dist)) best = { wall: w, ...pr };
  }
  return best;
}
function hitDoor(p, tol = HIT_MM) {
  let best = null, bestD = Infinity;
  for (const d of doc.doors || []) {
    const candidates = [d.hinge];
    if (d.openingId) {
      const o = doc.openings.find((x) => x.id === d.openingId);
      const ends = o ? openingEnds(o) : null;
      if (ends) candidates.push(ends.mid, ends.p0, ends.p1);
    }
    for (const c of candidates) {
      if (!c) continue;
      const dd = dist(p, c);
      if (dd <= tol * 1.4 && dd < bestD) { best = d; bestD = dd; }
    }
  }
  return best;
}
function hitLight(p, tol = HIT_MM) {
  let best = null, bestD = tol;
  for (const l of doc.lights || []) {
    const extra = l.shape === "tube" ? (l.lengthMm || 1200) * 0.35 : 80;
    const d = dist(p, l);
    if (d <= Math.max(tol, extra) && d < bestD) { best = l; bestD = d; }
  }
  return best;
}
function hitFan(p, tol = HIT_MM) {
  let best = null, bestD = Infinity;
  for (const f of doc.fans || []) {
    const r = (f.diameterMm || 1200) / 2;
    const d = dist(p, f);
    if (d <= Math.max(tol, r) && d < bestD) { best = f; bestD = d; }
  }
  return best;
}
function hitSocket(p, tol = HIT_MM) {
  return (doc.sockets || []).find((s) => dist(p, s) <= tol) || null;
}
function hitCabinet(p, tol = HIT_MM) {
  let best = null, bestD = Infinity;
  for (const c of doc.cabinets || []) {
    // approximate axis-aligned hit in local space
    const ang = -((c.rotationDeg || 0) * Math.PI) / 180;
    const dx = p.x - c.x, dy = p.y - c.y;
    const lx = dx * Math.cos(ang) - dy * Math.sin(ang);
    const ly = dx * Math.sin(ang) + dy * Math.cos(ang);
    const hw = (c.widthMm || 1200) / 2 + tol * 0.3;
    const hd = (c.depthMm || 600) / 2 + tol * 0.3;
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hd) {
      const dd = Math.hypot(lx, ly);
      if (dd < bestD) { best = c; bestD = dd; }
    }
  }
  return best;
}
function hitOpening(p) {
  const hw = hitWall(p);
  if (!hw) return null;
  for (const o of doc.openings.filter((x) => x.wallId === hw.wall.id)) {
    const t0 = Math.min(o.t0, o.t1), t1 = Math.max(o.t0, o.t1);
    if (hw.t >= t0 && hw.t <= t1) return o;
  }
  return null;
}
function hitRoom(p) {
  for (let i = doc.rooms.length - 1; i >= 0; i--) {
    if (pointInPoly(p, roomPoints(doc.rooms[i]))) return doc.rooms[i];
  }
  return null;
}
function hitImage(p) {
  for (let i = doc.images.length - 1; i >= 0; i--) {
    const im = doc.images[i];
    if (!objectLayerVisible(im, "image") || objectLayerLocked(im, "image")) continue;
    if (p.x >= im.x && p.x <= im.x + im.w && p.y >= im.y && p.y <= im.y + im.h) return im;
  }
  return null;
}
function planBounds() {
  let minX = 0, minY = 0, maxX = 11270, maxY = 12490;
  for (const w of doc.walls) {
    minX = Math.min(minX, w.a.x, w.b.x);
    minY = Math.min(minY, w.a.y, w.b.y);
    maxX = Math.max(maxX, w.a.x, w.b.x);
    maxY = Math.max(maxY, w.a.y, w.b.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/* ---------- mutations ---------- */
function deleteOpeningCascade(openingId) {
  if (!openingId) return;
  doc.openings = doc.openings.filter((o) => o.id !== openingId);
  doc.doors = (doc.doors || []).filter((d) => d.openingId !== openingId);
  doc.windows = (doc.windows || []).filter((w) => w.openingId !== openingId);
}

function deleteOne(kind, id) {
  if (kind === "wall") {
    const openIds = doc.openings.filter((o) => o.wallId === id).map((o) => o.id);
    doc.openings = doc.openings.filter((o) => o.wallId !== id);
    doc.doors = doc.doors.filter((d) => !d.openingId || !openIds.includes(d.openingId));
    doc.windows = (doc.windows || []).filter((w) => !w.openingId || !openIds.includes(w.openingId));
    doc.walls = doc.walls.filter((w) => w.id !== id);
  } else if (kind === "opening") {
    deleteOpeningCascade(id);
  } else if (kind === "door") {
    const d = doc.doors.find((x) => x.id === id);
    doc.doors = doc.doors.filter((x) => x.id !== id);
    if (d?.openingId) {
      const stillUsed =
        (doc.doors || []).some((x) => x.openingId === d.openingId)
        || (doc.windows || []).some((x) => x.openingId === d.openingId);
      if (!stillUsed) doc.openings = doc.openings.filter((o) => o.id !== d.openingId);
    }
  } else if (kind === "window") {
    const win = (doc.windows || []).find((w) => w.id === id);
    doc.windows = (doc.windows || []).filter((w) => w.id !== id);
    if (win?.openingId) {
      const stillUsed =
        (doc.doors || []).some((x) => x.openingId === win.openingId)
        || (doc.windows || []).some((x) => x.openingId === win.openingId);
      if (!stillUsed) {
        doc.openings = doc.openings.filter((o) => o.id !== win.openingId);
        doc.doors = (doc.doors || []).filter((d) => d.openingId !== win.openingId);
      }
    }
  } else if (kind === "light") doc.lights = doc.lights.filter((l) => l.id !== id);
  else if (kind === "fan") doc.fans = doc.fans.filter((f) => f.id !== id);
  else if (kind === "socket") doc.sockets = (doc.sockets || []).filter((s) => s.id !== id);
  else if (kind === "cabinet") doc.cabinets = (doc.cabinets || []).filter((c) => c.id !== id);
  else if (kind === "room") doc.rooms = doc.rooms.filter((r) => r.id !== id);
  else if (kind === "image") doc.images = doc.images.filter((im) => im.id !== id);
}

function deleteSelected() {
  if (!selection.length) return;
  for (const s of selection) {
    const o = findDocObj(s.kind, s.id);
    if (objectLayerLocked(o, s.kind)) {
      msg("Layer locked");
      return;
    }
  }
  pushHistory();
  for (const s of [...selection]) deleteOne(s.kind, s.id);
  pruneGroups(doc);
  clearSelection();
  draw();
  msg("Deleted");
}

function copySelection() {
  const items = selectionObjects();
  if (!items.length) return false;
  clipboard = items.map((it) => {
    const entry = { kind: it.kind, obj: clone(it.o) };
    if ((it.kind === "door" || it.kind === "window") && it.o.openingId) {
      const op = doc.openings.find((o) => o.id === it.o.openingId);
      if (op) entry.opening = clone(op);
    }
    return entry;
  });
  msg(items.length > 1 ? `Copied ${items.length}` : "Copied");
  return true;
}

function pasteClipboard() {
  if (!clipboard || !doc) return;
  const items = Array.isArray(clipboard) ? clipboard : [clipboard];
  if (!items.length) return;
  pushHistory();
  const created = [];
  const OFF = 200;
  for (const it of items) {
    const kind = it.kind;
    const o = clone(it.obj);
    if (kind === "door" || kind === "window") {
      const opSrc = it.opening || (o.openingId ? doc.openings.find((x) => x.id === o.openingId) : null);
      if (opSrc) {
        const nop = clone(opSrc);
        nop.id = uid("o");
        // keep same wall params; slight t shift so it doesn't stack exactly
        const span = Math.abs(nop.t1 - nop.t0);
        const mid = (nop.t0 + nop.t1) / 2;
        const nmid = Math.min(0.95 - span / 2, Math.max(0.05 + span / 2, mid + 0.04));
        nop.t0 = nmid - span / 2;
        nop.t1 = nmid + span / 2;
        doc.openings.push(nop);
        o.openingId = nop.id;
        o.wallId = nop.wallId;
      } else {
        o.openingId = null;
      }
      o.id = uid(kind === "door" ? "door" : "win");
      o.label = (o.label || kind) + " copy";
      if (kind === "door") {
        if (!doc.doors) doc.doors = [];
        doc.doors.push(o);
        if (o.openingId) applyDoorFrame(o);
      } else {
        if (!doc.windows) doc.windows = [];
        doc.windows.push(o);
      }
      created.push({ kind, id: o.id });
      continue;
    }
    o.id = uid(kind === "wall" ? "w" : kind === "cabinet" ? "fur" : "x");
    if (o.label) o.label = String(o.label).replace(/\s*copy$/, "") + " copy";
    if (o.a) { o.a.x += OFF; o.a.y += OFF; o.b.x += OFF; o.b.y += OFF; }
    if (o.hinge) { o.hinge.x += OFF; o.hinge.y += OFF; }
    if (o.x != null) { o.x += OFF; o.y += OFF; }
    if (o.points) o.points = o.points.map((p) => ({ x: p.x + OFF, y: p.y + OFF }));
    if (o.w != null && o.h != null && o.src) { o.x = (o.x || 0) + OFF; o.y = (o.y || 0) + OFF; }
    const map = {
      wall: "walls", light: "lights", fan: "fans", socket: "sockets",
      cabinet: "cabinets", room: "rooms", opening: "openings", image: "images",
    };
    const key = map[kind];
    if (!key) continue;
    if (!doc[key]) doc[key] = [];
    doc[key].push(o);
    created.push({ kind, id: o.id });
  }
  if (!created.length) { msg("Nothing to paste"); return; }
  setSelection(created);
  draw();
  msg(created.length > 1 ? `Pasted ${created.length}` : "Pasted");
}

function groupSelectionCad() {
  const items = selectionObjects();
  if (items.length < 2) { toast("Select 2+ objects to group", "err"); return; }
  pushHistory();
  groupMembersUtil(doc, items);
  dirty = true;
  saveDraft();
  lastInspectorKey = "";
  draw();
  toast(`Grouped ${items.length}`);
}
function ungroupSelectionCad() {
  const items = selectionObjects();
  if (!items.length) return;
  pushHistory();
  const n = ungroupMembersUtil(doc, items);
  if (!n) { toast("Nothing to ungroup", "err"); return; }
  dirty = true;
  saveDraft();
  lastInspectorKey = "";
  draw();
  toast("Ungrouped");
}
function selectGroupOfPrimary() {
  const p = selected;
  if (!p) return;
  const groups = findGroupsFor(doc, p.kind, p.id);
  if (!groups.length) { toast("Not in a group", "err"); return; }
  setSelection(groups[0].members || []);
  draw();
  toast(`Group · ${groups[0].label || groups[0].id}`);
}

function similarKeyCad(kind, o) {
  if (!o) return kind;
  if (kind === "cabinet") return `cabinet:${o.type || "cabinet"}`;
  if (kind === "light") return `light:${o.shape || "bulb"}`;
  if (kind === "door") return `door:${o.style || "swing"}`;
  if (kind === "window") return `window:${o.style || "sliding"}`;
  if (kind === "fan") return "fan";
  if (kind === "socket") return `socket:${o.style || "single"}`;
  if (kind === "wall") return "wall";
  if (kind === "room") return "room";
  if (kind === "opening") return `opening:${o.type || "passage"}`;
  if (kind === "image") return "image";
  return kind;
}
function allObjectsFlatCad() {
  const out = [];
  for (const im of doc?.images || []) out.push({ kind: "image", id: im.id, o: im });
  for (const r of doc?.rooms || []) out.push({ kind: "room", id: r.id, o: r });
  for (const w of doc?.walls || []) out.push({ kind: "wall", id: w.id, o: w });
  for (const o of doc?.openings || []) out.push({ kind: "opening", id: o.id, o: o });
  for (const d of doc?.doors || []) out.push({ kind: "door", id: d.id, o: d });
  for (const w of doc?.windows || []) out.push({ kind: "window", id: w.id, o: w });
  for (const l of doc?.lights || []) out.push({ kind: "light", id: l.id, o: l });
  for (const f of doc?.fans || []) out.push({ kind: "fan", id: f.id, o: f });
  for (const s of doc?.sockets || []) out.push({ kind: "socket", id: s.id, o: s });
  for (const c of doc?.cabinets || []) out.push({ kind: "cabinet", id: c.id, o: c });
  return out;
}
function selectSimilarCad() {
  const items = selectionObjects();
  if (!items.length) return;
  const keys = new Set(items.map((it) => similarKeyCad(it.kind, it.o)));
  const next = allObjectsFlatCad().filter((it) => keys.has(similarKeyCad(it.kind, it.o)));
  setSelection(next);
  draw();
  toast(`Selected ${next.length} similar`);
}
function selectSameKindCad() {
  const items = selectionObjects();
  if (!items.length) return;
  const kinds = new Set(items.map((it) => it.kind));
  const next = allObjectsFlatCad().filter((it) => kinds.has(it.kind));
  setSelection(next);
  draw();
  toast(`Selected ${next.length}`);
}
function moveSelectionToLayer(layerId) {
  if (!getLayer(layerId) || !selection.length) return;
  pushHistory();
  for (const s of selectionObjects()) {
    if (s.o) s.o.layerId = layerId;
  }
  dirty = true;
  saveDraft();
  lastInspectorKey = "";
  draw();
  toast(`Moved to ${getLayer(layerId)?.name || "layer"}`);
}
function countOnLayer(layerId) {
  return allObjectsFlatCad().filter((it) => objectLayerId(it.o, it.kind) === layerId).length;
}
async function addLayerCad() {
  const name = await promptText({ title: "New layer", label: "Name", value: `Layer ${(doc.layers?.length || 0) + 1}`, okLabel: "Add" });
  if (name == null) return;
  pushHistory();
  const id = uid("ly");
  doc.layers.push({ id, name: String(name).trim() || "Layer", visible: true, locked: false, opacity: 1 });
  activeLayerId = id;
  dirty = true;
  saveDraft();
  draw();
  toast(`Layer “${name.trim() || "Layer"}”`);
}
async function renameLayerCad(layerId) {
  const L = getLayer(layerId);
  if (!L) return;
  const name = await promptText({ title: "Rename layer", label: "Name", value: L.name, okLabel: "Rename" });
  if (name == null) return;
  pushHistory();
  L.name = String(name).trim() || L.name;
  dirty = true;
  saveDraft();
  draw();
}
async function deleteLayerCad(layerId) {
  if ((doc.layers || []).length <= 1) { toast("Keep at least one layer", "err"); return; }
  const L = getLayer(layerId);
  if (!L) return;
  if (!(await confirmModal({
    title: "Delete layer",
    message: `Delete “${L.name}”? Objects move to the layer below.`,
    okLabel: "Delete",
    danger: true,
  }))) return;
  pushHistory();
  const idx = doc.layers.findIndex((x) => x.id === layerId);
  const fallback = doc.layers[idx - 1] || doc.layers[idx + 1] || doc.layers[0];
  for (const it of allObjectsFlatCad()) {
    if (objectLayerId(it.o, it.kind) === layerId && it.o) it.o.layerId = fallback.id;
  }
  doc.layers = doc.layers.filter((x) => x.id !== layerId);
  if (activeLayerId === layerId) activeLayerId = fallback.id;
  dirty = true;
  saveDraft();
  draw();
  toast("Layer deleted");
}

/* ---------- 2D context menu ---------- */
const ctxMenu = document.getElementById("ctxMenu");
function hideCtxMenu() {
  if (!ctxMenu) return;
  ctxMenu.classList.remove("open");
  ctxMenu.hidden = true;
  ctxMenu.innerHTML = "";
}
function ctxItem(label, act, { disabled = false, kbd = "" } = {}) {
  return `<button type="button" role="menuitem" data-ctx="${act}" ${disabled ? "disabled" : ""}>
    <span>${label}</span>${kbd ? `<span class="kbd">${kbd}</span>` : ""}
  </button>`;
}
function ctxSep() { return `<div class="ctx-sep"></div>`; }
function buildCtxMenuHtml(hit) {
  const items = selectionObjects();
  const has = items.length > 0;
  const multi = items.length > 1;
  const inGroup = has && items.some((it) => findGroupsFor(doc, it.kind, it.id).length);
  const title = hit
    ? `${hit.kind}${items.length > 1 ? ` · ${items.length} selected` : ""}`
    : (has ? `${items.length} selected` : "Canvas");
  const layerItems = (doc.layers || []).map((L) =>
    ctxItem(`→ ${L.name}`, `to-layer:${L.id}`, { disabled: !has })
  ).join("");
  return `
    <div class="ctx-label">${title}</div>
    ${ctxItem("Select similar", "select-similar", { disabled: !has })}
    ${ctxItem("Select same type", "select-kind", { disabled: !has })}
    ${ctxItem("Select group", "select-group", { disabled: !inGroup })}
    ${ctxSep()}
    ${ctxItem("Group", "group", { disabled: !multi, kbd: "⌘G" })}
    ${ctxItem("Ungroup", "ungroup", { disabled: !inGroup, kbd: "⌘⇧G" })}
    ${ctxSep()}
    <div class="ctx-label">Move to layer</div>
    ${layerItems || ctxItem("No layers", "noop", { disabled: true })}
    ${ctxSep()}
    ${ctxItem("Copy", "copy", { disabled: !has, kbd: "⌘C" })}
    ${ctxItem("Paste", "paste", { disabled: !(Array.isArray(clipboard) ? clipboard.length : clipboard), kbd: "⌘V" })}
    ${ctxItem("Delete", "delete", { disabled: !has, kbd: "⌫" })}
    ${ctxSep()}
    ${ctxItem("Clear selection", "clear", { disabled: !has, kbd: "Esc" })}
  `;
}
function showCtxMenu(clientX, clientY, hit) {
  if (!ctxMenu) return;
  if (hit && !isInSelection(hit.kind, hit.id)) {
    const o = findDocObj(hit.kind, hit.id);
    if (objectLayerLocked(o, hit.kind)) {
      toast("Layer locked", "err");
      return;
    }
    setSelected(hit.kind, hit.id);
  }
  ctxMenu.innerHTML = buildCtxMenuHtml(hit);
  ctxMenu.hidden = false;
  ctxMenu.classList.add("open");
  const pad = 8;
  const w = ctxMenu.offsetWidth || 200;
  const h = ctxMenu.offsetHeight || 320;
  let x = clientX;
  let y = clientY;
  if (x + w > window.innerWidth - pad) x = window.innerWidth - w - pad;
  if (y + h > window.innerHeight - pad) y = window.innerHeight - h - pad;
  ctxMenu.style.left = `${Math.max(pad, x)}px`;
  ctxMenu.style.top = `${Math.max(pad, y)}px`;
}
function runCtxAction(act) {
  hideCtxMenu();
  if (!act || act === "noop") return;
  if (act === "select-similar") selectSimilarCad();
  else if (act === "select-kind") selectSameKindCad();
  else if (act === "select-group") selectGroupOfPrimary();
  else if (act === "group") groupSelectionCad();
  else if (act === "ungroup") ungroupSelectionCad();
  else if (act.startsWith("to-layer:")) moveSelectionToLayer(act.slice("to-layer:".length));
  else if (act === "copy") copySelection();
  else if (act === "paste") pasteClipboard();
  else if (act === "delete") deleteSelected();
  else if (act === "clear") { clearSelection(); draw(); }
}

function splitWallAt(wall, t) {
  if (t <= 0.02 || t >= 0.98) return;
  pushHistory();
  syncWallAb(wall);
  const mid = pointAt(wall, t);
  const pts = wallPoints(wall);
  const L = wallLen(wall) || 1;
  const left = [pts[0]];
  let acc = 0;
  let placed = false;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]) || 0;
    const t1 = (acc + seg) / L;
    if (!placed && t <= t1 + 1e-9) {
      left.push({ ...mid });
      placed = true;
      break;
    }
    left.push({ ...pts[i] });
    acc += seg;
  }
  if (!placed) left.push({ ...mid });
  const right = [{ ...mid }];
  acc = 0;
  placed = false;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]) || 0;
    const t0 = acc / L;
    const t1 = (acc + seg) / L;
    if (t1 + 1e-9 >= t) {
      if (!placed) {
        placed = true;
        if (dist(pts[i], mid) > 1) right.push({ ...pts[i] });
      } else {
        right.push({ ...pts[i] });
      }
    }
    acc += seg;
  }
  if (wall.closed && pts.length >= 3) {
    // Closed → open at split: chain mid→…→first→…→mid via remaining verts
    // Simpler: explode-style two open walls from arc split
  }
  const w2 = normalizeWall({
    id: uid("w"),
    points: right.length >= 2 ? right : [{ ...mid }, { ...pts[pts.length - 1] }],
    thickness: wallThickness(wall),
    height: wallHeight(wall),
    elevMm: wallElev(wall),
    layerId: wall.layerId || activeLayerOrFirst(),
  }, doc);
  wall.points = left.length >= 2 ? left : [{ ...pts[0] }, { ...mid }];
  wall.closed = false;
  syncWallAb(wall);
  doc.walls.push(w2);
  const keep = [];
  for (const o of doc.openings.filter((x) => x.wallId === wall.id)) {
    const a = Math.min(o.t0, o.t1), b = Math.max(o.t0, o.t1);
    if (b <= t) {
      keep.push({ ...o, t0: a / t, t1: b / t });
    } else if (a >= t) {
      keep.push({ ...o, wallId: w2.id, t0: (a - t) / (1 - t), t1: (b - t) / (1 - t) });
    } else {
      keep.push({ ...o, t0: a / t, t1: 1 });
      keep.push({ id: uid("o"), wallId: w2.id, t0: 0, t1: (b - t) / (1 - t) });
    }
  }
  doc.openings = doc.openings.filter((o) => o.wallId !== wall.id).concat(keep);
  setSelected("wall", wall.id);
  draw();
  msg("Wall split");
}

function joinWalls(w1, w2) {
  const merged = mergeWallPolylines(w1, w2);
  if (!merged) {
    msg("Walls must share an endpoint");
    return;
  }
  pushHistory();
  applyWallMerge(w1, w2, merged);
  joinPick = null;
  detectClosedRoomsFromWalls();
  draw();
  msg("Walls joined into polyline");
}

/** Merge two walls that share an endpoint into one polyline (any angle). */
function mergeWallPolylines(w1, w2) {
  syncWallAb(w1); syncWallAb(w2);
  const p1 = wallPoints(w1);
  const p2 = wallPoints(w2);
  if (p1.length < 2 || p2.length < 2) return null;
  const tol = WALL_JOIN_TOL;
  let pts = null;
  if (nearEnds(p1[p1.length - 1], p2[0], tol)) pts = [...p1, ...p2.slice(1)];
  else if (nearEnds(p1[p1.length - 1], p2[p2.length - 1], tol)) pts = [...p1, ...[...p2].reverse().slice(1)];
  else if (nearEnds(p1[0], p2[p2.length - 1], tol)) pts = [...p2, ...p1.slice(1)];
  else if (nearEnds(p1[0], p2[0], tol)) pts = [...[...p2].reverse(), ...p1.slice(1)];
  else return null;
  const merged = normalizeWall({
    id: w1.id,
    points: pts,
    thickness: wallThickness(w1),
    height: wallHeight(w1),
    elevMm: wallElev(w1),
  }, doc);
  return merged;
}

function applyWallMerge(w1, w2, merged) {
  const remapOpen = (wall, o) => {
    const p0 = pointAt(wall, Math.min(o.t0, o.t1));
    const p1 = pointAt(wall, Math.max(o.t0, o.t1));
    return { ...o, wallId: merged.id, t0: projectWall(merged, p0).t, t1: projectWall(merged, p1).t };
  };
  const opens = [
    ...doc.openings.filter((o) => o.wallId === w1.id).map((o) => remapOpen(w1, o)),
    ...doc.openings.filter((o) => o.wallId === w2.id).map((o) => remapOpen(w2, o)),
  ];
  doc.openings = doc.openings.filter((o) => o.wallId !== w1.id && o.wallId !== w2.id).concat(opens);
  // Remap room wallIds: w2 → w1
  for (const r of doc.rooms || []) {
    if (!Array.isArray(r.wallIds)) continue;
    r.wallIds = [...new Set(r.wallIds.map((id) => (id === w2.id ? w1.id : id)))];
  }
  doc.walls = doc.walls.filter((w) => w.id !== w1.id && w.id !== w2.id);
  doc.walls.push(merged);
  setSelected("wall", merged.id);
  return merged;
}

/** Insert vertex on wall at projection of p (T-junction). Returns true if inserted. */
function insertWallVertexAt(wall, p, tol = WALL_JOIN_TOL * 1.5) {
  syncWallAb(wall);
  const pr = projectWall(wall, p);
  if (pr.dist > tol) return false;
  if (pr.t < 0.02 || pr.t > 0.98) return false;
  const pts = wallPoints(wall);
  // Find edge and insert
  const edges = wallEdges(wall);
  let acc = 0;
  const L = wallLen(wall);
  for (const e of edges) {
    const t0 = acc / L;
    const t1 = (acc + e.len) / L;
    if (pr.t >= t0 - 1e-9 && pr.t <= t1 + 1e-9) {
      if (dist(e.a, pr.q) < 5 || dist(e.b, pr.q) < 5) return false;
      pts.splice(e.i + 1, 0, { x: pr.q.x, y: pr.q.y });
      wall.points = pts;
      syncWallAb(wall);
      return true;
    }
    acc += e.len;
  }
  return false;
}

/**
 * After drawing a new 2-pt wall, snap ends and merge into meeting polylines.
 * T-junctions insert a vertex but stay separate objects.
 */
function absorbDrawnWall(newWall) {
  syncWallAb(newWall);
  const tol = WALL_JOIN_TOL;
  let w = newWall;

  // Snap free ends onto existing wall endpoints / mid-edges
  for (const endKey of ["start", "end"]) {
    const pts = wallPoints(w);
    const end = endKey === "start" ? pts[0] : pts[pts.length - 1];
    let bestEnd = null;
    let bestMid = null;
    for (const other of doc.walls) {
      if (other.id === w.id) continue;
      syncWallAb(other);
      const opts = wallPoints(other);
      for (const ep of [opts[0], opts[opts.length - 1]]) {
        const d = dist(end, ep);
        if (d <= tol && (!bestEnd || d < bestEnd.d)) bestEnd = { other, ep, d };
      }
      const pr = projectWall(other, end);
      if (pr.dist <= tol * 1.2 && pr.t > 0.05 && pr.t < 0.95) {
        if (!bestMid || pr.dist < bestMid.d) bestMid = { other, q: pr.q, d: pr.dist };
      }
    }
    if (bestEnd && bestEnd.d <= (bestMid?.d ?? Infinity)) {
      // Snap to endpoint coords
      if (endKey === "start") {
        w.points[0] = { ...bestEnd.ep };
      } else {
        w.points[w.points.length - 1] = { ...bestEnd.ep };
      }
      syncWallAb(w);
      const merged = mergeWallPolylines(bestEnd.other, w);
      if (merged) {
        applyWallMerge(bestEnd.other, w, merged);
        w = merged;
      }
    } else if (bestMid) {
      insertWallVertexAt(bestMid.other, bestMid.q);
      if (endKey === "start") w.points[0] = { ...bestMid.q };
      else w.points[w.points.length - 1] = { ...bestMid.q };
      syncWallAb(w);
    }
  }
  // Closing a loop: free ends coincide → one closed polyline object
  const fin = wallPoints(w);
  if (fin.length >= 3 && dist(fin[0], fin[fin.length - 1]) <= tol) {
    w.closed = true;
    syncWallAb(w);
  } else if (fin.length >= 3 && dist(fin[0], fin[fin.length - 1]) <= tol * 1.5) {
    w.points[w.points.length - 1] = { ...fin[0] };
    w.closed = true;
    syncWallAb(w);
  }
  return w;
}

function explodeWall(wall) {
  if (!wall) return;
  syncWallAb(wall);
  const edges = wallEdges(wall);
  if (edges.length < 2) {
    msg("Wall is already a single segment");
    return;
  }
  pushHistory();
  const pieces = [];
  for (const e of edges) {
    if (e.len < 20) continue;
    pieces.push(normalizeWall({
      id: uid("w"),
      points: [{ ...e.a }, { ...e.b }],
      thickness: wallThickness(wall),
      height: wallHeight(wall),
      elevMm: wallElev(wall),
    }, doc));
  }
  if (!pieces.length) return;
  // Remap openings by arc-length onto child segments
  const L = wallLen(wall);
  const newOpens = [];
  for (const o of doc.openings.filter((x) => x.wallId === wall.id)) {
    const midT = (Math.min(o.t0, o.t1) + Math.max(o.t0, o.t1)) / 2;
    const midP = pointAt(wall, midT);
    let best = null;
    for (const pw of pieces) {
      const pr = projectWall(pw, midP);
      if (!best || pr.dist < best.dist) best = { pw, pr };
    }
    if (!best) continue;
    const p0 = pointAt(wall, Math.min(o.t0, o.t1));
    const p1 = pointAt(wall, Math.max(o.t0, o.t1));
    newOpens.push({
      ...o,
      wallId: best.pw.id,
      t0: projectWall(best.pw, p0).t,
      t1: projectWall(best.pw, p1).t,
    });
  }
  doc.openings = doc.openings.filter((o) => o.wallId !== wall.id).concat(newOpens);
  for (const r of doc.rooms || []) {
    if (!Array.isArray(r.wallIds)) continue;
    if (!r.wallIds.includes(wall.id)) continue;
    r.wallIds = r.wallIds.filter((id) => id !== wall.id).concat(pieces.map((p) => p.id));
  }
  doc.walls = doc.walls.filter((w) => w.id !== wall.id).concat(pieces);
  setSelected("wall", pieces[0].id);
  detectClosedRoomsFromWalls();
  draw();
  msg(`Exploded into ${pieces.length} segments`);
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return a / 2;
}
function polyKey(pts) {
  if (!pts?.length) return "";
  let best = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y < pts[best].y || (pts[i].y === pts[best].y && pts[i].x < pts[best].x)) best = i;
  }
  const ord = pts.slice(best).concat(pts.slice(0, best));
  const rev = [ord[0], ...ord.slice(1).reverse()];
  const fmt = (arr) => arr.map((p) => `${Math.round(p.x / 10) * 10},${Math.round(p.y / 10) * 10}`).join(";");
  const a = fmt(ord), b = fmt(rev);
  return a < b ? a : b;
}

/**
 * Detect closed loops in the wall graph and upsert rooms with wallIds.
 * Shared walls appear in wallIds of every adjacent room.
 */
function detectClosedRoomsFromWalls() {
  if (!doc?.walls?.length) return;
  // Node key → { x,y }
  const nodeKey = (p) => `${Math.round(p.x / WALL_JOIN_TOL) * WALL_JOIN_TOL},${Math.round(p.y / WALL_JOIN_TOL) * WALL_JOIN_TOL}`;
  const nodes = new Map(); // key -> {x,y}
  /** @type {Map<string, {to:string, wallId:string, rev:boolean}[]>} */
  const adj = new Map();

  const addEdge = (ka, kb, wallId) => {
    if (ka === kb) return;
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ to: kb, wallId, rev: false });
    adj.get(kb).push({ to: ka, wallId, rev: true });
  };

  for (const w of doc.walls) {
    syncWallAb(w);
    const pts = wallPoints(w);
    for (let i = 0; i < pts.length - 1; i++) {
      const ka = nodeKey(pts[i]);
      const kb = nodeKey(pts[i + 1]);
      if (!nodes.has(ka)) nodes.set(ka, { ...pts[i] });
      if (!nodes.has(kb)) nodes.set(kb, { ...pts[i + 1] });
      addEdge(ka, kb, w.id);
    }
  }

  // Directed edge cycles via left-most face walk (planar embedding by angle)
  const used = new Set(); // "from>to>wallId"
  const cycles = [];

  const edgeId = (from, to, wallId) => `${from}>${to}>${wallId}`;

  const angleOf = (from, to) => {
    const a = nodes.get(from), b = nodes.get(to);
    return Math.atan2(b.y - a.y, b.x - a.x);
  };

  for (const [start, outs] of adj) {
    for (const e0 of outs) {
      const eid0 = edgeId(start, e0.to, e0.wallId);
      if (used.has(eid0)) continue;
      const pathNodes = [start];
      const pathWalls = [];
      let cur = start;
      let next = e0.to;
      let wallId = e0.wallId;
      let guard = 0;
      let closed = false;
      while (guard++ < 64) {
        const eid = edgeId(cur, next, wallId);
        if (used.has(eid) && pathNodes.length > 1) break;
        used.add(eid);
        pathWalls.push(wallId);
        pathNodes.push(next);
        if (next === start && pathNodes.length > 3) {
          closed = true;
          break;
        }
        // Pick next leftmost turn
        const inAng = angleOf(cur, next);
        const candidates = adj.get(next) || [];
        let best = null;
        let bestDelta = -Infinity;
        for (const c of candidates) {
          if (c.to === cur && c.wallId === wallId) continue; // don't reverse immediately on same edge
          const outAng = angleOf(next, c.to);
          let delta = outAng - inAng;
          while (delta <= -Math.PI) delta += Math.PI * 2;
          while (delta > Math.PI) delta -= Math.PI * 2;
          // Prefer smallest left turn (largest delta in CCW sense → use most CCW)
          if (delta > bestDelta) {
            bestDelta = delta;
            best = c;
          }
        }
        if (!best) break;
        cur = next;
        next = best.to;
        wallId = best.wallId;
      }
      if (closed && pathNodes.length >= 4) {
        // Drop duplicate closing node
        const ring = pathNodes.slice(0, -1).map((k) => ({ ...nodes.get(k) }));
        if (Math.abs(polyArea(ring)) < 1e4) continue; // tiny
        // Normalize orientation CCW
        if (polyArea(ring) < 0) {
          ring.reverse();
          pathWalls.reverse();
        }
        cycles.push({
          points: ring,
          wallIds: [...new Set(pathWalls)],
          key: polyKey(ring),
        });
      }
    }
  }

  // Deduplicate cycles by key
  const byKey = new Map();
  for (const c of cycles) {
    if (!byKey.has(c.key)) byKey.set(c.key, c);
  }

  if (!doc.rooms) doc.rooms = [];
  const existingKeys = new Map();
  for (const r of doc.rooms) {
    existingKeys.set(polyKey(roomPoints(r)), r);
  }

  for (const c of byKey.values()) {
    const hit = existingKeys.get(c.key);
    if (hit) {
      hit.wallIds = c.wallIds;
      // Keep user label/points; refresh wallIds
    } else {
      // Only auto-create for reasonably sized faces
      const area = Math.abs(polyArea(c.points));
      if (area < 5e5) continue; // < ~0.5 m² skip noise
      const room = {
        id: uid("rm"),
        label: "Room",
        points: c.points.map((p) => ({ ...p })),
        wallIds: c.wallIds,
        layerId: activeLayerOrFirst(),
      };
      doc.rooms.push(room);
      existingKeys.set(c.key, room);
    }
  }
}

function cutWall(wall, t0, t1) {
  const a = Math.min(t0, t1), b = Math.max(t0, t1);
  if (b - a < 0.02) return;
  pushHistory();
  syncWallAb(wall);
  const pieces = [];
  if (a > 0.02) {
    pieces.push(normalizeWall({
      id: uid("w"),
      points: wallSpanPoints(wall, 0, a),
      thickness: wallThickness(wall),
      height: wallHeight(wall),
      elevMm: wallElev(wall),
      layerId: wall.layerId || activeLayerOrFirst(),
    }, doc));
  }
  if (b < 0.98) {
    pieces.push(normalizeWall({
      id: uid("w"),
      points: wallSpanPoints(wall, b, 1),
      thickness: wallThickness(wall),
      height: wallHeight(wall),
      elevMm: wallElev(wall),
      layerId: wall.layerId || activeLayerOrFirst(),
    }, doc));
  }
  const newOpens = [];
  for (const o of doc.openings.filter((x) => x.wallId === wall.id)) {
    const oa = Math.min(o.t0, o.t1), ob = Math.max(o.t0, o.t1);
    if (ob <= a && pieces[0]) {
      newOpens.push({ ...o, wallId: pieces[0].id, t0: oa / a, t1: ob / a });
    } else if (oa >= b && pieces[pieces.length - 1]) {
      const pw = pieces[pieces.length - 1];
      const span = 1 - b;
      newOpens.push({ ...o, wallId: pw.id, t0: (oa - b) / span, t1: (ob - b) / span });
    }
  }
  doc.openings = doc.openings.filter((o) => o.wallId !== wall.id).concat(newOpens);
  doc.doors = doc.doors.filter((d) => !d.openingId || doc.openings.some((o) => o.id === d.openingId));
  doc.walls = doc.walls.filter((w) => w.id !== wall.id).concat(pieces);
  if (pieces[0]) setSelected("wall", pieces[0].id); else clearSelection();
  draft = null;
  draw();
  msg("Wall cut");
}

function addOpeningOnWall(wall, centerT, widthMm = OPENING_DEFAULT, opts = {}) {
  const L = wallLen(wall);
  const half = (widthMm / 2) / L;
  const t0 = Math.max(0, centerT - half);
  const t1 = Math.min(1, centerT + half);
  const type = opts.type || "passage";
  const o = normalizeOpening({
    id: uid("o"),
    wallId: wall.id,
    t0,
    t1,
    type,
    heightMm: opts.heightMm ?? (type === "window" ? defaultWindowHeight() : defaultDoorHeight()),
    sillMm: opts.sillMm ?? (type === "window" ? defaultWindowSill() : 0),
  });
  if (!opts.skipHistory) pushHistory();
  o.layerId = o.layerId || wall.layerId || activeLayerOrFirst();
  doc.openings.push(o);
  if (!opts.silentSelect) setSelected("opening", o.id);
  if (!opts.silent) {
    draw();
    msg(type === "window" ? "Window opening" : type === "door" ? "Door opening" : "Opening added");
  }
  return o;
}

function svgArc(cx, cy, r, a0, a1) {
  // angles in plan radians; SVG y is flipped via mmY so convert endpoints with mmX/mmY
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0; // will adjust for Y flip on screen
  // Plan: +ang is CCW from +X. SVG: y down, so plan CCW appears CW on screen → invert sweep
  const x0 = mmX(cx + Math.cos(a0) * r);
  const y0 = mmY(cy + Math.sin(a0) * r);
  const x1 = mmX(cx + Math.cos(a1) * r);
  const y1 = mmY(cy + Math.sin(a1) * r);
  const svgSweep = sweep ? 0 : 1;
  return `M ${x0} ${y0} A ${r * S} ${r * S} 0 ${large} ${svgSweep} ${x1} ${y1}`;
}

function drawDoorSymbol(g, d) {
  const open = !!d.open;
  const style = d.style || "swing";
  const sel = isInSelection("door", d.id);
  const frame = doorFrame(d);
  const col = open ? "#4f9fd4" : "#a89070";
  const arcCol = open ? "#4f9fd488" : "#c9a22788";
  const gg = el("g", { "data-kind": "door", "data-id": d.id });
  const hx = mmX(frame.hinge.x), hy = mmY(frame.hinge.y);
  const widthMm = frame.widthMm;
  const len = widthMm * S;
  const wallAng = (frame.closedDeg * Math.PI) / 180;
  const openRad = (frame.swingSign * frame.openAngle * Math.PI) / 180;
  const swingAng = wallAng + (open ? openRad : 0);

  // Opening span on wall
  if (frame.p0 && frame.p1) {
    gg.appendChild(el("line", {
      x1: mmX(frame.p0.x), y1: mmY(frame.p0.y),
      x2: mmX(frame.p1.x), y2: mmY(frame.p1.y),
      stroke: "#3a4554", "stroke-width": 8, "stroke-linecap": "butt", opacity: "0.55",
      "pointer-events": "none",
    }));
  }

  // Swing arc (always show open direction)
  if (style === "swing" || style === "double" || style === "bifold" || !style) {
    const a0 = wallAng;
    const a1 = wallAng + openRad;
    const arc = el("path", {
      d: svgArc(frame.hinge.x, frame.hinge.y, widthMm, a0, a1),
      fill: "none",
      stroke: arcCol,
      "stroke-width": 1.5,
      "stroke-dasharray": open ? "none" : "4 3",
      "pointer-events": "none",
    });
    gg.appendChild(arc);
    // Direction arrow at mid-arc
    const amid = wallAng + openRad * 0.55;
    const ax = frame.hinge.x + Math.cos(amid) * widthMm * 0.72;
    const ay = frame.hinge.y + Math.sin(amid) * widthMm * 0.72;
    const tx = -Math.sin(amid) * frame.swingSign;
    const ty = Math.cos(amid) * frame.swingSign;
    gg.appendChild(el("polygon", {
      points: [
        `${mmX(ax + tx * 60)},${mmY(ay + ty * 60)}`,
        `${mmX(ax - tx * 40 - Math.cos(amid) * 50)},${mmY(ay - ty * 40 - Math.sin(amid) * 50)}`,
        `${mmX(ax - tx * 40 + Math.cos(amid) * 50)},${mmY(ay - ty * 40 + Math.sin(amid) * 50)}`,
      ].join(" "),
      fill: arcCol,
      "pointer-events": "none",
    }));
  }

  if (style === "double") {
    const mid = {
      x: frame.hinge.x + frame.u.x * widthMm / 2,
      y: frame.hinge.y + frame.u.y * widthMm / 2,
    };
    const half = len / 2;
    const aL = wallAng + (open ? openRad : 0);
    const aR = wallAng - (open ? openRad : 0);
    const x1 = mmX(mid.x), y1 = mmY(mid.y);
    gg.append(
      el("line", {
        x1, y1,
        x2: x1 - Math.cos(aL) * half, y2: y1 + Math.sin(aL) * half,
        stroke: col, "stroke-width": 4, "stroke-linecap": "round",
      }),
      el("line", {
        x1, y1,
        x2: x1 + Math.cos(aR) * half, y2: y1 - Math.sin(aR) * half,
        stroke: col, "stroke-width": 4, "stroke-linecap": "round",
      }),
      el("circle", { cx: x1, cy: y1, r: sel ? 8 : 5, fill: sel ? "#4f9fd4" : col }),
    );
  } else if (style === "sliding" || style === "pocket") {
    const ux = frame.u.x, uy = frame.u.y;
    const nx = frame.n.x * frame.openSide, ny = frame.n.y * frame.openSide;
    const off = (style === "pocket" ? 0 : 14);
    const slide = open ? len * 0.55 : 0;
    const x0 = hx + nx * off + ux * slide * S / S; // nx already unit in plan; off is svg-ish
    // use plan offsets then convert
    const pStart = {
      x: frame.hinge.x + nx * (style === "pocket" ? 0 : 80) + ux * (open ? widthMm * 0.55 : 0),
      y: frame.hinge.y + ny * (style === "pocket" ? 0 : 80) + uy * (open ? widthMm * 0.55 : 0),
    };
    const pEnd = { x: pStart.x + ux * widthMm, y: pStart.y + uy * widthMm };
    const leafAttrs = {
      x1: mmX(pStart.x), y1: mmY(pStart.y), x2: mmX(pEnd.x), y2: mmY(pEnd.y),
      stroke: col, "stroke-width": 5, "stroke-linecap": "round",
    };
    if (style === "pocket") leafAttrs["stroke-dasharray"] = "6 4";
    gg.append(
      el("line", leafAttrs),
      el("circle", { cx: hx, cy: hy, r: sel ? 8 : 5, fill: sel ? "#4f9fd4" : col }),
    );
  } else if (style === "bifold") {
    const a = swingAng;
    const q = widthMm / 2;
    const x2p = frame.hinge.x + Math.cos(a) * q;
    const y2p = frame.hinge.y + Math.sin(a) * q;
    const x3p = x2p + Math.cos(a + 0.7 * frame.swingSign) * q;
    const y3p = y2p + Math.sin(a + 0.7 * frame.swingSign) * q;
    gg.append(
      el("line", { x1: hx, y1: hy, x2: mmX(x2p), y2: mmY(y2p), stroke: col, "stroke-width": 4, "stroke-linecap": "round" }),
      el("line", { x1: mmX(x2p), y1: mmY(y2p), x2: mmX(x3p), y2: mmY(y3p), stroke: col, "stroke-width": 4, "stroke-linecap": "round" }),
      el("circle", { cx: hx, cy: hy, r: sel ? 8 : 5, fill: sel ? "#4f9fd4" : col }),
    );
  } else {
    // swing single — leaf
    const tip = {
      x: frame.hinge.x + Math.cos(swingAng) * widthMm,
      y: frame.hinge.y + Math.sin(swingAng) * widthMm,
    };
    gg.append(
      el("line", {
        x1: hx, y1: hy, x2: mmX(tip.x), y2: mmY(tip.y),
        stroke: col, "stroke-width": 5, "stroke-linecap": "round",
      }),
      el("circle", { cx: hx, cy: hy, r: sel ? 9 : 6, fill: sel ? "#4f9fd4" : "#c9a227" }),
    );
  }

  // Direction badge (wall-relative)
  const badge = el("text", {
    x: hx, y: hy - 14, fill: "#e8c86a", "font-size": 9, "text-anchor": "middle",
  });
  const hingeTxt = d.hingeAt === "end" ? "hinge:end" : "hinge:start";
  badge.textContent = `${hingeTxt} · open ${frame.openSide > 0 ? "L" : "R"}`;
  badge.style.pointerEvents = "none";
  if (sel) gg.appendChild(badge);

  // When selected: clickable swing-side markers on both sides of the wall
  if (sel && d.id !== "_ghost" && frame.p0 && frame.p1) {
    const mid = {
      x: (frame.p0.x + frame.p1.x) / 2,
      y: (frame.p0.y + frame.p1.y) / 2,
    };
    const alongWall = unit(frame.p1.x - frame.p0.x, frame.p1.y - frame.p0.y);
    const reach = Math.max(220, widthMm * 0.35);
    for (const side of [1, -1]) {
      const active = frame.openSide === side;
      const cx = mid.x + frame.n.x * side * reach;
      const cy = mid.y + frame.n.y * side * reach;
      gg.appendChild(el("circle", {
        cx: mmX(cx), cy: mmY(cy), r: active ? 10 : 8,
        fill: active ? "#c9a227" : "#1a2230",
        stroke: active ? "#ffe08a" : "#4f9fd4",
        "stroke-width": 2,
        "data-kind": "door",
        "data-id": d.id,
        "data-door-act": "open-side",
        "data-side": String(side),
        style: "cursor:pointer",
      }));
      const t = el("text", {
        x: mmX(cx), y: mmY(cy) + 3,
        fill: active ? "#1a1200" : "#9ec9e8",
        "font-size": 8, "text-anchor": "middle",
        "pointer-events": "none",
      });
      t.textContent = side > 0 ? "L" : "R";
      gg.appendChild(t);
    }
    // Hinge end markers (offset past jambs so they don't conflict with resize grips)
    for (const [end, base] of [["start", frame.p0], ["end", frame.p1]]) {
      const active = (d.hingeAt === "end" ? "end" : "start") === end;
      const out = end === "start"
        ? { x: -alongWall.x, y: -alongWall.y }
        : alongWall;
      const pt = { x: base.x + out.x * 100, y: base.y + out.y * 100 };
      gg.appendChild(el("circle", {
        cx: mmX(pt.x), cy: mmY(pt.y), r: active ? 8 : 6,
        fill: active ? "#c9a227" : "#0b1220",
        stroke: "#e8c86a",
        "stroke-width": active ? 2.5 : 1.5,
        "data-kind": "door",
        "data-id": d.id,
        "data-door-act": "hinge",
        "data-hinge": end,
        style: "cursor:pointer",
      }));
      const ht = el("text", {
        x: mmX(pt.x), y: mmY(pt.y) - 12,
        fill: "#e8c86a", "font-size": 8, "text-anchor": "middle",
        "pointer-events": "none",
      });
      ht.textContent = "H";
      gg.appendChild(ht);
    }
  }

  gg.appendChild(el("circle", { cx: hx, cy: hy, r: 22, fill: "transparent" }));
  if (sel && d.openingId && d.id !== "_ghost") {
    const o = doc.openings.find((x) => x.id === d.openingId);
    const ends = o ? openingEnds(o) : null;
    if (ends) {
      drawResizeGrips(
        gg, "door", d.id, ends.p0, ends.p1, ends.mid,
        fmtSize2(d.widthMm || d.len, d.heightMm ?? DOOR_HEIGHT_DEFAULT),
      );
    }
  }
  g.appendChild(gg);
}

function drawWindowSymbol(g, win) {
  let o = doc.openings.find((x) => x.id === win.openingId);
  let wall = doc.walls.find((x) => x.id === (o?.wallId || win.wallId));
  if (win._ghostSeg && wall) {
    o = { t0: win._ghostSeg.t0, t1: win._ghostSeg.t1, wallId: wall.id };
  }
  if (!wall || !o) return;
  const p0 = pointAt(wall, Math.min(o.t0, o.t1));
  const p1 = pointAt(wall, Math.max(o.t0, o.t1));
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const sel = isInSelection("window", win.id);
  const gg = el("g", win.id === "_ghost" ? {} : { "data-kind": "window", "data-id": win.id });
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const L = Math.hypot(dx, dy) || 1;
  const nx = (-dy / L) * 120, ny = (dx / L) * 120;
  gg.append(
    el("line", {
      x1: mmX(p0.x), y1: mmY(p0.y), x2: mmX(p1.x), y2: mmY(p1.y),
      stroke: sel ? "#4f9fd4" : "#6eb6e0", "stroke-width": 6, "stroke-linecap": "butt",
    }),
    el("line", {
      x1: mmX(p0.x + nx * 0.15), y1: mmY(p0.y + ny * 0.15),
      x2: mmX(p1.x + nx * 0.15), y2: mmY(p1.y + ny * 0.15),
      stroke: sel ? "#4f9fd4" : "#9ad0ef", "stroke-width": 2,
    }),
    el("circle", { cx: mmX(mid.x), cy: mmY(mid.y), r: sel ? 8 : 5, fill: sel ? "#4f9fd4" : "#5b9fd4" }),
  );
  if (win.id !== "_ghost") {
    gg.appendChild(el("circle", { cx: mmX(mid.x), cy: mmY(mid.y), r: 20, fill: "transparent" }));
    const tag = el("text", {
      x: mmX(mid.x), y: mmY(mid.y) - 12,
      fill: "#7eb8d8", "font-size": 10, "text-anchor": "middle",
    });
    tag.textContent = `sill ${Math.round(win.sillMm)}`;
    tag.style.pointerEvents = "none";
    gg.appendChild(tag);
    if (sel) {
      drawResizeGrips(
        gg, "window", win.id, p0, p1, mid,
        `${Math.round(win.widthMm)}×${Math.round(win.heightMm)} · sill ${Math.round(win.sillMm)}`,
      );
    }
  }
  g.appendChild(gg);
}

function drawLightSymbol(g, l) {
  const cx = mmX(l.x), cy = mmY(l.y);
  const sel = isInSelection("light", l.id);
  const fill = l.on ? kelvinFill(l.colorTempK) : "#2a3340";
  const stroke = sel ? "#4f9fd4" : (l.on ? "#c9a227" : "#d7dde8");
  const gg = el("g", { "data-kind": "light", "data-id": l.id });
  const ang = ((l.rotationDeg || 0) * Math.PI) / 180;
  const shape = l.shape || "bulb";
  const inten = Math.max(0.35, Math.min(1.2, (l.intensity ?? 1)));

  if (shape === "tube") {
    const len = Math.max(24, (l.lengthMm || 1200) * S * 0.5);
    const hw = 5 * inten;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const corners = [
      [-len, -hw], [len, -hw], [len, hw], [-len, hw],
    ].map(([x, y]) => `${cx + x * ca - y * sa},${cy + x * sa + y * ca}`).join(" ");
    gg.appendChild(el("polygon", {
      points: corners, fill, stroke, "stroke-width": sel ? 2.5 : 1.5,
    }));
  } else if (shape === "panel") {
    const s = 14 * Math.sqrt(inten);
    gg.appendChild(el("rect", {
      x: cx - s, y: cy - s, width: s * 2, height: s * 2,
      fill, stroke, "stroke-width": sel ? 2.5 : 1.5, rx: 2,
      transform: `rotate(${l.rotationDeg || 0} ${cx} ${cy})`,
    }));
  } else if (shape === "spot") {
    const r = 10 * inten;
    gg.appendChild(el("circle", { cx, cy, r, fill, stroke, "stroke-width": sel ? 2.5 : 1.5 }));
    const a0 = ang - 0.55, a1 = ang + 0.55;
    const tip = 22;
    gg.appendChild(el("path", {
      d: `M ${cx} ${cy} L ${cx + Math.cos(a0) * tip} ${cy + Math.sin(a0) * tip} L ${cx + Math.cos(a1) * tip} ${cy + Math.sin(a1) * tip} Z`,
      fill: l.on ? `${kelvinFill(l.colorTempK)}66` : "#2a334066",
      stroke: "none",
      "pointer-events": "none",
    }));
  } else {
    // bulb + rays
    const r = 11 * (0.85 + inten * 0.15);
    gg.appendChild(el("circle", { cx, cy, r, fill, stroke, "stroke-width": sel ? 2.5 : 1.5 }));
    if (l.on) {
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        gg.appendChild(el("line", {
          x1: cx + Math.cos(a) * (r + 3), y1: cy + Math.sin(a) * (r + 3),
          x2: cx + Math.cos(a) * (r + 8), y2: cy + Math.sin(a) * (r + 8),
          stroke: fill, "stroke-width": 1.5, "pointer-events": "none",
        }));
      }
    }
    gg.appendChild(el("circle", { cx, cy, r: 3, fill: l.on ? "#0b1220" : "#6b7280", "pointer-events": "none" }));
  }
  const label = el("text", {
    x: cx, y: cy + 22, fill: "#9aa0a6", "font-size": 9, "text-anchor": "middle",
  });
  label.textContent = l.label || "Light";
  label.style.pointerEvents = "none";
  gg.appendChild(label);
  gg.appendChild(el("circle", { cx, cy, r: 22, fill: "transparent" }));
  g.appendChild(gg);
}

function drawFanSymbol(g, f) {
  const cx = mmX(f.x), cy = mmY(f.y);
  const sel = isInSelection("fan", f.id);
  const R = Math.max(16, ((f.diameterMm || 1200) * S) / 2);
  const blades = f.blades || 3;
  const rot = ((f.rotationDeg || 0) * Math.PI) / 180;
  const gg = el("g", { "data-kind": "fan", "data-id": f.id });
  const ring = f.on ? "#3d9a6a" : "#8a93a0";
  gg.appendChild(el("circle", {
    cx, cy, r: R, fill: f.on ? "#1a2e24" : "#1a2030",
    stroke: sel ? "#4f9fd4" : ring, "stroke-width": sel ? 2.5 : 1.5,
  }));
  for (let i = 0; i < blades; i++) {
    const a = rot + (i * 2 * Math.PI) / blades;
    const ca = Math.cos(a), sa = Math.sin(a);
    const px = (x, y) => `${cx + x * ca - y * sa},${cy + x * sa + y * ca}`;
    const tip = R * 0.92;
    const w = R * 0.26;
    const d = `M ${px(R * 0.14, -w * 0.12)} Q ${px(tip * 0.5, -w)} ${px(tip, 0)} Q ${px(tip * 0.5, w)} ${px(R * 0.14, w * 0.12)} Z`;
    gg.appendChild(el("path", {
      d, fill: f.on ? "#5fb88a" : "#5a6570", stroke: "#0f1218", "stroke-width": 0.5,
      "pointer-events": "none",
    }));
  }
  gg.appendChild(el("circle", {
    cx, cy, r: Math.max(4, R * 0.14),
    fill: f.on ? "#c9a227" : "#3a4554", stroke: "#0f1218", "stroke-width": 1,
    "pointer-events": "none",
  }));
  const label = el("text", {
    x: cx, y: cy + R + 12, fill: "#9aa0a6", "font-size": 9, "text-anchor": "middle",
  });
  label.textContent = `${f.label || "Fan"} · ${blades}w`;
  label.style.pointerEvents = "none";
  gg.appendChild(label);
  gg.appendChild(el("circle", { cx, cy, r: Math.max(R, 20), fill: "transparent" }));
  g.appendChild(gg);
}

function drawSocketSymbol(g, s) {
  const cx = mmX(s.x), cy = mmY(s.y);
  const sel = isInSelection("socket", s.id);
  const style = s.style || "single";
  const gg = el("g", { "data-kind": "socket", "data-id": s.id });
  const rot = s.rotationDeg || 0;
  const w = style === "double" || style === "usb" ? 22 : 16;
  const h = style === "floor" ? 16 : 14;
  gg.appendChild(el("rect", {
    x: cx - w / 2, y: cy - h / 2, width: w, height: h,
    fill: "#1c2230", stroke: sel ? "#4f9fd4" : "#c9a227", "stroke-width": sel ? 2.5 : 1.5, rx: 2,
    transform: `rotate(${rot} ${cx} ${cy})`,
  }));
  const holes = style === "double" ? [-5, 5] : style === "usb" ? [-4, 4] : [0];
  for (const dx of holes) {
    gg.appendChild(el("circle", {
      cx: cx + dx, cy, r: 2.2, fill: "#0b1220", stroke: "#9aa0a6", "stroke-width": 0.8,
      transform: `rotate(${rot} ${cx} ${cy})`,
      "pointer-events": "none",
    }));
  }
  if (style === "usb") {
    gg.appendChild(el("rect", {
      x: cx - 3, y: cy + 3, width: 6, height: 2.5, fill: "#5b9fd4",
      transform: `rotate(${rot} ${cx} ${cy})`, "pointer-events": "none",
    }));
  }
  const label = el("text", {
    x: cx, y: cy + h / 2 + 11, fill: "#9aa0a6", "font-size": 9, "text-anchor": "middle",
  });
  label.textContent = s.label || "Socket";
  label.style.pointerEvents = "none";
  gg.appendChild(label);
  gg.appendChild(el("circle", { cx, cy, r: 18, fill: "transparent" }));
  g.appendChild(gg);
}

function drawCabinetSymbol(g, c) {
  const cx = mmX(c.x), cy = mmY(c.y);
  const sel = isInSelection("cabinet", c.id);
  const type = c.type || "cabinet";
  const def = furnitureDef(type);
  const w = (c.widthMm || def.widthMm) * S;
  const d = (c.depthMm || def.depthMm) * S;
  const rot = c.rotationDeg || 0;
  const doors = Math.max(0, Math.min(6, c.doors || 0));
  const gg = el("g", { "data-kind": "cabinet", "data-id": c.id });
  const colorHex = normalizeHexColor(c.colorHex || def.color, def.color);
  const stroke = sel ? "#4f9fd4" : colorHex;
  const fill = c.open ? "#3a4a3a" : "#232830";
  const xf = `rotate(${-rot} ${cx} ${cy})`;

  const body = (attrs) => {
    gg.appendChild(el("rect", {
      x: cx - w / 2, y: cy - d / 2, width: w, height: d,
      fill, stroke, "stroke-width": sel ? 2.4 : 1.4,
      transform: xf, ...attrs,
    }));
  };

  if (type === "curtain" || type === "curtain_sheer" || type === "curtain_wide" || type === "blinds") {
    const style = c.curtainStyle || def.curtainStyle || (type === "blinds" ? "horizontal" : type === "curtain_sheer" ? "sheer" : "cloth");
    const open = !!c.open;
    const foldMode = c.foldMode || "both";
    const raise = style === "roman" || style === "horizontal";
    gg.appendChild(el("rect", {
      x: cx - w / 2, y: cy - Math.max(d, 4) / 2, width: w, height: Math.max(d, 4),
      fill: "none", stroke: sel ? "#4f9fd4" : "#5a6570", "stroke-width": sel ? 1.6 : 0.9,
      "stroke-dasharray": "3 2", transform: xf, "pointer-events": "none",
    }));
    // rod
    gg.appendChild(el("line", {
      x1: cx - w / 2 - 2, y1: cy - Math.max(d, 6) / 2, x2: cx + w / 2 + 2, y2: cy - Math.max(d, 6) / 2,
      stroke: "#c9a227", "stroke-width": 2, transform: xf, "pointer-events": "none",
    }));

    const drawPanel = (x0, drawW, extra = {}) => {
      gg.appendChild(el("rect", {
        x: x0, y: cy - Math.max(d, 6) / 2, width: drawW, height: Math.max(d, 6),
        fill: colorHex, "fill-opacity": style === "sheer" ? 0.35 : 0.55,
        stroke, "stroke-width": sel ? 2 : 1.2, transform: xf, ...extra,
      }));
    };

    if (raise && open) {
      // Raised / folded up under the rod
      drawPanel(cx - w / 2, w, { height: Math.max(d, 6) * 0.45, y: cy - Math.max(d, 6) / 2 });
      for (let i = 1; i <= 3; i++) {
        const ly = cy - Math.max(d, 6) / 2 + i * 2.2;
        gg.appendChild(el("line", {
          x1: cx - w / 2 + 2, y1: ly, x2: cx + w / 2 - 2, y2: ly,
          stroke, "stroke-width": 1.1, transform: xf, "pointer-events": "none",
        }));
      }
    } else if (open && foldMode === "left") {
      drawPanel(cx - w / 2, w * 0.28);
    } else if (open && foldMode === "right") {
      drawPanel(cx + w / 2 - w * 0.28, w * 0.28);
    } else if (open) {
      drawPanel(cx - w / 2, w * 0.22);
      drawPanel(cx + w / 2 - w * 0.22, w * 0.22);
    } else {
      drawPanel(cx - w / 2, w);
    }

    const fabricX0 = open
      ? (foldMode === "right" ? cx + w / 2 - w * 0.28 : cx - w / 2)
      : cx - w / 2;
    const fabricW = open
      ? (foldMode === "both" ? w * 0.22 : w * 0.28)
      : w;

    if (!(raise && open)) {
      if (style === "vertical" || style === "panel") {
        const n = Math.max(4, Math.round(fabricW / 8));
        for (let i = 1; i < n; i++) {
          const lx = fabricX0 + (fabricW * i) / n;
          gg.appendChild(el("line", {
            x1: lx, y1: cy - Math.max(d, 6) / 2, x2: lx, y2: cy + Math.max(d, 6) / 2,
            stroke: "#0f1218", "stroke-opacity": 0.35, "stroke-width": 0.8, transform: xf, "pointer-events": "none",
          }));
        }
        if (open && foldMode === "both") {
          const x1 = cx + w / 2 - w * 0.22;
          for (let i = 1; i < n; i++) {
            const lx = x1 + (fabricW * i) / n;
            gg.appendChild(el("line", {
              x1: lx, y1: cy - Math.max(d, 6) / 2, x2: lx, y2: cy + Math.max(d, 6) / 2,
              stroke: "#0f1218", "stroke-opacity": 0.35, "stroke-width": 0.8, transform: xf, "pointer-events": "none",
            }));
          }
        }
      } else if (style === "horizontal") {
        const n = 4;
        for (let i = 1; i < n; i++) {
          const ly = cy - Math.max(d, 6) / 2 + (Math.max(d, 6) * i) / n;
          gg.appendChild(el("line", {
            x1: fabricX0, y1: ly, x2: fabricX0 + fabricW, y2: ly,
            stroke: "#0f1218", "stroke-opacity": 0.4, "stroke-width": 0.8, transform: xf, "pointer-events": "none",
          }));
        }
      } else if (style === "roman") {
        for (let i = 1; i <= 3; i++) {
          const ly = cy - Math.max(d, 6) / 2 + (Math.max(d, 6) * i) / 4;
          gg.appendChild(el("line", {
            x1: fabricX0 + 2, y1: ly, x2: fabricX0 + fabricW - 2, y2: ly,
            stroke, "stroke-width": 1.2, transform: xf, "pointer-events": "none",
          }));
        }
      } else {
        const folds = style === "sheer" ? 5 : 4;
        for (let i = 1; i < folds; i++) {
          const lx = fabricX0 + (fabricW * i) / folds;
          gg.appendChild(el("path", {
            d: `M ${lx} ${cy - Math.max(d, 6) / 2} Q ${lx + 2} ${cy} ${lx} ${cy + Math.max(d, 6) / 2}`,
            fill: "none", stroke: "#0f1218", "stroke-opacity": 0.3, "stroke-width": 0.9,
            transform: xf, "pointer-events": "none",
          }));
        }
      }
    }
  } else if (type === "rug" || type === "runner") {
    gg.appendChild(el("rect", {
      x: cx - w / 2, y: cy - d / 2, width: w, height: d, rx: 6, ry: 6,
      fill: colorHex, "fill-opacity": 0.35, stroke, "stroke-width": sel ? 2 : 1.2,
      "stroke-dasharray": "6 3", transform: xf,
    }));
  } else if (type === "plant") {
    gg.appendChild(el("circle", {
      cx, cy, r: Math.min(w, d) * 0.45,
      fill: colorHex, "fill-opacity": 0.45, stroke, "stroke-width": sel ? 2.2 : 1.4, transform: xf,
    }));
    gg.appendChild(el("ellipse", {
      cx, cy: cy + Math.min(w, d) * 0.15, rx: Math.min(w, d) * 0.22, ry: Math.min(w, d) * 0.12,
      fill: "#5a4030", stroke: "none", transform: xf, "pointer-events": "none",
    }));
  } else if (type === "mirror" || type === "tv" || type === "wall_art") {
    gg.appendChild(el("rect", {
      x: cx - w / 2, y: cy - Math.max(d, 4) / 2, width: w, height: Math.max(d, 4),
      fill: type === "tv" ? "#1a1c20" : type === "wall_art" ? colorHex : "#4a6070",
      "fill-opacity": type === "wall_art" ? 0.55 : 1,
      stroke, "stroke-width": sel ? 2.2 : 1.4, transform: xf,
    }));
  } else if (type === "floor_lamp") {
    gg.appendChild(el("circle", {
      cx, cy, r: Math.min(w, d) * 0.35,
      fill: "#2a2418", stroke, "stroke-width": sel ? 2.2 : 1.4, transform: xf,
    }));
    gg.appendChild(el("circle", {
      cx, cy, r: Math.min(w, d) * 0.12, fill: colorHex, stroke: "none", transform: xf, "pointer-events": "none",
    }));
  } else if (type === "shower") {
    body({ fill: "#1a2834" });
    gg.appendChild(el("circle", {
      cx: cx + w * 0.28, cy: cy - d * 0.28, r: 3, fill: "#c9a227", stroke: "none", transform: xf, "pointer-events": "none",
    }));
  } else if (type === "ottoman") {
    body({ fill: "#2a323c" });
  } else if (type === "bed" || type === "bed_single" || type === "bed_king" || type === "bed_twin" || type === "crib") {
    body();
    const pw = w * 0.38, ph = d * 0.14;
    if (type !== "crib") {
      gg.appendChild(el("rect", {
        x: cx - w * 0.42, y: cy - d / 2 + 4, width: pw, height: ph,
        fill: "#3a4554", stroke, "stroke-width": 1, transform: xf, "pointer-events": "none",
      }));
      gg.appendChild(el("rect", {
        x: cx + w * 0.04, y: cy - d / 2 + 4, width: pw, height: ph,
        fill: "#3a4554", stroke, "stroke-width": 1, transform: xf, "pointer-events": "none",
      }));
    } else {
      // crib rails
      for (const side of [-1, 1]) {
        gg.appendChild(el("line", {
          x1: cx + side * w * 0.42, y1: cy - d / 2, x2: cx + side * w * 0.42, y2: cy + d / 2,
          stroke, "stroke-width": 1.5, transform: xf, "pointer-events": "none",
        }));
      }
    }
    gg.appendChild(el("line", {
      x1: cx - w / 2, y1: cy - d / 2, x2: cx + w / 2, y2: cy - d / 2,
      stroke, "stroke-width": 3.5, transform: xf, "pointer-events": "none",
    }));
  } else if (type === "sofa" || type === "sofa_loveseat" || type === "armchair" || type === "chaise" || type === "recliner"
    || type === "sofa_sectional" || type === "sofa_corner") {
    body();
    gg.appendChild(el("rect", {
      x: cx - w / 2 + 3, y: cy - d / 2 + 2, width: w - 6, height: d * (type === "chaise" ? 0.18 : 0.28),
      fill: "#2e3844", stroke, "stroke-width": 1, transform: xf, "pointer-events": "none",
    }));
    gg.appendChild(el("rect", {
      x: cx - w / 2, y: cy - d / 2, width: w * 0.1, height: d,
      fill: "#2a323c", stroke: "none", transform: xf, "pointer-events": "none",
    }));
    if (type !== "chaise") {
      gg.appendChild(el("rect", {
        x: cx + w / 2 - w * 0.1, y: cy - d / 2, width: w * 0.1, height: d,
        fill: "#2a323c", stroke: "none", transform: xf, "pointer-events": "none",
      }));
    }
    if (type === "sofa_sectional" || type === "sofa_corner") {
      // L return stub on front-right
      const rw = w * 0.35, rd = d * 0.55;
      gg.appendChild(el("rect", {
        x: cx + w / 2 - rw, y: cy + d / 2 - rd, width: rw, height: rd,
        fill: "#2a323c", stroke, "stroke-width": 1, transform: xf, "pointer-events": "none",
      }));
    }
  } else if (type === "dining_table" || type === "coffee_table" || type === "desk" || type === "console"
    || type === "side_table" || type === "nest_tables" || type === "bar_table" || type === "round_table") {
    if (type === "round_table") {
      gg.appendChild(el("ellipse", {
        cx, cy, rx: w / 2, ry: d / 2,
        fill: "#2a241c", stroke, "stroke-width": sel ? 2.2 : 1.4, transform: xf,
      }));
    } else {
      body({ fill: "#2a241c" });
    }
    gg.appendChild(el("ellipse", {
      cx, cy, rx: Math.min(w, d) * 0.12, ry: Math.min(w, d) * 0.08,
      fill: "none", stroke, "stroke-width": 1, transform: xf, "pointer-events": "none",
    }));
  } else if (type === "chair" || type === "barstool" || type === "dining_chair" || type === "office_chair" || type === "bench") {
    body();
    gg.appendChild(el("line", {
      x1: cx - w / 2, y1: cy - d / 2, x2: cx + w / 2, y2: cy - d / 2,
      stroke, "stroke-width": type === "bench" ? 2 : 3, transform: xf, "pointer-events": "none",
    }));
    if (type === "office_chair") {
      gg.appendChild(el("circle", {
        cx, cy, r: Math.min(w, d) * 0.22,
        fill: "none", stroke, "stroke-width": 1, transform: xf, "pointer-events": "none",
      }));
    }
  } else if (type === "toilet") {
    gg.appendChild(el("ellipse", {
      cx, cy: cy + d * 0.08, rx: w * 0.42, ry: d * 0.38,
      fill, stroke, "stroke-width": sel ? 2.2 : 1.4, transform: xf,
    }));
    gg.appendChild(el("rect", {
      x: cx - w * 0.38, y: cy - d / 2, width: w * 0.76, height: d * 0.32,
      fill: "#2a3038", stroke, "stroke-width": 1.2, transform: xf, "pointer-events": "none",
    }));
  } else if (type === "bathtub") {
    gg.appendChild(el("rect", {
      x: cx - w / 2, y: cy - d / 2, width: w, height: d, rx: Math.min(w, d) * 0.2, ry: Math.min(w, d) * 0.2,
      fill, stroke, "stroke-width": sel ? 2.2 : 1.4, transform: xf,
    }));
    gg.appendChild(el("ellipse", {
      cx, cy, rx: w * 0.32, ry: d * 0.28,
      fill: "#1a3040", stroke: "none", transform: xf, "pointer-events": "none",
    }));
  } else if (type === "fridge" || type === "washer" || type === "stove" || type === "dishwasher" || type === "microwave" || type === "range_hood") {
    body({ fill: type === "stove" || type === "microwave" ? "#1a1c20" : "#2a3038" });
    if (type === "stove") {
      for (const [ox, oy] of [[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.15], [0.22, 0.15]]) {
        gg.appendChild(el("circle", {
          cx: cx + w * ox, cy: cy + d * oy, r: Math.min(w, d) * 0.12,
          fill: "none", stroke: "#c9a227", "stroke-width": 1.2, transform: xf, "pointer-events": "none",
        }));
      }
    } else if (type === "range_hood") {
      gg.appendChild(el("path", {
        d: `M ${cx - w * 0.35} ${cy + d * 0.2} L ${cx} ${cy - d * 0.35} L ${cx + w * 0.35} ${cy + d * 0.2}`,
        fill: "none", stroke, "stroke-width": 1.4, transform: xf, "pointer-events": "none",
      }));
    } else {
      gg.appendChild(el("line", {
        x1: cx, y1: cy - d / 2, x2: cx, y2: cy + d / 2,
        stroke, "stroke-width": 1.2, transform: xf, "pointer-events": "none",
      }));
    }
  } else if (type === "sink" || type === "vanity") {
    body();
    gg.appendChild(el("ellipse", {
      cx, cy, rx: w * 0.28, ry: d * 0.28,
      fill: "#1a2834", stroke, "stroke-width": 1.2, transform: xf, "pointer-events": "none",
    }));
  } else if (type === "bookshelf" || type === "bookshelf_narrow" || type === "tvstand" || type === "nightstand"
    || type === "dresser" || type === "sideboard" || type === "chest" || type === "filing" || type === "shoe_rack") {
    body();
    const shelves = type === "bookshelf" || type === "bookshelf_narrow" ? 3
      : type === "dresser" || type === "chest" || type === "filing" ? 2 : 1;
    for (let i = 1; i <= shelves; i++) {
      const ly = cy - d / 2 + (d * i) / (shelves + 1);
      gg.appendChild(el("line", {
        x1: cx - w / 2, y1: ly, x2: cx + w / 2, y2: ly,
        stroke, "stroke-width": 1, transform: xf, "pointer-events": "none",
      }));
    }
  } else if (type === "cabinet" || type === "kitchen_island" || type === "wardrobe") {
    // Mature cabinet plan symbol: carcass, toe kick, counter, doors/drawers, handles
    const kind = type === "wardrobe" ? "tall" : (c.kind || "base");
    const isWall = kind === "wall";
    const isDrawer = kind === "drawer";
    const kick = (!isWall && type !== "wardrobe") ? Math.min(d * 0.12, 8) : 0;
    const bodyD = d - kick;
    const bodyY = cy - d / 2;
    // carcass
    gg.appendChild(el("rect", {
      x: cx - w / 2, y: bodyY, width: w, height: bodyD,
      fill: isWall ? "#2a323c" : fill, stroke, "stroke-width": sel ? 2.4 : 1.5,
      transform: xf,
    }));
    // toe kick (inset from front)
    if (kick > 0) {
      gg.appendChild(el("rect", {
        x: cx - w / 2 + 2, y: cy + d / 2 - kick, width: w - 4, height: kick,
        fill: "#14181e", stroke: "none", transform: xf, "pointer-events": "none",
      }));
    }
    // countertop overhang (base / island / drawer)
    if (!isWall && kind !== "tall" && type !== "wardrobe") {
      const oh = Math.min(4, d * 0.06);
      gg.appendChild(el("rect", {
        x: cx - w / 2 - 1, y: bodyY - oh, width: w + 2, height: oh + 1.5,
        fill: "#c4b59a", "fill-opacity": 0.85, stroke: "#a89070", "stroke-width": 0.8,
        transform: xf, "pointer-events": "none",
      }));
    }
    // wall cabinet elevation hint
    if (isWall) {
      gg.appendChild(el("rect", {
        x: cx - w / 2, y: bodyY, width: w, height: bodyD,
        fill: "none", stroke: "#5a7088", "stroke-width": 1, "stroke-dasharray": "4 3",
        transform: xf, "pointer-events": "none",
      }));
    }
    const n = Math.max(1, doors || (type === "wardrobe" ? 3 : 2));
    if (isDrawer) {
      const drawers = Math.max(2, Math.min(5, c.drawers || placeCabinet.drawers || 3));
      for (let i = 1; i < drawers; i++) {
        const ly = bodyY + (bodyD * i) / drawers;
        gg.appendChild(el("line", {
          x1: cx - w / 2 + 2, y1: ly, x2: cx + w / 2 - 2, y2: ly,
          stroke, "stroke-width": 1.1, transform: xf, "pointer-events": "none",
        }));
      }
      for (let i = 0; i < drawers; i++) {
        const hy = bodyY + (bodyD * (i + 0.5)) / drawers;
        gg.appendChild(el("line", {
          x1: cx - w * 0.12, y1: hy, x2: cx + w * 0.12, y2: hy,
          stroke: "#c9a227", "stroke-width": 1.8, transform: xf, "pointer-events": "none",
        }));
      }
    } else {
      const leafW = w / n;
      for (let i = 1; i < n; i++) {
        const lx = cx - w / 2 + leafW * i;
        gg.appendChild(el("line", {
          x1: lx, y1: bodyY + 1, x2: lx, y2: bodyY + bodyD - 1,
          stroke, "stroke-width": 1.2, transform: xf, "pointer-events": "none",
        }));
      }
      // door panel inset + handles near front
      for (let i = 0; i < n; i++) {
        const lx = cx - w / 2 + leafW * i + 3;
        gg.appendChild(el("rect", {
          x: lx, y: bodyY + 3, width: leafW - 6, height: Math.max(4, bodyD - 6 - kick * 0.2),
          fill: "none", stroke, "stroke-opacity": 0.45, "stroke-width": 0.8,
          transform: xf, "pointer-events": "none",
        }));
        gg.appendChild(el("circle", {
          cx: cx - w / 2 + leafW * (i + (i % 2 === 0 ? 0.72 : 0.28)),
          cy: cy + d / 2 - kick - 5, r: 2.2,
          fill: "#c9a227", stroke: "none", transform: xf, "pointer-events": "none",
        }));
      }
    }
  } else {
    body();
  }

  // Front edge mark (except rug / curtain / mirror / thin decor)
  if (!["rug", "runner", "curtain", "curtain_sheer", "curtain_wide", "blinds", "mirror", "tv", "wall_art"].includes(type)) {
    gg.appendChild(el("line", {
      x1: cx - w / 2, y1: cy + d / 2, x2: cx + w / 2, y2: cy + d / 2,
      stroke: "#c9a227", "stroke-width": 2.4, transform: xf, "pointer-events": "none",
    }));
  }

  const label = el("text", {
    x: cx, y: cy + Math.max(d, 8) / 2 + 12, fill: "#9aa0a6", "font-size": 9, "text-anchor": "middle",
    transform: xf,
  });
  const short = (c.label || def.label).split(" ")[0];
  const isCurtainType = def.isCurtain;
  const styleTag = isCurtainType
    ? (curtainStyles().find((s) => s.id === (c.curtainStyle || def.curtainStyle || "cloth"))?.label.split(" ")[0] || "Cloth")
    : null;
  const kindTag = (type === "cabinet" || type === "kitchen_island")
    ? (CABINET_KINDS.find((k) => k.id === (c.kind || "base"))?.label.split(" ")[0] || "")
    : null;
  label.textContent = doors > 0
    ? `${short}${kindTag ? ` · ${kindTag}` : ""} · ${doors}d`
    : (styleTag ? `${short} · ${styleTag}` : short);
  label.style.pointerEvents = "none";
  gg.appendChild(label);

  gg.appendChild(el("rect", {
    x: cx - w / 2, y: cy - d / 2, width: w, height: d,
    fill: "transparent", transform: xf,
  }));
  g.appendChild(gg);
}

/* ---------- render ---------- */
function draw() {
  if (!doc) return;
  svg.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const layerGroups = {};
  for (const L of doc.layers) {
    if (L.visible === false) continue;
    const g = el("g", { "data-layer": L.id, opacity: clamp01(L.opacity ?? 1) });
    svg.appendChild(g);
    layerGroups[L.id] = g;
  }
  const hostFor = (obj, kind) => {
    if (!objectLayerVisible(obj, kind)) return null;
    const id = objectLayerId(obj, kind);
    return layerGroups[id] || null;
  };

  // Reference images
  for (const im of doc.images) {
    if (!im.src) continue;
    const host = hostFor(im, "image");
    if (!host) continue;
    const sel = isInSelection("image", im.id);
    const img = el("image", {
      href: im.src,
      x: mmX(im.x),
      y: mmY(im.y + im.h),
      width: im.w * S,
      height: im.h * S,
      opacity: clamp01(im.opacity ?? 0.45),
      preserveAspectRatio: "none",
      "data-kind": "image",
      "data-id": im.id,
    });
    img.setAttributeNS("http://www.w3.org/1999/xlink", "href", im.src);
    host.appendChild(img);
    if (sel) {
      host.appendChild(el("rect", {
        x: mmX(im.x), y: mmY(im.y + im.h), width: im.w * S, height: im.h * S,
        fill: "none", stroke: "#4f9fd4", "stroke-width": 2, "stroke-dasharray": "8 4",
        "pointer-events": "none",
      }));
      const corners = [
        ["nw", im.x, im.y + im.h],
        ["ne", im.x + im.w, im.y + im.h],
        ["se", im.x + im.w, im.y],
        ["sw", im.x, im.y],
      ];
      for (const [grip, gx, gy] of corners) {
        host.appendChild(el("circle", {
          cx: mmX(gx), cy: mmY(gy), r: 7, fill: "#4f9fd4",
          "data-kind": "image", "data-id": im.id, "data-grip": grip,
        }));
      }
    }
  }

  for (const r of doc.rooms) {
    const g = hostFor(r, "room");
    if (!g) continue;
    const pts = roomPoints(r);
    if (pts.length < 3) continue;
    const lit = roomLit(r);
    const sel = isInSelection("room", r.id);
    const poly = el("polygon", {
      points: pts.map((p) => `${mmX(p.x)},${mmY(p.y)}`).join(" "),
      fill: lit ? "#4f9fd4" : "#1c2430",
      "fill-opacity": lit ? 0.22 : 0.5,
      stroke: sel ? "#4f9fd4" : "#3a4554",
      "stroke-width": sel ? 2 : 1,
      "data-kind": "room",
      "data-id": r.id,
    });
    g.appendChild(poly);
    if (sel) {
      pts.forEach((p, i) => {
        g.appendChild(el("circle", {
          cx: mmX(p.x), cy: mmY(p.y), r: 6, fill: "#4f9fd4",
          "data-kind": "room", "data-id": r.id, "data-grip": String(i),
        }));
      });
    }
    const c = centroid(pts);
    const t = el("text", {
      x: mmX(c.x), y: mmY(c.y) + 4,
      fill: "#9aa0a6", "font-size": 13, "text-anchor": "middle",
      "font-family": "system-ui,sans-serif",
    });
    t.textContent = r.label;
    t.style.pointerEvents = "none";
    g.appendChild(t);
  }

  for (const w of doc.walls) {
    const g = hostFor(w, "wall");
    if (!g) continue;
    syncWallAb(w);
    const sel = isInSelection("wall", w.id);
    const sw = Math.max(8, wallThickness(w) * S * 0.9);
    const pts = wallPoints(w);
    for (const [t0, t1] of wallSegments(doc, w)) {
      const span = wallSpanPoints(w, t0, t1);
      if (span.length < 2) continue;
      const pointsAttr = span.map((p) => `${mmX(p.x)},${mmY(p.y)}`).join(" ");
      g.appendChild(el("polyline", {
        points: pointsAttr,
        fill: "none",
        stroke: sel ? "#4f9fd4" : "#d7dde8",
        "stroke-width": sw,
        "stroke-linecap": "butt",
        "stroke-linejoin": "miter",
        "stroke-miterlimit": 3,
        "data-kind": "wall", "data-id": w.id,
      }));
    }
    g.appendChild(el("polyline", {
      points: pts.map((p) => `${mmX(p.x)},${mmY(p.y)}`).join(" "),
      fill: "none",
      stroke: "transparent",
      "stroke-width": 28,
      "stroke-linejoin": "round",
      "data-kind": "wall", "data-id": w.id,
    }));
    if (sel) {
      pts.forEach((p, i) => {
        const grip = i === 0 ? "a" : i === pts.length - 1 ? "b" : `v${i}`;
        g.appendChild(el("circle", {
          cx: mmX(p.x), cy: mmY(p.y), r: 7, fill: "#4f9fd4",
          "data-kind": "wall", "data-id": w.id, "data-grip": grip,
        }));
      });
    }
  }

  for (const o of doc.openings) {
    const g = hostFor(o, "opening");
    if (!g) continue;
    const w = doc.walls.find((x) => x.id === o.wallId);
    if (!w) continue;
    const p0 = pointAt(w, Math.min(o.t0, o.t1));
    const p1 = pointAt(w, Math.max(o.t0, o.t1));
    const sel = isInSelection("opening", o.id);
    const col = o.type === "window" ? "#5b9fd4" : o.type === "door" ? "#a89070" : "#3a4554";
    g.appendChild(el("line", {
      x1: mmX(p0.x), y1: mmY(p0.y), x2: mmX(p1.x), y2: mmY(p1.y),
      stroke: sel ? "#c9a227" : col, "stroke-width": 4, "stroke-dasharray": o.type === "window" ? "2 3" : "6 4",
      "data-kind": "opening", "data-id": o.id,
    }));
  }

  for (const d of doc.doors) {
    const g = hostFor(d, "door");
    if (!g) continue;
    try { drawDoorSymbol(g, d); } catch (err) { console.warn("door draw", d.id, err); }
  }

  for (const win of doc.windows || []) {
    const g = hostFor(win, "window");
    if (!g) continue;
    drawWindowSymbol(g, win);
  }

  for (const l of doc.lights || []) {
    const g = hostFor(l, "light");
    if (g) drawLightSymbol(g, l);
  }
  for (const f of doc.fans || []) {
    const g = hostFor(f, "fan");
    if (g) drawFanSymbol(g, f);
  }
  for (const s of doc.sockets || []) {
    const g = hostFor(s, "socket");
    if (g) drawSocketSymbol(g, s);
  }
  for (const c of doc.cabinets || []) {
    const g = hostFor(c, "cabinet");
    if (!g) continue;
    try { drawCabinetSymbol(g, c); } catch (err) { console.warn("cabinet draw", c.id, err); }
  }

  // ghosts (top)
  if (draft?.kind === "wall" && draft.start) {
    const p = draft.hover || draft.start;
    svg.appendChild(el("line", {
      x1: mmX(draft.start.x), y1: mmY(draft.start.y),
      x2: mmX(p.x), y2: mmY(p.y),
      stroke: "#4f9fd4", "stroke-width": 3, "stroke-dasharray": "8 4",
    }));
  }
  if (draft?.kind === "cut" && draft.wallId != null && draft.t0 != null && draft.hoverT != null) {
    const w = doc.walls.find((x) => x.id === draft.wallId);
    if (w) {
      const p0 = pointAt(w, draft.t0), p1 = pointAt(w, draft.hoverT);
      svg.appendChild(el("line", {
        x1: mmX(p0.x), y1: mmY(p0.y), x2: mmX(p1.x), y2: mmY(p1.y),
        stroke: "#c45c5c", "stroke-width": 8, "stroke-linecap": "round",
      }));
    }
  }
  if (draft?.kind === "polyroom" && draft.pts?.length) {
    const pts = [...draft.pts];
    if (draft.hover) pts.push(draft.hover);
    if (pts.length >= 2) {
      svg.appendChild(el("polyline", {
        points: pts.map((p) => `${mmX(p.x)},${mmY(p.y)}`).join(" "),
        fill: "none", stroke: "#4f9fd4", "stroke-width": 2, "stroke-dasharray": "8 4",
      }));
    }
    if (pts.length >= 3) {
      svg.appendChild(el("polygon", {
        points: pts.map((p) => `${mmX(p.x)},${mmY(p.y)}`).join(" "),
        fill: "#4f9fd422", stroke: "none",
      }));
    }
    for (const p of draft.pts) {
      svg.appendChild(el("circle", { cx: mmX(p.x), cy: mmY(p.y), r: 5, fill: "#4f9fd4" }));
    }
    if (draft.pts.length >= 3) {
      const f = draft.pts[0];
      svg.appendChild(el("circle", {
        cx: mmX(f.x), cy: mmY(f.y), r: 10, fill: "none", stroke: "#c9a227", "stroke-width": 2,
      }));
    }
  }

  // door / window placement ghost on wall hover
  if (placeHover && (tool === "door" || tool === "window")) {
    const gh = el("g", { class: "place-ghost", opacity: "0.85", "pointer-events": "none" });
    const wall = doc.walls.find((w) => w.id === placeHover.wallId);
    if (wall) {
      svg.appendChild(el("line", {
        x1: mmX(wall.a.x), y1: mmY(wall.a.y),
        x2: mmX(wall.b.x), y2: mmY(wall.b.y),
        stroke: "#4f9fd4", "stroke-width": 10, opacity: "0.25", "stroke-linecap": "round",
      }));
    }
    svg.appendChild(el("line", {
      x1: mmX(placeHover.p0.x), y1: mmY(placeHover.p0.y),
      x2: mmX(placeHover.p1.x), y2: mmY(placeHover.p1.y),
      stroke: placeHover.kind === "window" ? "#6eb6e0" : "#c9a227",
      "stroke-width": 10, "stroke-linecap": "butt", opacity: "0.55",
    }));
    if (placeHover.kind === "door") {
      drawDoorSymbol(gh, {
        id: "_ghost",
        hinge: placeHover.hinge,
        closedDeg: placeHover.closedDeg,
        hingeAt: placeDoor.hingeAt,
        openSide: placeDoor.openSide,
        openAngle: placeDoor.openAngle || 85,
        open: false,
        style: placeDoor.style,
        widthMm: placeDoor.widthMm,
        len: placeDoor.widthMm,
        heightMm: placeDoor.heightMm,
        sillMm: placeDoor.sillMm,
        _ghostSeg: {
          wallId: placeHover.wallId,
          p0: placeHover.p0,
          p1: placeHover.p1,
          t0: placeHover.t0,
          t1: placeHover.t1,
        },
      });
      const tag = el("text", {
        x: mmX(placeHover.hinge.x), y: mmY(placeHover.hinge.y) - 16,
        fill: "#c9a227", "font-size": 11, "text-anchor": "middle",
      });
      tag.textContent = `${placeDoor.style} · ${placeDoor.widthMm}×${placeDoor.heightMm} · ${placeDoor.openSide >= 0 ? "L" : "R"}`;
      gh.appendChild(tag);
    } else {
      drawWindowSymbol(gh, {
        id: "_ghost",
        openingId: null,
        wallId: placeHover.wallId,
        style: placeWindow.style,
        widthMm: placeWindow.widthMm,
        heightMm: placeWindow.heightMm,
        sillMm: placeWindow.sillMm,
        _ghostSeg: { t0: placeHover.t0, t1: placeHover.t1, wallId: placeHover.wallId },
      });
      const mid = {
        x: (placeHover.p0.x + placeHover.p1.x) / 2,
        y: (placeHover.p0.y + placeHover.p1.y) / 2,
      };
      const tag = el("text", {
        x: mmX(mid.x), y: mmY(mid.y) - 14,
        fill: "#7eb8d8", "font-size": 11, "text-anchor": "middle",
      });
      tag.textContent = `${placeWindow.style} · sill ${placeWindow.sillMm} · ${placeWindow.widthMm}×${placeWindow.heightMm}`;
      gh.appendChild(tag);
    }
    svg.appendChild(gh);
  }

  if (measurePts?.a && measurePts?.b) {
    svg.appendChild(el("line", {
      x1: mmX(measurePts.a.x), y1: mmY(measurePts.a.y),
      x2: mmX(measurePts.b.x), y2: mmY(measurePts.b.y),
      stroke: "#c9a227", "stroke-width": 2,
    }));
    const mid = { x: (measurePts.a.x + measurePts.b.x) / 2, y: (measurePts.a.y + measurePts.b.y) / 2 };
    const t = el("text", { x: mmX(mid.x), y: mmY(mid.y) - 8, fill: "#c9a227", "font-size": 14, "text-anchor": "middle" });
    t.textContent = fmtLen(dist(measurePts.a, measurePts.b));
    svg.appendChild(t);
  }

  if (marquee) {
    const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
    const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
    svg.appendChild(el("rect", {
      x: mmX(x0), y: mmY(y1), width: Math.max(1, (x1 - x0) * S), height: Math.max(1, (y1 - y0) * S),
      fill: "rgba(79,159,212,0.12)", stroke: "#4f9fd4", "stroke-width": 1.5,
      "stroke-dasharray": "4 3", "pointer-events": "none",
    }));
  }

  renderLayers();
  renderInspector();
  renderObjList();
  syncStatus();
}

function inspectorStateKey() {
  const u = unitsMode();
  if (selection.length > 1) {
    return `${u}:multi:${selection.map((s) => `${s.kind}:${s.id}`).join(",")}`;
  }
  if (selected) return `${u}:sel:${selected.kind}:${selected.id}`;
  if (tool === "door") {
    return `${u}:place:door:${placeDoor.style}:${placeDoor.widthMm}:${placeDoor.heightMm}:${placeDoor.sillMm}:${placeDoor.hingeAt}:${placeDoor.openSide}`;
  }
  if (tool === "window") {
    return `${u}:place:window:${placeWindow.style}:${placeWindow.widthMm}:${placeWindow.heightMm}:${placeWindow.sillMm}`;
  }
  if (tool === "light") {
    return `${u}:place:light:${placeLight.shape}:${placeLight.colorTempK}:${placeLight.intensity}:${placeLight.lengthMm}`;
  }
  if (tool === "fan") {
    return `${u}:place:fan:${placeFan.blades}:${placeFan.diameterMm}:${placeFan.hangMm}:${placeFan.speed}`;
  }
  if (tool === "socket") {
    return `${u}:place:socket:${placeSocket.style}`;
  }
  if (tool === "cabinet") {
    return `${u}:place:cabinet:${placeCabinet.type}:${placeCabinet.kind}:${placeCabinet.doors}:${placeCabinet.drawers}:${placeCabinet.widthMm}:${placeCabinet.depthMm}:${placeCabinet.heightMm}:${placeCabinet.rotationDeg}:${placeCabinet.colorHex}:${placeCabinet.curtainStyle}:${placeCabinet.foldMode}`;
  }
  return `${u}:idle:${tool}:${doc?.snapMm}:${doc?.gridMm}:${doc?.flooring}:${doc?.wallHeightMm}`;
}

function renderPlaceCabinetPanel() {
  const def = furnitureDef(placeCabinet.type);
  if (!furnUi.ready && !furnUi.loading) {
    ensureFurnishCatalog();
  }
  const cats = Catalog.listCategories();
  const catTabs = cats.length
    ? `<div class="furn-cat-tabs">${cats.map((c) =>
      `<button type="button" class="furn-cat-tab ${furnUi.cat === c.label && !furnUi.search ? "on" : ""}" data-furn-cat="${c.label}">${c.label}<span class="furn-cat-count">${c.count ?? ""}</span></button>`
    ).join("")}</div>`
    : "";
  const searchBox = `<input type="search" class="furn-search" data-furn-search placeholder="Search library…" value="${(furnUi.search || "").replace(/"/g, "&quot;")}" />`;

  let itemBtns = "";
  if (furnUi.loading && !furnUi.ready) {
    itemBtns = `<p class="hint furn-loading">Loading furniture library…</p>`;
  } else if (furnUi.error && !furnUi.ready) {
    itemBtns = `<p class="hint" style="color:#c45">Could not load catalog: ${furnUi.error}</p>`;
  } else if (furnUi.search.trim()) {
    const hits = Catalog.searchItems(furnUi.search).slice(0, 80);
    itemBtns = hits.length
      ? `<div class="furn-cat-btns">${hits.map((t) =>
        `<button type="button" class="furn-preset ${placeCabinet.type === t.id ? "on" : ""}" data-furn-type="${t.id}" title="${t.cat} · ${t.label}">${t.label}</button>`
      ).join("")}</div>`
      : `<p class="hint">No matches for “${furnUi.search.replace(/</g, "")}”.</p>`;
  } else {
    const items = Catalog.getLoadedItems(furnUi.cat);
    itemBtns = items.length
      ? `<div class="furn-cat"><span class="furn-cat-label">${furnUi.cat}</span><div class="furn-cat-btns">${items.map((t) =>
        `<button type="button" class="furn-preset ${placeCabinet.type === t.id ? "on" : ""}" data-furn-type="${t.id}" title="${t.label}">${t.label}</button>`
      ).join("")}</div>`
      : `<p class="hint">Loading ${furnUi.cat}…</p>`;
  }

  const isCab = def.isCabinet || placeCabinet.type === "cabinet" || placeCabinet.type === "kitchen_island";
  const doorRow = def.hasDoors && placeCabinet.kind !== "drawer"
    ? `<label>Doors</label><div class="sel-actions">${CABINET_DOOR_OPTIONS.map((n) =>
      `<button type="button" data-preset="cabinet-doors" data-doors="${n}" class="${placeCabinet.doors === n ? "on" : ""}">${n}</button>`
    ).join("")}</div>`
    : "";
  const drawerRow = isCab && placeCabinet.kind === "drawer"
    ? `<label>Drawers</label><div class="sel-actions">${CABINET_DRAWER_OPTIONS.map((n) =>
      `<button type="button" data-preset="cabinet-drawers" data-drawers="${n}" class="${placeCabinet.drawers === n ? "on" : ""}">${n}</button>`
    ).join("")}</div>`
    : "";
  const kindRow = isCab
    ? `<label>Cabinet style</label><select data-place="cabinet" data-prop="kind">${CABINET_KINDS.map((k) =>
      `<option value="${k.id}" ${placeCabinet.kind === k.id ? "selected" : ""}>${k.label}</option>`
    ).join("")}</select>`
    : "";
  const curtainRow = def.isCurtain
    ? `<label>Curtain type</label><select data-place="cabinet" data-prop="curtainStyle">${curtainStyles().map((s) =>
      `<option value="${s.id}" ${(placeCabinet.curtainStyle || def.curtainStyle || "cloth") === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("")}</select>
      <label>Fold / draw</label><select data-place="cabinet" data-prop="foldMode">${foldModes().map((m) =>
      `<option value="${m.id}" ${(placeCabinet.foldMode || "both") === m.id ? "selected" : ""}>${m.label}</option>`
    ).join("")}</select>`
    : "";
  const minD = def.isCurtain || def.id === "mirror" || def.id === "tv" || def.id === "wall_art" ? 40 : 150;
  return `
    <div class="sel-box">
      <strong>Place furniture</strong>
      <p class="hint" style="margin:0 0 8px">Library loads on demand · gold edge = front.</p>
      ${searchBox}
      ${catTabs}
      <div class="furn-grid">${itemBtns}</div>
      ${kindRow}
      ${curtainRow}
      ${doorRow}
      ${drawerRow}
      <label>Color</label>
      <div class="color-row">${colorSwatchRow(placeCabinet.colorHex || def.color, "data-furn-color")}</div>
      <input data-place="cabinet" data-prop="colorHex" type="color" value="${normalizeHexColor(placeCabinet.colorHex || def.color)}" />
      <label>${uLabel("Width")}</label>
      <input data-place="cabinet" data-prop="widthMm" data-len="1" type="number" min="${lenMin(200)}" step="${lenStep(true)}" value="${fmtNum(placeCabinet.widthMm)}" />
      <label>${uLabel("Depth")}</label>
      <input data-place="cabinet" data-prop="depthMm" data-len="1" type="number" min="${lenMin(minD)}" step="${lenStep(false)}" value="${fmtNum(placeCabinet.depthMm)}" />
      <label>${uLabel("Height")}</label>
      <input data-place="cabinet" data-prop="heightMm" data-len="1" type="number" min="${lenMin(20)}" step="${lenStep(false)}" value="${fmtNum(placeCabinet.heightMm)}" />
      <label>Rotation (°)</label>
      <input data-place="cabinet" data-prop="rotationDeg" type="number" step="15" value="${placeCabinet.rotationDeg}" />
    </div>`;
}

function renderPlaceDoorPanel() {
  const styleOpts = DOOR_STYLES.map((s) =>
    `<option value="${s.id}" ${placeDoor.style === s.id ? "selected" : ""}>${s.label}</option>`
  ).join("");
  const hingeStart = placeDoor.hingeAt !== "end";
  const openL = placeDoor.openSide >= 0;
  return `
    <div class="sel-box">
      <strong>Place door</strong>
      <p class="hint" style="margin:0 0 8px">Set swing side &amp; hinge, then click a wall. After placing, click the gold L/R or H markers on the plan to adjust.</p>
      <label>Hinge</label>
      <div class="sel-actions">
        <button type="button" data-place-door="hinge" data-hinge="start" class="${hingeStart ? "on" : ""}">Start jamb</button>
        <button type="button" data-place-door="hinge" data-hinge="end" class="${hingeStart ? "" : "on"}">End jamb</button>
      </div>
      <label>Opens toward</label>
      <div class="sel-actions">
        <button type="button" data-place-door="open" data-side="1" class="${openL ? "on" : ""}">Wall left (L)</button>
        <button type="button" data-place-door="open" data-side="-1" class="${openL ? "" : "on"}">Wall right (R)</button>
      </div>
      <label>Style</label>
      <select data-place="door" data-prop="style">${styleOpts}</select>
      <label>${uLabel("Width")}</label>
      <input data-place="door" data-prop="widthMm" data-len="1" type="number" min="${lenMin(200)}" step="${lenStep(true)}" value="${fmtNum(placeDoor.widthMm)}" />
      <div class="sel-actions">
        <button type="button" data-preset="door" data-w="700">${fmtNum(700)}</button>
        <button type="button" data-preset="door" data-w="800">${fmtNum(800)}</button>
        <button type="button" data-preset="door" data-w="900">${fmtNum(900)}</button>
        <button type="button" data-preset="door" data-w="1000">${fmtNum(1000)}</button>
      </div>
      <label>${uLabel("Height")}</label>
      <input data-place="door" data-prop="heightMm" data-len="1" type="number" min="${lenMin(100)}" step="${lenStep(true)}" value="${fmtNum(placeDoor.heightMm)}" />
      <label>${uLabel("Sill elevation")}</label>
      <input data-place="door" data-prop="sillMm" data-len="1" type="number" min="${lenMin(0)}" step="${lenStep(false)}" value="${fmtNum(placeDoor.sillMm)}" />
    </div>`;
}

function renderPlaceWindowPanel() {
  const styleOpts = WINDOW_STYLES.map((s) =>
    `<option value="${s.id}" ${placeWindow.style === s.id ? "selected" : ""}>${s.label}</option>`
  ).join("");
  return `
    <div class="sel-box">
      <strong>Place window</strong>
      <p class="hint" style="margin:0 0 8px">Set size &amp; sill, then hover a wall for preview and click to place.</p>
      <label>Style</label>
      <select data-place="window" data-prop="style">${styleOpts}</select>
      <label>${uLabel("Width")}</label>
      <input data-place="window" data-prop="widthMm" data-len="1" type="number" min="${lenMin(200)}" step="${lenStep(true)}" value="${fmtNum(placeWindow.widthMm)}" />
      <div class="sel-actions">
        <button type="button" data-preset="window" data-w="900">${fmtNum(900)}</button>
        <button type="button" data-preset="window" data-w="1200">${fmtNum(1200)}</button>
        <button type="button" data-preset="window" data-w="1500">${fmtNum(1500)}</button>
        <button type="button" data-preset="window" data-w="1800">${fmtNum(1800)}</button>
      </div>
      <label>${uLabel("Height")}</label>
      <input data-place="window" data-prop="heightMm" data-len="1" type="number" min="${lenMin(100)}" step="${lenStep(true)}" value="${fmtNum(placeWindow.heightMm)}" />
      <label>${uLabel("Sill elevation")}</label>
      <input data-place="window" data-prop="sillMm" data-len="1" type="number" min="${lenMin(0)}" step="${lenStep(false)}" value="${fmtNum(placeWindow.sillMm)}" />
      <p class="hint" style="margin:8px 0 0">Head = sill + height = ${fmtLen(placeWindow.sillMm + placeWindow.heightMm)}</p>
    </div>`;
}

function renderInspector() {
  const key = inspectorStateKey();
  if (key === lastInspectorKey) return;
  lastInspectorKey = key;

  try {
    renderInspectorContent();
  } catch (err) {
    console.warn("inspector", err);
    inspector.innerHTML = `<div class="sel-box"><strong>Properties</strong><p class="hint">Could not render panel.</p></div>`;
  }
  // Keep properties in view when something is selected
  if (selected) {
    const box = inspector.querySelector(".sel-box");
    if (box) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderInspectorContent() {
  if (selection.length > 1) {
    const kinds = [...new Set(selection.map((s) => s.kind))];
    const inGroup = selected && findGroupsFor(doc, selected.kind, selected.id).length > 0;
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>${selection.length} selected</strong>
        <p class="hint" style="margin:0 0 8px">${kinds.join(", ")} · Shift-click to add · drag empty to marquee</p>
        <div class="sel-actions">
          <button type="button" data-sel="select-similar">Select similar</button>
          <button type="button" data-sel="select-kind">Select same type</button>
          <button type="button" data-sel="group">Group</button>
          <button type="button" data-sel="ungroup" ${inGroup ? "" : "disabled"}>Ungroup</button>
          <button type="button" data-sel="select-group" ${inGroup ? "" : "disabled"}>Select group</button>
          <button type="button" data-sel="delete">Delete</button>
        </div>
        <label>Move to layer</label>
        <select data-sel="move-layer">
          ${(doc.layers || []).map((L) => `<option value="${L.id}">${L.name}</option>`).join("")}
        </select>
        <p class="hint" style="margin:8px 0 0">Right-click for context menu · ⌘G group · Shift-click add</p>
      </div>`;
    return;
  }
  if (!selected && tool === "door") {
    inspector.innerHTML = renderPlaceDoorPanel();
    return;
  }
  if (!selected && tool === "window") {
    inspector.innerHTML = renderPlaceWindowPanel();
    return;
  }
  if (!selected && tool === "light") {
    const shapeOpts = LIGHT_SHAPES.map((s) =>
      `<option value="${s.id}" ${placeLight.shape === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("");
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Place light</strong>
        <p class="hint" style="margin:0 0 8px">Set properties, then click on the plan.</p>
        <label>Shape</label>
        <select data-place="light" data-prop="shape">${shapeOpts}</select>
        <label>Color temperature (K)</label>
        <input data-place="light" data-prop="colorTempK" type="number" min="2200" max="6500" step="100" value="${placeLight.colorTempK}" />
        <label>Intensity (0–2)</label>
        <input data-place="light" data-prop="intensity" type="number" min="0" max="2" step="0.1" value="${placeLight.intensity}" />
        <label>${uLabel("Tube length")}</label>
        <input data-place="light" data-prop="lengthMm" data-len="1" type="number" min="${lenMin(300)}" step="${lenStep(true)}" value="${fmtNum(placeLight.lengthMm)}" />
      </div>`;
    return;
  }
  if (!selected && tool === "fan") {
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Place hanging fan</strong>
        <p class="hint" style="margin:0 0 8px">Ceiling canopy + downrod pipe · click to place.</p>
        <label>Blades</label>
        <input data-place="fan" data-prop="blades" type="number" min="2" max="6" value="${placeFan.blades}" />
        <label>${uLabel("Diameter")}</label>
        <input data-place="fan" data-prop="diameterMm" data-len="1" type="number" min="${lenMin(600)}" step="${lenStep(true)}" value="${fmtNum(placeFan.diameterMm)}" />
        <label>${uLabel("Hang / rod length")}</label>
        <input data-place="fan" data-prop="hangMm" data-len="1" type="number" min="${lenMin(80)}" step="${lenStep(true)}" value="${fmtNum(placeFan.hangMm)}" />
        <label>Speed (0–3)</label>
        <input data-place="fan" data-prop="speed" type="number" min="0" max="3" value="${placeFan.speed}" />
      </div>`;
    return;
  }
  if (!selected && tool === "socket") {
    const styleOpts = SOCKET_STYLES.map((s) =>
      `<option value="${s.id}" ${placeSocket.style === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("");
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Place socket</strong>
        <label>Style</label>
        <select data-place="socket" data-prop="style">${styleOpts}</select>
      </div>`;
    return;
  }
  if (!selected && tool === "cabinet") {
    inspector.innerHTML = renderPlaceCabinetPanel();
    return;
  }

  if (!selected) {
    const floor = doc.flooring || "hardwood";
    const floorOpts = FLOORING_STYLES.map((s) =>
      `<option value="${s.id}" ${floor === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("");
    inspector.innerHTML = `<div class="sel-box"><strong>Document</strong>
      <p class="hint" style="margin:0 0 8px">Select a wall for elevation/height, or set defaults below.</p>
      <label>3D flooring</label>
      <select data-doc="flooring">${floorOpts}</select>
      <label>${uLabel("Snap spacing")}</label>
      <input data-doc="snapMm" data-len="1" type="number" min="${lenMin(1)}" step="${lenStep(false)}" value="${fmtNum(doc.snapMm ?? 50)}" />
      <label>${uLabel("Grid spacing")}</label>
      <input data-doc="gridMm" data-len="1" type="number" min="${lenMin(1)}" step="${lenStep(false)}" value="${fmtNum(doc.gridMm ?? 50)}" />
      <label>${uLabel("Default wall height")}</label>
      <input data-doc="wallHeightMm" data-len="1" type="number" min="${lenMin(1000)}" step="${lenStep(true)}" value="${fmtNum(doc.wallHeightMm ?? 2600)}" />
      <label>${uLabel("Default wall thickness")}</label>
      <input data-doc="wallThicknessMm" data-len="1" type="number" min="${lenMin(50)}" step="${lenStep(false)}" value="${fmtNum(doc.wallThicknessMm ?? 120)}" />
      <p class="hint" style="margin:8px 0 0">Changing default wall height or thickness updates existing walls that still use the previous default (and related door/window sizes for height).</p>
    </div>`;
    return;
  }
  const { kind, id } = selected;
  if (kind === "image") {
    const im = doc.images.find((x) => x.id === id);
    if (!im) { lastInspectorKey = ""; return; }
    const pct = Math.round(clamp01(im.opacity) * 100);
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Trace image · ${im.name || im.id}</strong>
        <label>Opacity</label>
        <div class="range-row">
          <input data-prop="opacity" data-live="1" type="range" min="0" max="100" value="${pct}" />
          <span id="opVal">${pct}%</span>
        </div>
        <label>${uLabel("Width")}</label>
        <input data-prop="w" data-len="1" type="number" step="${lenStep(true)}" value="${fmtNum(im.w)}" />
        <label>${uLabel("Height")}</label>
        <input data-prop="h" data-len="1" type="number" step="${lenStep(true)}" value="${fmtNum(im.h)}" />
        <label>${uLabel("X / Y")}</label>
        <div class="actions">
          <input data-prop="x" data-len="1" type="number" step="${lenStep(true)}" value="${fmtNum(im.x)}" style="width:48%" />
          <input data-prop="y" data-len="1" type="number" step="${lenStep(true)}" value="${fmtNum(im.y)}" style="width:48%" />
        </div>
        <div class="sel-actions">
          <button type="button" data-sel="fit-plan">Fit to plan</button>
          <button type="button" data-sel="delete">Delete image</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "wall") {
    const w = doc.walls.find((x) => x.id === id);
    if (!w) { lastInspectorKey = ""; return; }
    const elev = wallElev(w);
    const h = wallHeight(w);
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Wall · ${fmtLen(wallLen(w))}</strong>
        <p class="size-badge">Base ${fmtLen(elev)} · height ${fmtLen(h)} · top ${fmtLen(elev + h)}</p>
        <label>${uLabel("Length")}</label>
        <input data-prop="lengthMm" data-len="1" type="number" min="${lenMin(100)}" step="${lenStep(true)}" value="${fmtNum(Math.round(wallLen(w)))}" />
        <label>${uLabel("Thickness")}</label>
        <input data-prop="thickness" data-len="1" type="number" min="${lenMin(50)}" step="${lenStep(false)}" value="${fmtNum(wallThickness(w))}" />
        <label>${uLabel("Base elevation")}</label>
        <input data-prop="elevMm" data-len="1" type="number" min="${lenMin(0)}" step="${lenStep(true)}" value="${fmtNum(elev)}" />
        <label>${uLabel("Wall height")}</label>
        <input data-prop="height" data-len="1" type="number" min="${lenMin(1000)}" step="${lenStep(true)}" value="${fmtNum(h)}" />
        <p class="hint" style="margin:8px 0 0">Drag end grips to resize, or set length here (keeps start point fixed). Elevation = bottom above floor.</p>
        <div class="sel-actions">
          <button type="button" data-sel="split-mid">Split mid</button>
          <button type="button" data-sel="explode-wall">Explode</button>
          <button type="button" data-sel="delete">Delete</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "opening") {
    const o = doc.openings.find((x) => x.id === id);
    if (!o) { lastInspectorKey = ""; return; }
    const width = openingWidth(o);
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Opening · ${o.type || "passage"}</strong>
        <label>Type</label>
        <select data-prop="type">
          <option value="passage" ${o.type === "passage" ? "selected" : ""}>Passage</option>
          <option value="door" ${o.type === "door" ? "selected" : ""}>Door</option>
          <option value="window" ${o.type === "window" ? "selected" : ""}>Window</option>
        </select>
        <label>${uLabel("Width")}</label>
        <input data-prop="openWidth" data-len="1" type="number" min="${lenMin(200)}" step="${lenStep(true)}" value="${fmtNum(width)}" />
        <label>${uLabel("Height")}</label>
        <input data-prop="heightMm" data-len="1" type="number" value="${fmtNum(o.heightMm ?? DOOR_HEIGHT_DEFAULT)}" />
        <label>${uLabel("Sill elevation")}</label>
        <input data-prop="sillMm" data-len="1" type="number" value="${fmtNum(o.sillMm ?? 0)}" />
        <div class="sel-actions">
          <button type="button" data-sel="add-door">Add door</button>
          <button type="button" data-sel="add-window">Add window</button>
          <button type="button" data-sel="delete">Remove</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "door") {
    const d = doc.doors.find((x) => x.id === id);
    if (!d) { lastInspectorKey = ""; return; }
    applyDoorFrame(d);
    const styleOpts = DOOR_STYLES.map((s) =>
      `<option value="${s.id}" ${d.style === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("");
    const hingeStart = d.hingeAt !== "end";
    const openL = d.openSide >= 0;
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Door · ${d.label || d.id}</strong>
        <p class="size-badge" data-size-badge>${fmtSize2(d.widthMm || d.len, d.heightMm ?? DOOR_HEIGHT_DEFAULT)}</p>
        <p class="hint" style="margin:0 0 8px">On plan: gold <b>L/R</b> = open side · gold <b>H</b> = hinge end. Arc shows swing.</p>
        <label>Hinge</label>
        <div class="sel-actions">
          <button type="button" data-sel="hinge-start" class="${hingeStart ? "on" : ""}">Start jamb</button>
          <button type="button" data-sel="hinge-end" class="${hingeStart ? "" : "on"}">End jamb</button>
        </div>
        <label>Opens toward</label>
        <div class="sel-actions">
          <button type="button" data-sel="open-side" data-side="1" class="${openL ? "on" : ""}">Wall left (L)</button>
          <button type="button" data-sel="open-side" data-side="-1" class="${openL ? "" : "on"}">Wall right (R)</button>
        </div>
        <div class="sel-actions">
          <button type="button" data-sel="flip-open">Flip swing</button>
          <button type="button" data-sel="flip-hinge">Flip hinge</button>
          <button type="button" data-sel="rot-m">−15°</button>
          <button type="button" data-sel="rot-p">+15°</button>
        </div>
        <label>Open angle (°)</label>
        <input data-prop="openAngle" type="number" min="30" max="180" value="${Math.round(d.openAngle ?? Math.abs(d.openDelta ?? 85))}" />
        <label>Closed offset (°)</label>
        <input data-prop="closedOffsetDeg" type="number" step="5" value="${Math.round(d.closedOffsetDeg || 0)}" />
        <label>Style</label>
        <select data-prop="style">${styleOpts}</select>
        <label>${uLabel("Width")}</label>
        <input data-prop="widthMm" data-live="1" data-len="1" type="number" min="${lenMin(200)}" step="${lenStep(false)}" value="${fmtNum(d.widthMm || d.len)}" />
        <div class="sel-actions">
          <button type="button" data-preset-sel="door" data-w="700">${fmtNum(700)}</button>
          <button type="button" data-preset-sel="door" data-w="800">${fmtNum(800)}</button>
          <button type="button" data-preset-sel="door" data-w="900">${fmtNum(900)}</button>
          <button type="button" data-preset-sel="door" data-w="1000">${fmtNum(1000)}</button>
        </div>
        <label>${uLabel("Height")}</label>
        <input data-prop="heightMm" data-live="1" data-len="1" type="number" min="${lenMin(100)}" step="${lenStep(false)}" value="${fmtNum(d.heightMm ?? DOOR_HEIGHT_DEFAULT)}" />
        <label>${uLabel("Sill elevation")}</label>
        <input data-prop="sillMm" data-live="1" data-len="1" type="number" min="${lenMin(0)}" step="${lenStep(false)}" value="${fmtNum(d.sillMm ?? 0)}" />
        <label>Label</label>
        <input data-prop="label" type="text" value="${d.label || ""}" />
        <div class="sel-actions">
          <button type="button" data-sel="delete">Delete</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "window") {
    const win = doc.windows.find((x) => x.id === id);
    if (!win) return;
    const styleOpts = WINDOW_STYLES.map((s) =>
      `<option value="${s.id}" ${win.style === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("");
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Window · ${win.label || win.id}</strong>
        <p class="size-badge" data-size-badge>${fmtSize2(win.widthMm, win.heightMm)} · sill ${fmtLen(win.sillMm)}</p>
        <p class="hint" style="margin:0 0 8px">Style drives 3D motion: casement swing · sliding · awning tip · double-hung lift · fixed.</p>
        <label>Style</label>
        <select data-prop="style">${styleOpts}</select>
        <div class="sel-actions">
          <button type="button" data-sel="toggle-win-open">${win.open ? "Close (3D)" : "Open (3D)"}</button>
        </div>
        <label>${uLabel("Width")}</label>
        <input data-prop="widthMm" data-live="1" data-len="1" type="number" min="${lenMin(200)}" step="${lenStep(false)}" value="${fmtNum(win.widthMm)}" />
        <div class="sel-actions">
          <button type="button" data-preset-sel="window" data-w="900">${fmtNum(900)}</button>
          <button type="button" data-preset-sel="window" data-w="1200">${fmtNum(1200)}</button>
          <button type="button" data-preset-sel="window" data-w="1500">${fmtNum(1500)}</button>
          <button type="button" data-preset-sel="window" data-w="1800">${fmtNum(1800)}</button>
        </div>
        <label>${uLabel("Height")}</label>
        <input data-prop="heightMm" data-live="1" data-len="1" type="number" min="${lenMin(100)}" step="${lenStep(false)}" value="${fmtNum(win.heightMm)}" />
        <label>${uLabel("Sill elevation")}</label>
        <input data-prop="sillMm" data-live="1" data-len="1" type="number" min="${lenMin(0)}" step="${lenStep(false)}" value="${fmtNum(win.sillMm)}" />
        <p class="hint" style="margin:8px 0 0" data-head-elev>Head elevation = sill + height = ${fmtLen(win.sillMm + win.heightMm)}</p>
        <label>Label</label>
        <input data-prop="label" type="text" value="${win.label || ""}" />
        <div class="sel-actions">
          <button type="button" data-sel="delete">Delete</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "light") {
    const o = doc.lights.find((x) => x.id === id);
    if (!o) return;
    const shapeOpts = LIGHT_SHAPES.map((s) =>
      `<option value="${s.id}" ${o.shape === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("");
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Light · ${o.label || o.id}</strong>
        <p class="size-badge">${o.shape} · ${o.colorTempK}K · ${Math.round((o.intensity ?? 1) * 100)}%</p>
        <p class="hint" style="margin:0 0 8px">Drag on plan to move. Toggle On in Objects list.</p>
        <label>Label</label>
        <input data-prop="label" type="text" value="${o.label || ""}" />
        <label>Shape</label>
        <select data-prop="shape">${shapeOpts}</select>
        <label>Color temperature (K)</label>
        <input data-prop="colorTempK" data-live="1" type="number" min="2200" max="6500" step="100" value="${o.colorTempK}" />
        <div class="sel-actions">
          <button type="button" data-kelvin="2700">2700 warm</button>
          <button type="button" data-kelvin="3000">3000</button>
          <button type="button" data-kelvin="4000">4000</button>
          <button type="button" data-kelvin="6500">6500 cool</button>
        </div>
        <label>Intensity (0–2)</label>
        <input data-prop="intensity" data-live="1" type="number" min="0" max="2" step="0.1" value="${o.intensity}" />
        <label>Rotation (°)</label>
        <input data-prop="rotationDeg" data-live="1" type="number" step="15" value="${o.rotationDeg || 0}" />
        ${o.shape === "tube" ? `<label>${uLabel("Tube length")}</label>
        <input data-prop="lengthMm" data-live="1" data-len="1" type="number" min="${lenMin(300)}" step="${lenStep(true)}" value="${fmtNum(o.lengthMm)}" />` : ""}
        <div class="sel-actions">
          <button type="button" data-sel="toggle-on">${o.on ? "Turn off" : "Turn on"}</button>
          <button type="button" data-sel="delete">Delete</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "fan") {
    const o = doc.fans.find((x) => x.id === id);
    if (!o) return;
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Fan · ${o.label || o.id}</strong>
        <p class="size-badge">${o.blades}-blade · ⌀ ${fmtLen(o.diameterMm)} · hang ${fmtLen(o.hangMm || 320)}</p>
        <p class="hint" style="margin:0 0 8px">Hanging ceiling fan with downrod. Drag on plan to move.</p>
        <label>Label</label>
        <input data-prop="label" type="text" value="${o.label || ""}" />
        <label>Blades</label>
        <input data-prop="blades" type="number" min="2" max="6" step="1" value="${o.blades}" />
        <div class="sel-actions">
          <button type="button" data-blades="3">3 wings</button>
          <button type="button" data-blades="4">4</button>
          <button type="button" data-blades="5">5</button>
        </div>
        <label>${uLabel("Diameter")}</label>
        <input data-prop="diameterMm" data-live="1" data-len="1" type="number" min="${lenMin(600)}" step="${lenStep(true)}" value="${fmtNum(o.diameterMm)}" />
        <label>${uLabel("Hang / rod length")}</label>
        <input data-prop="hangMm" data-live="1" data-len="1" type="number" min="${lenMin(80)}" step="${lenStep(true)}" value="${fmtNum(o.hangMm || 320)}" />
        <label>Speed (0–3)</label>
        <input data-prop="speed" type="number" min="0" max="3" step="1" value="${o.speed}" />
        <label>Rotation (°)</label>
        <input data-prop="rotationDeg" data-live="1" type="number" step="15" value="${o.rotationDeg || 0}" />
        <div class="sel-actions">
          <button type="button" data-sel="toggle-on">${o.on ? "Turn off" : "Turn on"}</button>
          <button type="button" data-sel="delete">Delete</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "socket") {
    const o = doc.sockets.find((x) => x.id === id);
    if (!o) return;
    const styleOpts = SOCKET_STYLES.map((s) =>
      `<option value="${s.id}" ${o.style === s.id ? "selected" : ""}>${s.label}</option>`
    ).join("");
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Socket · ${o.label || o.id}</strong>
        <p class="size-badge">${SOCKET_STYLES.find((s) => s.id === o.style)?.label || o.style}</p>
        <p class="hint" style="margin:0 0 8px">Drag on plan to move.</p>
        <label>Label</label>
        <input data-prop="label" type="text" value="${o.label || ""}" />
        <label>Style</label>
        <select data-prop="style">${styleOpts}</select>
        <label>${uLabel("Mount height (AFF)")}</label>
        <input data-prop="elevMm" data-len="1" type="number" min="${lenMin(0)}" step="${lenStep(true)}" value="${fmtNum(o.elevMm ?? defaultSocketElev(o.style))}" />
        <label>Rotation (°)</label>
        <input data-prop="rotationDeg" data-live="1" type="number" step="15" value="${o.rotationDeg || 0}" />
        <div class="sel-actions">
          <button type="button" data-sel="delete">Delete</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "cabinet") {
    const o = (doc.cabinets || []).find((x) => x.id === id);
    if (!o) return;
    const def = furnitureDef(o.type || "cabinet");
    const stubs = furnitureTypeOptions();
    let typeOpts = stubs.map((t) =>
      `<option value="${t.id}" ${(o.type || "cabinet") === t.id ? "selected" : ""}>${t.cat || ""} · ${t.label}</option>`
    ).join("");
    if (o.type && !stubs.some((t) => t.id === o.type)) {
      typeOpts = `<option value="${o.type}" selected>${o.label || o.type}</option>` + typeOpts;
    }
    const isCab = def.isCabinet || (o.type || "cabinet") === "cabinet" || o.type === "kitchen_island";
    const doorBtns = def.hasDoors && o.kind !== "drawer"
      ? `<label>Doors</label><div class="sel-actions">${CABINET_DOOR_OPTIONS.map((n) =>
        `<button type="button" data-preset-sel="cabinet-doors" data-doors="${n}" ${o.doors === n ? "class=\"on\"" : ""}>${n}</button>`
      ).join("")}</div>`
      : "";
    const drawerBtns = isCab && o.kind === "drawer"
      ? `<label>Drawers</label><div class="sel-actions">${CABINET_DRAWER_OPTIONS.map((n) =>
        `<button type="button" data-preset-sel="cabinet-drawers" data-drawers="${n}" ${(o.drawers || 3) === n ? "class=\"on\"" : ""}>${n}</button>`
      ).join("")}</div>`
      : "";
    const kindRow = isCab
      ? `<label>Cabinet style</label><select data-prop="kind">${CABINET_KINDS.map((k) =>
        `<option value="${k.id}" ${o.kind === k.id ? "selected" : ""}>${k.label}</option>`
      ).join("")}</select>`
      : "";
    const curtainRow = def.isCurtain
      ? `<label>Curtain type</label><select data-prop="curtainStyle">${curtainStyles().map((s) =>
        `<option value="${s.id}" ${(o.curtainStyle || def.curtainStyle || "cloth") === s.id ? "selected" : ""}>${s.label}</option>`
      ).join("")}</select>
        <label>Fold / draw</label><select data-prop="foldMode">${foldModes().map((m) =>
        `<option value="${m.id}" ${(o.foldMode || "both") === m.id ? "selected" : ""}>${m.label}</option>`
      ).join("")}</select>`
      : "";
    const openBtn = def.hasDoors && o.kind !== "drawer"
      ? `<button type="button" data-sel="toggle-cab-open">${o.open ? "Close doors" : "Open doors"}</button>`
      : def.hasOpen
        ? (() => {
          const st = o.curtainStyle || def.curtainStyle || "cloth";
          const raise = st === "roman" || st === "horizontal";
          if (raise) return `<button type="button" data-sel="toggle-cab-open">${o.open ? "Lower" : "Raise / fold"}</button>`;
          return `<button type="button" data-sel="toggle-cab-open">${o.open ? "Draw closed" : "Draw open / fold"}</button>`;
        })()
        : "";
    const minD = def.isCurtain || def.id === "mirror" || def.id === "tv" || def.id === "wall_art" ? 40 : 150;
    const color = normalizeHexColor(o.colorHex || def.color, def.color);
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>${def.label} · ${o.label || o.id}</strong>
        <p class="size-badge">${fmtSize3(o.widthMm, o.depthMm, o.heightMm)}</p>
        <p class="hint" style="margin:0 0 8px">Drag to move · gold edge = front.</p>
        <label>Label</label>
        <input data-prop="label" type="text" value="${o.label || ""}" />
        <label>Furniture type</label>
        <select data-prop="type">${typeOpts}</select>
        ${kindRow}
        ${curtainRow}
        ${doorBtns}
        ${drawerBtns}
        <label>Color</label>
        <div class="color-row">${colorSwatchRow(color, "data-sel-furn-color")}</div>
        <input data-prop="colorHex" type="color" value="${color}" />
        <label>${uLabel("Width")}</label>
        <input data-prop="widthMm" data-live="1" data-len="1" type="number" min="${lenMin(200)}" step="${lenStep(true)}" value="${fmtNum(o.widthMm)}" />
        <label>${uLabel("Depth")}</label>
        <input data-prop="depthMm" data-live="1" data-len="1" type="number" min="${lenMin(minD)}" step="${lenStep(false)}" value="${fmtNum(o.depthMm)}" />
        <label>${uLabel("Height")}</label>
        <input data-prop="heightMm" data-live="1" data-len="1" type="number" min="${lenMin(20)}" step="${lenStep(false)}" value="${fmtNum(o.heightMm)}" />
        <label>Rotation (°)</label>
        <input data-prop="rotationDeg" data-live="1" type="number" step="15" value="${o.rotationDeg || 0}" />
        <div class="sel-actions">
          <button type="button" data-sel="cab-rot-m">−15°</button>
          <button type="button" data-sel="cab-rot-p">+15°</button>
          ${openBtn}
          <button type="button" data-sel="delete">Delete</button>
        </div>
      </div>`;
    return;
  }
  if (kind === "room") {
    const r = doc.rooms.find((x) => x.id === id);
    const n = roomPoints(r).length;
    inspector.innerHTML = `
      <div class="sel-box">
        <strong>Room · ${r.label}</strong>
        <p class="hint" style="margin:0 0 8px">${n}-sided polygon</p>
        <label>Label</label>
        <input data-prop="label" type="text" value="${r.label || ""}" />
        <div class="sel-actions">
          <button type="button" data-sel="walls-from-room">Create walls from edges</button>
          <button type="button" data-sel="delete">Delete</button>
        </div>
        ${Array.isArray(r.wallIds) && r.wallIds.length ? `
        <p class="hint" style="margin:10px 0 4px">Walls (shared = one object in both rooms)</p>
        <div class="sel-actions" style="flex-wrap:wrap">
          ${r.wallIds.map((wid) => {
            const shared = (doc.rooms || []).filter((rr) => (rr.wallIds || []).includes(wid)).length > 1;
            return `<button type="button" data-sel="pick-wall" data-wall-id="${wid}">Wall ${String(wid).slice(-6)}${shared ? " · shared" : ""}</button>`;
          }).join("")}
        </div>` : ""}
      </div>`;
    return;
  }
}

function renderLayers() {
  if (!doc?.layers) { layersEl.innerHTML = ""; return; }
  const list = [...doc.layers].reverse();
  layersEl.innerHTML = `
    <div class="layer-toolbar">
      <button type="button" class="mini" data-layer-act="add" title="New layer">+</button>
      <span class="hint" style="margin:0">Active receives new objects · right-click canvas for Move to layer</span>
    </div>
    ${list.map((L) => {
      const active = L.id === activeLayerId ? " active" : "";
      const pct = Math.round(clamp01(L.opacity) * 100);
      const n = countOnLayer(L.id);
      return `<div class="layer-row${active}" data-layer-id="${L.id}">
        <button type="button" class="mini ${L.visible ? "on" : ""}" data-layer-act="vis" title="Visibility">Vis</button>
        <button type="button" class="mini ${L.locked ? "on" : ""}" data-layer-act="lock" title="Lock">${L.locked ? "Lock" : "Edit"}</button>
        <span class="name" data-layer-act="activate" title="Set active · double-click to rename">${L.name} <em class="layer-count">${n}</em></span>
        <div class="ops">
          <button type="button" class="mini" data-layer-act="up" title="Bring forward">↑</button>
          <button type="button" class="mini" data-layer-act="down" title="Send backward">↓</button>
          <button type="button" class="mini" data-layer-act="rename" title="Rename">…</button>
          <button type="button" class="mini" data-layer-act="delete" title="Delete layer">×</button>
        </div>
        <input type="range" min="0" max="100" value="${pct}" data-layer-act="opacity" title="Layer opacity ${pct}%" />
      </div>`;
    }).join("")}`;
}

function renderObjList() {
  const rows = [];
  for (const im of doc.images) rows.push(row("image", im.id, im.name || "Trace image"));
  for (const w of doc.walls) rows.push(row("wall", w.id, `Wall ${Math.round(wallLen(w))}mm`));
  for (const o of doc.openings) rows.push(row("opening", o.id, `${o.type || "open"} ${Math.round(openingWidth(o))}×${Math.round(o.heightMm || 0)}`));
  for (const d of doc.doors) rows.push(row("door", d.id, `${d.style || "swing"} · ${d.label || "Door"}`, d.open ? "Open" : "Closed", d.open));
  for (const w of doc.windows || []) rows.push(row("window", w.id, `${w.style} · sill ${Math.round(w.sillMm)}`, w.open ? "Open" : "Closed", w.open));
  for (const l of doc.lights) rows.push(row("light", l.id, `${l.shape || "bulb"} · ${l.label || "Light"}`, l.on ? "On" : "Off", l.on));
  for (const f of doc.fans) rows.push(row("fan", f.id, `${f.blades || 3}w · ${f.label || "Fan"}`, f.on ? "On" : "Off", f.on));
  for (const s of doc.sockets || []) rows.push(row("socket", s.id, `${s.style || "single"} · ${s.label || "Socket"}`));
  for (const c of doc.cabinets || []) {
    const def = furnitureDef(c.type || "cabinet");
    const tag = (c.doors > 0) ? `${c.doors}d · ${c.label || def.label}` : (c.label || def.label);
    rows.push(row("cabinet", c.id, tag, def.hasDoors ? (c.open ? "Open" : "Closed") : null, c.open));
  }
  for (const r of doc.rooms) rows.push(row("room", r.id, r.label || "Room"));
  objList.innerHTML = rows.join("") || `<p class="hint">Empty document</p>`;
}
function row(kind, id, label, btnText, on) {
  const sel = isInSelection(kind, id) ? " sel" : "";
  const btn = btnText != null
    ? `<button class="ctrl ${on ? "on" : ""}" data-toggle="${kind}" data-id="${id}">${btnText}</button>`
    : `<button class="ctrl" data-pick="${kind}" data-id="${id}">Select</button>`;
  return `<div class="row${sel}"><span>${label}</span>${btn}</div>`;
}

/* ---------- collapsible panels ---------- */
const workspaceEl = document.getElementById("workspace");
const PANEL_LS = {
  tools: "a15-cad-tools-collapsed",
  sidebar: "a15-cad-sidebar-collapsed",
};
function setPanelCollapsed(which, collapsed) {
  const cls = which === "tools" ? "tools-collapsed" : "sidebar-collapsed";
  workspaceEl?.classList.toggle(cls, !!collapsed);
  try { localStorage.setItem(PANEL_LS[which], collapsed ? "1" : "0"); } catch { /* */ }
}
function togglePanel(which) {
  const cls = which === "tools" ? "tools-collapsed" : "sidebar-collapsed";
  setPanelCollapsed(which, !workspaceEl?.classList.contains(cls));
}
function restorePanelCollapse() {
  try {
    if (localStorage.getItem(PANEL_LS.tools) === "1") setPanelCollapsed("tools", true);
    if (localStorage.getItem(PANEL_LS.sidebar) === "1") setPanelCollapsed("sidebar", true);
  } catch { /* */ }
}

/* ---------- tools UI ---------- */
function buildTools() {
  const byGroup = Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, []]));
  for (const t of TOOLS) {
    const g = t.group && byGroup[t.group] ? t.group : "draw";
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(t);
  }
  const groups = TOOL_GROUPS.map((g) => {
    const items = byGroup[g.id] || [];
    if (!items.length) return "";
    return `
      <div class="tool-group" data-group="${g.id}">
        <div class="tool-group-label">${g.label}</div>
        <div class="tool-group-btns">
          ${items.map((t) => {
            const tip = `${t.tip}${t.shortcut ? ` · ${t.shortcut}` : ""}`;
            return `
              <button type="button" class="tool-btn" data-tool="${t.id}"
                aria-label="${t.label}" title="${tip.replace(/"/g, "&quot;")}">
                <span class="tool-icon">${TOOL_ICONS[t.id] || ""}</span>
                <span class="tool-flyout" role="tooltip">
                  <strong>${t.label}</strong>
                  <span>${t.tip}</span>
                  ${t.shortcut ? `<kbd>${t.shortcut}</kbd>` : ""}
                </span>
              </button>`;
          }).join("")}
        </div>
      </div>`;
  }).join("");
  toolsEl.innerHTML = `
    <div class="tools-collapse-wrap">
      <button type="button" class="panel-collapse-btn" data-act="toggle-tools" title="Collapse tools" aria-label="Collapse tools">‹</button>
    </div>
    ${groups}`;
}
function setTool(id) {
  tool = id;
  draft = null;
  joinPick = null;
  measurePts = null;
  placeHover = null;
  lastInspectorKey = "";
  if (operate) operate = false;
  if (id === "door" || id === "window" || id === "light" || id === "fan" || id === "socket" || id === "cabinet") clearSelection();
  syncStatus();
  draw();
  if (id === "room") msg("Polygon room: click each corner · Enter / double-click / click first point to close");
  else if (id === "door") msg("Door: set size in inspector · hover wall for preview · click to place");
  else if (id === "window") msg("Window: set size & sill · hover wall for preview · click to place");
  else if (id === "cabinet") { ensureFurnitureVisible(); ensureFurnishCatalog(); msg("Furniture: pick a type in inspector · click plan to place"); }
  else if (id === "light") { ensureDevicesVisible(); msg("Light: click to place · set shape/temp in inspector after place"); }
  else if (id === "fan") { ensureDevicesVisible(); msg("Fan: click to place · 3-wing default · edit in inspector"); }
  else if (id === "socket") { ensureDevicesVisible(); msg("Socket: click to place · edit style in inspector"); }
  else msg(TOOLS.find((t) => t.id === id)?.tip || id);
}

/* ---------- pointer ---------- */
function onPointerDown(e) {
  shiftDown = e.shiftKey;
  if (e.button === 1 || tool === "pan" || spaceDown) {
    pan = { x0: e.clientX, y0: e.clientY, vb: { ...viewBox } };
    wrap.classList.add("panning");
    wrap.setPointerCapture(e.pointerId);
    return;
  }
  const raw = clientToMm(e.clientX, e.clientY);
  let p = snapPoint(raw);
  if (tool === "wall" && draft?.start) p = orthoPoint(draft.start, p);
  if (tool === "measure" && measurePts?.a && !measurePts.b) p = orthoPoint(measurePts.a, p);
  cursorMm = p;
  syncStatus();

  if (operate) return operateClick(p);

  if (tool === "select") return selectDown(e, p);
  if (tool === "wall") return wallClick(p);
  if (tool === "split") {
    const hw = hitWall(p);
    if (hw) splitWallAt(hw.wall, hw.t);
    return;
  }
  if (tool === "join") {
    const hw = hitWall(p);
    if (!hw) return;
    if (!joinPick) {
      joinPick = hw.wall.id;
      setSelected("wall", hw.wall.id);
      draw();
      msg("Select second wall to join");
      return;
    }
    const w1 = doc.walls.find((w) => w.id === joinPick);
    const w2 = hw.wall;
    if (w1 && w2 && w1.id !== w2.id) joinWalls(w1, w2);
    else joinPick = null;
    return;
  }
  if (tool === "explode") {
    const hw = hitWall(p);
    if (hw) explodeWall(hw.wall);
    else {
      const sel = selection.find((s) => s.kind === "wall");
      const w = sel && doc.walls.find((x) => x.id === sel.id);
      if (w) explodeWall(w);
      else msg("Select or click a polyline wall to explode");
    }
    return;
  }
  if (tool === "cut") return cutClick(p);
  if (tool === "opening") {
    const hw = hitWall(p);
    if (hw) addOpeningOnWall(hw.wall, hw.t);
    return;
  }
  if (tool === "door") return doorClick(p);
  if (tool === "window") return windowClick(p);
  if (tool === "light") {
    const probe = normalizeLight({
      id: "tmp", x: p.x, y: p.y, on: true, label: "Light",
      shape: placeLight.shape,
      colorTempK: placeLight.colorTempK,
      intensity: placeLight.intensity,
      lengthMm: placeLight.lengthMm,
      rotationDeg: placeLight.rotationDeg,
    });
    if (!placementOk("light", probe, p.x, p.y)) {
      msg("Cannot place light through a wall / outside room");
      return;
    }
    pushHistory();
    ensureDevicesVisible();
    const l = normalizeLight({
      id: uid("lt"), x: p.x, y: p.y, on: true, label: "Light",
      shape: placeLight.shape,
      colorTempK: placeLight.colorTempK,
      intensity: placeLight.intensity,
      lengthMm: placeLight.lengthMm,
      rotationDeg: placeLight.rotationDeg,
      layerId: activeLayerOrFirst(),
    });
    doc.lights.push(l);
    lastInspectorKey = "";
    setSelected("light", l.id);
    dirty = true;
    saveDraft();
    draw();
    msg(`Light (${l.shape}) placed`);
    return;
  }
  if (tool === "fan") {
    const probe = normalizeFan({
      id: "tmp", x: p.x, y: p.y, on: true, label: "Fan",
      blades: placeFan.blades,
      diameterMm: placeFan.diameterMm,
      hangMm: placeFan.hangMm,
      speed: placeFan.speed,
      rotationDeg: placeFan.rotationDeg,
    });
    if (!placementOk("fan", probe, p.x, p.y)) {
      msg("Cannot place fan through a wall / outside room");
      return;
    }
    pushHistory();
    ensureDevicesVisible();
    const f = normalizeFan({
      id: uid("fn"), x: p.x, y: p.y, on: true, label: "Fan",
      blades: placeFan.blades,
      diameterMm: placeFan.diameterMm,
      hangMm: placeFan.hangMm,
      speed: placeFan.speed,
      rotationDeg: placeFan.rotationDeg,
      layerId: activeLayerOrFirst(),
    });
    doc.fans.push(f);
    lastInspectorKey = "";
    setSelected("fan", f.id);
    dirty = true;
    saveDraft();
    draw();
    msg(`Fan (${f.blades} blades) placed`);
    return;
  }
  if (tool === "socket") {
    const probe = normalizeSocket({
      id: "tmp", x: p.x, y: p.y, label: "Socket",
      style: placeSocket.style,
      rotationDeg: placeSocket.rotationDeg,
    });
    if (!placementOk("socket", probe, p.x, p.y)) {
      msg("Cannot place outlet through a wall");
      return;
    }
    pushHistory();
    ensureDevicesVisible();
    if (!doc.sockets) doc.sockets = [];
    const s = normalizeSocket({
      id: uid("sk"), x: p.x, y: p.y, label: "Socket",
      style: placeSocket.style,
      rotationDeg: placeSocket.rotationDeg,
      layerId: activeLayerOrFirst(),
    });
    doc.sockets.push(s);
    lastInspectorKey = "";
    setSelected("socket", s.id);
    dirty = true;
    saveDraft();
    draw();
    msg(`Socket (${s.style}) placed`);
    return;
  }
  if (tool === "cabinet") {
    const probe = normalizeCabinet({
      id: "tmp", x: p.x, y: p.y,
      type: placeCabinet.type,
      label: furnitureDef(placeCabinet.type).label,
      kind: placeCabinet.kind,
      doors: placeCabinet.doors,
      drawers: placeCabinet.drawers,
      curtainStyle: placeCabinet.curtainStyle,
      foldMode: placeCabinet.foldMode,
      colorHex: placeCabinet.colorHex,
      widthMm: placeCabinet.widthMm,
      depthMm: placeCabinet.depthMm,
      heightMm: placeCabinet.heightMm,
      rotationDeg: placeCabinet.rotationDeg,
      open: false,
    });
    if (!placementOk("cabinet", probe, p.x, p.y)) {
      msg("Cannot place furniture through a wall / outside room");
      return;
    }
    pushHistory();
    ensureFurnitureVisible();
    if (!doc.cabinets) doc.cabinets = [];
    const c = normalizeCabinet({
      id: uid("fur"), x: p.x, y: p.y,
      type: placeCabinet.type,
      label: furnitureDef(placeCabinet.type).label,
      kind: placeCabinet.kind,
      doors: placeCabinet.doors,
      drawers: placeCabinet.drawers,
      curtainStyle: placeCabinet.curtainStyle,
      foldMode: placeCabinet.foldMode,
      colorHex: placeCabinet.colorHex,
      widthMm: placeCabinet.widthMm,
      depthMm: placeCabinet.depthMm,
      heightMm: placeCabinet.heightMm,
      rotationDeg: placeCabinet.rotationDeg,
      open: false,
      layerId: activeLayerOrFirst(),
    });
    doc.cabinets.push(c);
    lastInspectorKey = "";
    setSelected("cabinet", c.id);
    dirty = true;
    saveDraft();
    draw();
    msg(`${c.label} placed`);
    return;
  }
  if (tool === "room") return polyRoomClick(p);
  if (tool === "measure") {
    if (!measurePts?.a || measurePts.b) measurePts = { a: p, b: null };
    else measurePts.b = p;
    draw();
    if (measurePts.b) msg(fmtLen(dist(measurePts.a, measurePts.b)));
    return;
  }
}

function operateClick(p) {
  const door = hitDoor(p);
  if (door) {
    pushHistory();
    door.open = !door.open;
    ensureOhClient().pushDevice("door", door);
    draw();
    return;
  }
  const light = hitLight(p);
  if (light) {
    pushHistory();
    light.on = !light.on;
    ensureOhClient().pushDevice("light", light);
    draw();
    return;
  }
  const fan = hitFan(p);
  if (fan) {
    pushHistory();
    fan.on = !fan.on;
    ensureOhClient().pushDevice("fan", fan);
    draw();
    return;
  }
  const cab = hitCabinet(p);
  if (cab) {
    if (!furnitureDef(cab.type || "cabinet").hasDoors) return;
    pushHistory();
    cab.open = !cab.open;
    ensureOhClient().pushDevice("cabinet", cab);
    draw();
  }
}

function beginDragFor(kind, id, e, grip = null) {
  const origObj = findDocObj(kind, id);
  if (objectLayerLocked(origObj, kind)) return;
  if (!origObj && kind !== "opening") return;
  drag = {
    kind, id, grip: grip || null,
    moved: false, x0: e.clientX, y0: e.clientY,
    orig: origObj ? clone(origObj) : null,
    origOpening: (kind === "door" || kind === "window") && origObj?.openingId
      ? clone(doc.openings.find((o) => o.id === origObj.openingId) || null)
      : null,
    stickyRoom: (kind === "light" || kind === "fan" || kind === "cabinet" || kind === "socket") && origObj?.x != null
      ? findRoomAt(doc, { x: origObj.x, y: origObj.y })
      : null,
    multiOrig: null,
    last: null,
    pointerId: e.pointerId,
  };
  // Snapshot other movable multi-select members for group drag
  if (selection.length > 1 && ["light", "fan", "socket", "cabinet", "image"].includes(kind)) {
    drag.multiOrig = selection
      .filter((s) => s.kind !== kind || s.id !== id)
      .map((s) => {
        const o = findDocObj(s.kind, s.id);
        return o ? { kind: s.kind, id: s.id, orig: clone(o) } : null;
      })
      .filter(Boolean);
  }
  wrap.setPointerCapture(e.pointerId);
}

function selectDown(e, p) {
  const additive = !!(e.shiftKey || e.metaKey || e.ctrlKey);
  const target = e.target.closest?.("[data-kind]");
  // Plan markers for door handing (before drag)
  if (target?.dataset.doorAct && target.dataset.kind === "door") {
    const id = target.dataset.id;
    const d = doc.doors.find((x) => x.id === id);
    if (d && !objectLayerLocked(d, "door")) {
      pushHistory();
      if (target.dataset.doorAct === "open-side") {
        setDoorOpenSide(d, Number(target.dataset.side));
        placeDoor.openSide = d.openSide;
        msg(d.openSide >= 0 ? "Opens wall-left (L)" : "Opens wall-right (R)");
      } else if (target.dataset.doorAct === "hinge") {
        setDoorHinge(d, target.dataset.hinge);
        placeDoor.hingeAt = d.hingeAt;
        msg(d.hingeAt === "end" ? "Hinge at end jamb" : "Hinge at start jamb");
      }
      setSelected("door", d.id, { additive: false });
      dirty = true;
      saveDraft();
      draw();
    }
    return;
  }

  function pick(kind, id, grip = null) {
    const o = findDocObj(kind, id);
    if (objectLayerLocked(o, kind) && !additive) {
      toast("Layer locked", "err");
      return;
    }
    if (additive && isInSelection(kind, id)) {
      setSelected(kind, id, { additive: true });
      draw();
      return;
    }
    if (additive) setSelected(kind, id, { additive: true, grip });
    else if (!isInSelection(kind, id) || selection.length <= 1) setSelected(kind, id, { grip });
    else {
      // keep multi-selection; promote clicked to primary
      setSelection([{ kind, id, grip }, ...selection.filter((s) => !(s.kind === kind && s.id === id))]);
    }
    if (!additive) beginDragFor(kind, id, e, grip);
    draw();
  }

  if (target) {
    const kind = target.getAttribute("data-kind");
    const id = target.getAttribute("data-id");
    const grip = target.getAttribute("data-grip");
    pick(kind, id, grip || null);
    return;
  }
  const door = hitDoor(p);
  if (door && objectLayerVisible(door, "door")) {
    pick("door", door.id);
    return;
  }
  const win = hitWindow(p);
  if (win && objectLayerVisible(win, "window")) { pick("window", win.id); return; }
  const light = hitLight(p);
  if (light && objectLayerVisible(light, "light")) { pick("light", light.id); return; }
  const fan = hitFan(p);
  if (fan && objectLayerVisible(fan, "fan")) { pick("fan", fan.id); return; }
  const sock = hitSocket(p);
  if (sock && objectLayerVisible(sock, "socket")) { pick("socket", sock.id); return; }
  const cab = hitCabinet(p);
  if (cab && objectLayerVisible(cab, "cabinet")) { pick("cabinet", cab.id); return; }
  const op = hitOpening(p);
  if (op && objectLayerVisible(op, "opening")) { pick("opening", op.id); return; }
  const hw = hitWall(p);
  if (hw && objectLayerVisible(hw.wall, "wall")) { pick("wall", hw.wall.id); return; }
  const room = hitRoom(p);
  if (room && objectLayerVisible(room, "room")) { pick("room", room.id); return; }
  const im = hitImage(p);
  if (im && objectLayerVisible(im, "image")) { pick("image", im.id); return; }

  // Empty space: marquee (select tool) or pan
  if (!additive) clearSelection();
  marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive };
  drag = null;
  pan = null;
  wrap.setPointerCapture(e.pointerId);
  draw();
}

function wallClick(p) {
  if (!draft?.start) {
    draft = { kind: "wall", start: p, hover: p };
    msg("Click next point · Shift = ortho XY · Esc cancel · Enter finish");
    draw();
    return;
  }
  p = orthoPoint(draft.start, p);
  if (dist(draft.start, p) < 50) {
    msg("Wall too short");
    return;
  }
  pushHistory();
  let wall = normalizeWall({
    id: uid("w"),
    points: [{ ...draft.start }, { ...p }],
    thickness: doc.wallThicknessMm ?? 120,
    height: defaultWallHeight(),
    elevMm: 0,
    layerId: activeLayerOrFirst(),
  }, doc);
  doc.walls.push(wall);
  wall = absorbDrawnWall(wall);
  detectClosedRoomsFromWalls();
  draft = { kind: "wall", start: { ...wallPoints(wall).at(-1) }, hover: { ...wallPoints(wall).at(-1) } };
  setSelected("wall", wall.id);
  draw();
  msg("Wall added · continue or Esc · Shift = ortho");
}

function polyRoomClick(p) {
  if (draft?.kind === "polyroom" && draft.pts?.length) {
    p = orthoPoint(draft.pts[draft.pts.length - 1], p);
  }
  if (!draft || draft.kind !== "polyroom") {
    draft = { kind: "polyroom", pts: [p], hover: p };
    msg("Polygon room · click vertices · click first point or Enter to close");
    draw();
    return;
  }
  const first = draft.pts[0];
  if (draft.pts.length >= 3 && dist(p, first) <= HIT_MM) {
    closePolyRoom();
    return;
  }
  const last = draft.pts[draft.pts.length - 1];
  if (dist(p, last) < 50) return;
  draft.pts.push(p);
  draft.hover = p;
  draw();
  msg(`${draft.pts.length} pts · click start or Enter to close`);
}

function closePolyRoom() {
  if (!draft || draft.kind !== "polyroom" || draft.pts.length < 3) {
    draft = null;
    draw();
    msg("Need at least 3 points");
    return;
  }
  pushHistory();
  const r = { id: uid("rm"), label: "Room", points: draft.pts.map((p) => ({ ...p })), layerId: activeLayerOrFirst() };
  doc.rooms.push(r);
  setSelected("room", r.id);
  draft = null;
  draw();
  msg("Polygon room added");
}

function wallsFromRoom(room) {
  const pts = roomPoints(room);
  if (pts.length < 3) return;
  pushHistory();
  const th = doc.wallThicknessMm ?? 120;
  const ht = defaultWallHeight();
  // One closed polyline wall (no creases); room keeps wallIds for shared selection
  const ring = pts.map((p) => ({ ...p }));
  const wall = normalizeWall({
    id: uid("w"),
    points: ring,
    thickness: th,
    height: ht,
    elevMm: 0,
    closed: true,
    layerId: room.layerId || activeLayerOrFirst(),
  }, doc);
  wall.closed = true;
  syncWallAb(wall);
  doc.walls.push(wall);
  room.wallIds = [wall.id];
  detectClosedRoomsFromWalls();
  setSelected("wall", wall.id);
  draw();
  msg("Closed wall loop created from room");
}

function computePlaceHover(p, kind) {
  const hw = hitWall(p);
  if (!hw) return null;
  const width = kind === "door" ? placeDoor.widthMm : placeWindow.widthMm;
  const L = wallLen(hw.wall) || 1;
  const halfT = (Math.max(200, width) / 2) / L;
  let t0 = hw.t - halfT;
  let t1 = hw.t + halfT;
  if (t0 < 0) { t1 = Math.min(1, t1 - t0); t0 = 0; }
  if (t1 > 1) { t0 = Math.max(0, t0 - (t1 - 1)); t1 = 1; }
  const p0 = pointAt(hw.wall, t0);
  const p1 = pointAt(hw.wall, t1);
  const closedDeg = (Math.atan2(hw.wall.b.y - hw.wall.a.y, hw.wall.b.x - hw.wall.a.x) * 180) / Math.PI;
  const hinge = kind === "door" && placeDoor.hingeAt === "end" ? { ...p1 } : { ...p0 };
  return {
    kind,
    wallId: hw.wall.id,
    t: hw.t,
    t0,
    t1,
    hinge,
    closedDeg,
    p0,
    p1,
  };
}

function doorClick(p) {
  const hw = hitWall(p);
  if (!hw) {
    msg("Click a wall to place a door");
    return;
  }
  const width = placeDoor.widthMm;
  const preview = computePlaceHover(p, "door");
  const o = addOpeningOnWall(hw.wall, hw.t, width, {
    type: "door",
    heightMm: placeDoor.heightMm,
    sillMm: placeDoor.sillMm,
    silent: true,
    silentSelect: true,
  });
  const hinge = pointAt(hw.wall, Math.min(o.t0, o.t1));
  const closedDeg = preview?.closedDeg
    ?? (Math.atan2(hw.wall.b.y - hw.wall.a.y, hw.wall.b.x - hw.wall.a.x) * 180) / Math.PI;
  const d = normalizeDoor({
    id: uid("door"),
    openingId: o.id,
    hinge: { ...hinge },
    len: Math.round(openingWidth(o)),
    widthMm: Math.round(openingWidth(o)),
    heightMm: placeDoor.heightMm,
    sillMm: placeDoor.sillMm,
    style: placeDoor.style,
    hingeAt: placeDoor.hingeAt === "end" ? "end" : "start",
    openSide: placeDoor.openSide >= 0 ? 1 : -1,
    openAngle: placeDoor.openAngle || 85,
    closedOffsetDeg: 0,
    open: false,
    label: DOOR_STYLES.find((s) => s.id === placeDoor.style)?.label || "Door",
    layerId: activeLayerOrFirst(),
  });
  applyDoorFrame(d);
  doc.doors.push(d);
  dirty = true;
  saveDraft();
  placeHover = null;
  lastInspectorKey = "";
  tool = "select";
  setSelected("door", d.id);
  syncStatus();
  draw();
  msg(`Door (${d.style}) — click L/R or H on plan to set direction`);
}

function windowClick(p) {
  const hw = hitWall(p);
  if (!hw) {
    msg("Click a wall to place a window");
    return;
  }
  const opening = addOpeningOnWall(hw.wall, hw.t, placeWindow.widthMm, {
    type: "window",
    heightMm: placeWindow.heightMm,
    sillMm: placeWindow.sillMm,
    silent: true,
    silentSelect: true,
  });
  if (!doc.windows) doc.windows = [];
  const win = normalizeWindow({
    id: uid("win"),
    openingId: opening.id,
    wallId: opening.wallId,
    style: placeWindow.style,
    widthMm: Math.round(openingWidth(opening)) || placeWindow.widthMm,
    heightMm: placeWindow.heightMm,
    sillMm: placeWindow.sillMm,
    label: WINDOW_STYLES.find((s) => s.id === placeWindow.style)?.label || "Window",
    layerId: activeLayerOrFirst(),
  });
  doc.windows.push(win);
  placeHover = null;
  lastInspectorKey = "";
  setSelected("window", win.id);
  dirty = true;
  saveDraft();
  draw();
  msg(`Window sill ${fmtLen(win.sillMm)} · ${fmtSize2(win.widthMm, win.heightMm)}`);
}

function hitWindow(p, tol = HIT_MM) {
  for (const win of doc.windows || []) {
    const o = doc.openings.find((x) => x.id === win.openingId);
    if (!o) continue;
    const mid = openingMid(o);
    if (dist(p, mid) <= tol) return win;
  }
  return null;
}

function cutClick(p) {
  const hw = hitWall(p);
  if (!hw) return;
  if (!draft || draft.kind !== "cut" || draft.wallId !== hw.wall.id) {
    draft = { kind: "cut", wallId: hw.wall.id, t0: hw.t, hoverT: hw.t };
    msg("Click second point on same wall");
    draw();
    return;
  }
  cutWall(hw.wall, draft.t0, hw.t);
}

function onPointerMove(e) {
  shiftDown = e.shiftKey;
  const raw = clientToMm(e.clientX, e.clientY);
  let p = snapPoint(raw);
  if (draft?.kind === "wall" && draft.start) p = orthoPoint(draft.start, p);
  if (draft?.kind === "polyroom" && draft.pts?.length) p = orthoPoint(draft.pts[draft.pts.length - 1], p);
  if (tool === "measure" && measurePts?.a && !measurePts.b) p = orthoPoint(measurePts.a, p);
  cursorMm = p;
  document.getElementById("statCursor").textContent = `${Math.round(cursorMm.x)}, ${Math.round(cursorMm.y)}`;
  document.getElementById("statSnap").textContent = [
    snapOn ? `Snap ${doc?.snapMm || 50}mm` : "Snap off",
    shiftDown ? "Ortho XY" : null,
  ].filter(Boolean).join(" · ");

  if (pan) {
    const scale = viewBox.w / (svg.clientWidth || 1);
    viewBox.x = pan.vb.x - (e.clientX - pan.x0) * scale;
    viewBox.y = pan.vb.y - (e.clientY - pan.y0) * scale;
    draw();
    return;
  }
  if (marquee) {
    marquee.x1 = raw.x;
    marquee.y1 = raw.y;
    draw();
    return;
  }
  if (draft?.kind === "wall" && draft.start) {
    draft.hover = cursorMm;
    draw();
    return;
  }
  if (draft?.kind === "polyroom" && draft.pts?.length) {
    draft.hover = cursorMm;
    draw();
    return;
  }
  if (draft?.kind === "cut" && draft.wallId) {
    const w = doc.walls.find((x) => x.id === draft.wallId);
    if (w) {
      draft.hoverT = projectWall(w, cursorMm).t;
      draw();
    }
    return;
  }
  if (drag && !operate && tool === "select") {
    const distPx = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
    if (!drag.moved && distPx < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      pushHistory();
    }
    if (drag.kind === "wall" && drag.orig) {
      const w = doc.walls.find((x) => x.id === drag.id);
      if (!w) return;
      syncWallAb(w);
      const pts = wallPoints(w);
      if (drag.grip === "a") {
        pts[0] = orthoPoint(pts[pts.length - 1], p);
        w.points = pts; syncWallAb(w);
      } else if (drag.grip === "b") {
        pts[pts.length - 1] = orthoPoint(pts[0], p);
        w.points = pts; syncWallAb(w);
      } else if (typeof drag.grip === "string" && drag.grip.startsWith("v")) {
        const vi = Number(drag.grip.slice(1));
        if (Number.isFinite(vi) && vi > 0 && vi < pts.length - 1) {
          pts[vi] = { ...p };
          w.points = pts; syncWallAb(w);
        }
      } else if (drag.last) {
        let dx = p.x - drag.last.x;
        let dy = p.y - drag.last.y;
        if (shiftDown) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        for (const pt of pts) { pt.x += dx; pt.y += dy; }
        w.points = pts; syncWallAb(w);
      }
      drag.last = { ...p };
      reframeDoorsOnWall(w.id);
    } else if (drag.kind === "image" && drag.orig) {
      const im = doc.images.find((x) => x.id === drag.id);
      if (!im) return;
      if (drag.grip) {
        const o = drag.orig;
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        if (drag.grip.includes("w")) x0 = p.x;
        if (drag.grip.includes("e")) x1 = p.x;
        if (drag.grip.includes("s")) y0 = p.y;
        if (drag.grip.includes("n")) y1 = p.y;
        im.x = Math.min(x0, x1);
        im.y = Math.min(y0, y1);
        im.w = Math.max(200, Math.abs(x1 - x0));
        im.h = Math.max(200, Math.abs(y1 - y0));
      } else if (drag.last) {
        let dx = p.x - drag.last.x;
        let dy = p.y - drag.last.y;
        if (shiftDown) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        im.x += dx;
        im.y += dy;
        drag.last = { ...p };
      } else {
        drag.last = { ...p };
      }
    } else if (drag.kind === "door") {
      const d = doc.doors.find((x) => x.id === drag.id);
      const o = d?.openingId ? doc.openings.find((x) => x.id === d.openingId) : null;
      if (d && o) {
        if (drag.grip === "t0" || drag.grip === "t1") {
          setOpeningEnd(o, drag.grip, p);
          syncDoorFromOpening(d);
        } else {
          const wall = doc.walls.find((x) => x.id === o.wallId);
          if (wall) {
            const { t } = projectWall(wall, p);
            setOpeningCenter(o, t);
            syncDoorFromOpening(d);
          }
        }
        refreshInspectorSizeFields("door", d);
      }
    } else if (drag.kind === "window") {
      const win = doc.windows.find((x) => x.id === drag.id);
      const o = win?.openingId ? doc.openings.find((x) => x.id === win.openingId) : null;
      if (win && o) {
        if (drag.grip === "t0" || drag.grip === "t1") {
          setOpeningEnd(o, drag.grip, p);
          syncWindowFromOpening(win);
        } else {
          const wall = doc.walls.find((x) => x.id === o.wallId);
          if (wall) {
            const { t } = projectWall(wall, p);
            setOpeningCenter(o, t);
            syncWindowFromOpening(win);
          }
        }
        refreshInspectorSizeFields("window", win);
      }
    } else if (drag.kind === "light") {
      const l = doc.lights.find((x) => x.id === drag.id);
      if (l) {
        const next = resolveDeviceMove("light", l, l.x, l.y, p.x, p.y, drag.stickyRoom);
        if (next) { l.x = next.x; l.y = next.y; }
        applyMultiDragDelta(drag, l.x - (drag.orig?.x || l.x), l.y - (drag.orig?.y || l.y));
      }
    } else if (drag.kind === "fan") {
      const f = doc.fans.find((x) => x.id === drag.id);
      if (f) {
        const next = resolveDeviceMove("fan", f, f.x, f.y, p.x, p.y, drag.stickyRoom);
        if (next) { f.x = next.x; f.y = next.y; }
        applyMultiDragDelta(drag, f.x - (drag.orig?.x || f.x), f.y - (drag.orig?.y || f.y));
      }
    } else if (drag.kind === "socket") {
      const s = (doc.sockets || []).find((x) => x.id === drag.id);
      if (s) {
        const next = resolveDeviceMove("socket", s, s.x, s.y, p.x, p.y, drag.stickyRoom);
        if (next) { s.x = next.x; s.y = next.y; }
        applyMultiDragDelta(drag, s.x - (drag.orig?.x || s.x), s.y - (drag.orig?.y || s.y));
      }
    } else if (drag.kind === "cabinet") {
      const c = (doc.cabinets || []).find((x) => x.id === drag.id);
      if (c) {
        const next = resolveDeviceMove("cabinet", c, c.x, c.y, p.x, p.y, drag.stickyRoom);
        if (next) { c.x = next.x; c.y = next.y; }
        applyMultiDragDelta(drag, c.x - (drag.orig?.x || c.x), c.y - (drag.orig?.y || c.y));
      }
    } else if (drag.kind === "room" && drag.orig) {
      const r = doc.rooms.find((x) => x.id === drag.id);
      if (!r) return;
      if (!r.points) r.points = roomPoints(r);
      if (drag.grip != null && drag.grip !== "") {
        const i = Number(drag.grip);
        if (r.points[i]) r.points[i] = { ...p };
      } else if (drag.last) {
        let dx = p.x - drag.last.x;
        let dy = p.y - drag.last.y;
        if (shiftDown) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        for (const pt of r.points) { pt.x += dx; pt.y += dy; }
      }
      drag.last = { ...p };
    }
    draw();
    return;
  }

  if (tool === "door" || tool === "window") {
    const next = computePlaceHover(cursorMm, tool);
    const same = placeHover
      && next
      && placeHover.wallId === next.wallId
      && Math.abs(placeHover.t - next.t) < 0.002
      && placeHover.kind === next.kind;
    const cleared = !next && !placeHover;
    if (!same && !cleared) {
      placeHover = next;
      draw();
    } else if (!next && placeHover) {
      placeHover = null;
      draw();
    }
  } else if (placeHover) {
    placeHover = null;
    draw();
  }
}

function applyMultiDragDelta(dragState, dx, dy) {
  if (!dragState?.multiOrig?.length) return;
  for (const m of dragState.multiOrig) {
    const o = findDocObj(m.kind, m.id);
    if (!o || o.x == null) continue;
    const nx = (m.orig.x || 0) + dx;
    const ny = (m.orig.y || 0) + dy;
    const next = resolveDeviceMove(m.kind, o, m.orig.x, m.orig.y, nx, ny, findRoomAt(doc, m.orig));
    if (next) { o.x = next.x; o.y = next.y; }
    else if (m.kind === "image") {
      o.x = nx;
      o.y = ny;
    }
  }
}

function objectsInMarquee(box) {
  const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
  const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
  if (x1 - x0 < 20 && y1 - y0 < 20) return [];
  const hit = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const out = [];
  for (const c of doc.cabinets || []) if (objectLayerVisible(c, "cabinet") && hit(c.x, c.y)) out.push({ kind: "cabinet", id: c.id });
  for (const l of doc.lights || []) if (objectLayerVisible(l, "light") && hit(l.x, l.y)) out.push({ kind: "light", id: l.id });
  for (const f of doc.fans || []) if (objectLayerVisible(f, "fan") && hit(f.x, f.y)) out.push({ kind: "fan", id: f.id });
  for (const s of doc.sockets || []) if (objectLayerVisible(s, "socket") && hit(s.x, s.y)) out.push({ kind: "socket", id: s.id });
  for (const d of doc.doors || []) {
    if (!objectLayerVisible(d, "door")) continue;
    const o = d.openingId ? doc.openings.find((x) => x.id === d.openingId) : null;
    const w = o ? doc.walls.find((x) => x.id === o.wallId) : null;
    if (w) {
      const mid = pointAt(w, (Math.min(o.t0, o.t1) + Math.max(o.t0, o.t1)) / 2);
      if (hit(mid.x, mid.y)) out.push({ kind: "door", id: d.id });
    }
  }
  for (const win of doc.windows || []) {
    if (!objectLayerVisible(win, "window")) continue;
    const o = win.openingId ? doc.openings.find((x) => x.id === win.openingId) : null;
    const w = o ? doc.walls.find((x) => x.id === o.wallId) : null;
    if (w) {
      const mid = pointAt(w, (Math.min(o.t0, o.t1) + Math.max(o.t0, o.t1)) / 2);
      if (hit(mid.x, mid.y)) out.push({ kind: "window", id: win.id });
    }
  }
  for (const w of doc.walls || []) {
    if (!objectLayerVisible(w, "wall")) continue;
    const mx = (w.a.x + w.b.x) / 2, my = (w.a.y + w.b.y) / 2;
    if (hit(mx, my)) out.push({ kind: "wall", id: w.id });
  }
  return out;
}

function onPointerUp() {
  if (marquee) {
    const hits = objectsInMarquee(marquee);
    if (hits.length) {
      if (marquee.additive) {
        const map = new Map(selection.map((s) => [`${s.kind}:${s.id}`, s]));
        for (const h of hits) map.set(`${h.kind}:${h.id}`, h);
        setSelection([...map.values()]);
      } else setSelection(hits);
      msg(`Selected ${selection.length}`);
    }
    marquee = null;
    draw();
  }
  if (drag) {
    drag = null;
    saveDraft();
    if (liveSync && dirty) liveSync.publish(doc, { source: "cad" });
  }
  pan = null;
  wrap.classList.remove("panning");
}

/** Escape during drag: detach from cursor and restore original place. */
function cancelActiveDrag() {
  if (!drag) return false;
  const d = drag;
  drag = null;
  if (d.pointerId != null) {
    try { wrap.releasePointerCapture(d.pointerId); } catch { /* */ }
  }
  if (d.moved && d.orig) {
    restoreDragOrig(d);
    if (history.length) history.pop();
    dirty = true;
    saveDraft();
  }
  lastInspectorKey = "";
  draw();
  return true;
}

function restoreDragOrig(d) {
  if (d.kind === "wall") {
    const w = doc.walls.find((x) => x.id === d.id);
    if (!w || !d.orig) return;
    w.a = { ...d.orig.a };
    w.b = { ...d.orig.b };
    if (d.orig.thickness != null) w.thickness = d.orig.thickness;
    if (d.orig.height != null) w.height = d.orig.height;
    if (d.orig.elevMm != null) w.elevMm = d.orig.elevMm;
    reframeDoorsOnWall(w.id);
    return;
  }
  if (d.kind === "door") {
    const door = doc.doors.find((x) => x.id === d.id);
    if (!door || !d.orig) return;
    Object.assign(door, clone(d.orig));
    if (d.origOpening && door.openingId) {
      const o = doc.openings.find((x) => x.id === door.openingId);
      if (o) Object.assign(o, clone(d.origOpening));
    }
    applyDoorFrame(door);
    return;
  }
  if (d.kind === "window") {
    const win = doc.windows.find((x) => x.id === d.id);
    if (!win || !d.orig) return;
    Object.assign(win, clone(d.orig));
    if (d.origOpening && win.openingId) {
      const o = doc.openings.find((x) => x.id === win.openingId);
      if (o) Object.assign(o, clone(d.origOpening));
    }
    return;
  }
  if (d.kind === "light") {
    const l = doc.lights.find((x) => x.id === d.id);
    if (l && d.orig) { l.x = d.orig.x; l.y = d.orig.y; }
    return;
  }
  if (d.kind === "fan") {
    const f = doc.fans.find((x) => x.id === d.id);
    if (f && d.orig) { f.x = d.orig.x; f.y = d.orig.y; }
    return;
  }
  if (d.kind === "socket") {
    const s = (doc.sockets || []).find((x) => x.id === d.id);
    if (s && d.orig) { s.x = d.orig.x; s.y = d.orig.y; }
    return;
  }
  if (d.kind === "cabinet") {
    const c = (doc.cabinets || []).find((x) => x.id === d.id);
    if (c && d.orig) {
      c.x = d.orig.x; c.y = d.orig.y;
      if (d.orig.rotationDeg != null) c.rotationDeg = d.orig.rotationDeg;
    }
    return;
  }
  if (d.kind === "image") {
    const im = doc.images.find((x) => x.id === d.id);
    if (im && d.orig) {
      im.x = d.orig.x; im.y = d.orig.y;
      im.w = d.orig.w; im.h = d.orig.h;
    }
    return;
  }
  if (d.kind === "room") {
    const r = doc.rooms.find((x) => x.id === d.id);
    if (r && d.orig) {
      if (d.orig.points) r.points = clone(d.orig.points);
      if (d.orig.x != null) r.x = d.orig.x;
      if (d.orig.y != null) r.y = d.orig.y;
      if (d.orig.w != null) r.w = d.orig.w;
      if (d.orig.h != null) r.h = d.orig.h;
    }
  }
}

/* ---------- events ---------- */
wrap.addEventListener("pointerdown", onPointerDown);
wrap.addEventListener("pointermove", onPointerMove);
wrap.addEventListener("pointerup", onPointerUp);
wrap.addEventListener("pointercancel", onPointerUp);
wrap.addEventListener("dblclick", (e) => {
  if (tool !== "room" || draft?.kind !== "polyroom") return;
  e.preventDefault();
  closePolyRoom();
});
wrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 1.08 : 0.92;
  const mm = clientToMm(e.clientX, e.clientY);
  const mx = mmX(mm.x), my = mmY(mm.y);
  viewBox.x = mx - (mx - viewBox.x) * factor;
  viewBox.y = my - (my - viewBox.y) * factor;
  viewBox.w *= factor;
  viewBox.h *= factor;
  draw();
}, { passive: false });

document.addEventListener("keydown", (e) => {
  if (e.key === "Shift") {
    shiftDown = true;
    syncStatus();
  }
  if (e.code === "Space" && !e.repeat) {
    spaceDown = true;
    syncStatus();
  }
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === "s") { e.preventDefault(); saveShared(); return; }
  if (meta && e.key.toLowerCase() === "z" && e.shiftKey) { e.preventDefault(); redo(); return; }
  if (meta && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (meta && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (meta && e.key.toLowerCase() === "c" && selection.length) {
    e.preventDefault();
    copySelection();
    return;
  }
  if (meta && e.key.toLowerCase() === "v" && clipboard) {
    e.preventDefault();
    pasteClipboard();
    return;
  }
  if (meta && e.key.toLowerCase() === "g" && !e.shiftKey) {
    e.preventDefault();
    groupSelectionCad();
    return;
  }
  if (meta && e.shiftKey && e.key.toLowerCase() === "g") {
    e.preventDefault();
    ungroupSelectionCad();
    return;
  }
  if (e.key === "Escape") {
    const openMenu = document.querySelector(".menu.open");
    if (openMenu) {
      openMenu.classList.remove("open");
      openMenu.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
      return;
    }
    if (marquee) { marquee = null; draw(); return; }
    if (cancelActiveDrag()) {
      msg("Move cancelled — restored");
      return;
    }
    draft = null;
    joinPick = null;
    measurePts = null;
    placeHover = null;
    clearSelection();
    draw();
    msg("Cancelled");
    return;
  }
  if (e.key === "Enter" && draft?.kind === "wall") {
    draft = null; draw(); msg("Wall tool finished");
    return;
  }
  if (e.key === "Enter" && draft?.kind === "polyroom") {
    e.preventDefault();
    closePolyRoom();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && selection.length && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (selected?.kind === "door") {
    const d = doc.doors.find((x) => x.id === selected.id);
    if (d && (k === "g" || e.key === "[" || e.key === "]")) {
      e.preventDefault();
      pushHistory();
      if (e.key === "[") setDoorOpenSide(d, -1);
      else if (e.key === "]") setDoorOpenSide(d, 1);
      else flipDoorSwing(d);
      placeDoor.openSide = d.openSide;
      lastInspectorKey = "";
      dirty = true;
      saveDraft();
      draw();
      msg(d.openSide >= 0 ? "Opens wall-left (L)" : "Opens wall-right (R)");
      return;
    }
    if (d && k === "h") {
      e.preventDefault();
      pushHistory();
      flipDoorHinge(d);
      placeDoor.hingeAt = d.hingeAt;
      lastInspectorKey = "";
      dirty = true;
      saveDraft();
      draw();
      msg(d.hingeAt === "end" ? "Hinge at end jamb" : "Hinge at start jamb");
      return;
    }
  }
  const map = { v: "select", w: "wall", s: "split", j: "join", x: "explode", c: "cut", o: "opening", d: "door", n: "window", b: "cabinet", l: "light", f: "fan", k: "socket", r: "room", m: "measure" };
  if (k === "x" && tool !== "explode") {
    // Quick explode of selected wall without switching tools when already selected
    const sel = selection.find((s) => s.kind === "wall");
    const wall = sel && doc.walls.find((x) => x.id === sel.id);
    if (wall && wallPoints(wall).length >= 3) {
      e.preventDefault();
      explodeWall(wall);
      return;
    }
  }
  if (map[k]) setTool(map[k]);
});
document.addEventListener("keyup", (e) => {
  if (e.key === "Shift") { shiftDown = false; syncStatus(); }
  if (e.code === "Space") { spaceDown = false; syncStatus(); }
});

toolsEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-tool]");
  if (b) setTool(b.dataset.tool);
});

document.getElementById("app").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-menu-toggle]");
  if (toggle) {
    e.preventDefault();
    e.stopPropagation();
    const id = toggle.dataset.menuToggle;
    document.querySelectorAll(".menu.open").forEach((m) => {
      if (m.dataset.menu !== id) {
        m.classList.remove("open");
        m.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
      }
    });
    const menu = toggle.closest(".menu");
    if (menu) {
      const open = !menu.classList.contains("open");
      menu.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    }
    return;
  }
  if (!e.target.closest(".menu.open")) {
    document.querySelectorAll(".menu.open").forEach((m) => {
      m.classList.remove("open");
      m.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
    });
  }
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.closest(".menu-panel")) {
    const menu = btn.closest(".menu");
    menu?.classList.remove("open");
    menu?.querySelector("[data-menu-toggle]")?.setAttribute("aria-expanded", "false");
  }
  const act = btn.dataset.act;
  if (act === "toggle-tools") { togglePanel("tools"); return; }
  if (act === "toggle-sidebar") { togglePanel("sidebar"); return; }
  if (act === "save") saveShared();
  if (act === "export") exportJson();
  if (act === "import") fileImport.click();
  if (act === "undo") undo();
  if (act === "redo") redo();
  if (act === "reset") { resetSeed(); }
  if (act === "model-new") { createNewModel().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "model-dup") { duplicateModel().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "model-rename") { renameActiveModel().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "model-version") { saveVersionSnapshot().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "model-share") { publishShareLink().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "model-export-pack") { exportModelPack().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "openhab-toggle") { toggleOhSync().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "auth-login") { openAuthModal({ toast }).catch(() => {}); }
  if (act === "auth-logout") { Models.logout().then(() => toast("Signed out")).catch(() => {}); }
  if (act === "model-delete") { deleteActiveModel().catch((err) => { console.warn(err); toast(String(err.message || err), "err"); }); }
  if (act === "mode-cad") { operate = false; syncStatus(); draw(); }
  if (act === "mode-operate") { operate = true; tool = "select"; syncStatus(); draw(); msg("Operate: click doors/lights/fans"); }
  if (act === "snap-toggle") { snapOn = !snapOn; syncStatus(); msg(snapOn ? "Snap on" : "Snap off"); }
  if (act === "units-metric" || act === "units-imperial") {
    const next = act === "units-imperial" ? "imperial" : "metric";
    if ((doc.units || "metric") === next) return;
    pushHistory();
    doc.units = next;
    dirty = true;
    saveDraft();
    lastInspectorKey = "";
    syncStatus();
    draw();
    toast(next === "imperial" ? "Units: imperial (inches)" : "Units: metric (mm)");
    msg(next === "imperial" ? "Imperial" : "Metric");
    return;
  }
  if (act === "upload-image") fileImage.click();

  if (btn.dataset.layerAct === "add") {
    addLayerCad().catch(() => {});
    return;
  }

  const layerRow = btn.closest?.("[data-layer-id]") || e.target.closest?.("[data-layer-id]");
  if (btn.dataset.layerAct && layerRow) {
    const id = layerRow.dataset.layerId;
    const L = getLayer(id);
    if (!L) return;
    const lact = btn.dataset.layerAct;
    if (lact === "vis") { pushHistory(); L.visible = !L.visible; draw(); return; }
    if (lact === "lock") { L.locked = !L.locked; draw(); return; }
    if (lact === "activate") { activeLayerId = id; draw(); msg(`Active: ${L.name}`); return; }
    if (lact === "rename") { renameLayerCad(id).catch(() => {}); return; }
    if (lact === "delete") { deleteLayerCad(id).catch(() => {}); return; }
    if (lact === "up" || lact === "down") {
      pushHistory();
      const idx = doc.layers.findIndex((x) => x.id === id);
      // UI is reversed: up = later in array (drawn on top)
      const j = lact === "up" ? idx + 1 : idx - 1;
      if (j < 0 || j >= doc.layers.length) return;
      const tmp = doc.layers[idx];
      doc.layers[idx] = doc.layers[j];
      doc.layers[j] = tmp;
      draw();
      return;
    }
  }

  if (btn.dataset.toggle) {
    const kind = btn.dataset.toggle, id = btn.dataset.id;
    setSelected(kind, id);
    pushHistory();
    let obj = null;
    if (kind === "door") {
      obj = doc.doors.find((x) => x.id === id); if (obj) obj.open = !obj.open;
    }
    if (kind === "light") {
      obj = doc.lights.find((x) => x.id === id); if (obj) obj.on = !obj.on;
    }
    if (kind === "fan") {
      obj = doc.fans.find((x) => x.id === id); if (obj) obj.on = !obj.on;
    }
    if (kind === "cabinet") {
      obj = (doc.cabinets || []).find((x) => x.id === id);
      const def = obj ? furnitureDef(obj.type || "cabinet") : null;
      if (obj && def && (def.hasDoors || def.hasOpen) && obj.kind !== "drawer") obj.open = !obj.open;
    }
    if (kind === "window") {
      obj = (doc.windows || []).find((x) => x.id === id); if (obj && obj.style !== "fixed") obj.open = !obj.open;
    }
    if (obj) ensureOhClient().pushDevice(kind, obj);
    draw();
    return;
  }
  if (btn.dataset.pick) {
    setSelected(btn.dataset.pick, btn.dataset.id);
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.sel === "delete") deleteSelected();
  if (btn.dataset.sel === "group") { groupSelectionCad(); return; }
  if (btn.dataset.sel === "ungroup") { ungroupSelectionCad(); return; }
  if (btn.dataset.sel === "select-group") { selectGroupOfPrimary(); return; }
  if (btn.dataset.sel === "select-similar") { selectSimilarCad(); return; }
  if (btn.dataset.sel === "select-kind") { selectSameKindCad(); return; }
  if (btn.dataset.sel === "split-mid" && selected?.kind === "wall") {
    const w = doc.walls.find((x) => x.id === selected.id);
    if (w) splitWallAt(w, 0.5);
  }
  if (btn.dataset.sel === "explode-wall" && selected?.kind === "wall") {
    const w = doc.walls.find((x) => x.id === selected.id);
    if (w) explodeWall(w);
    return;
  }
  if (btn.dataset.sel === "pick-wall" && btn.dataset.wallId) {
    const w = doc.walls.find((x) => x.id === btn.dataset.wallId);
    if (w) {
      setSelected("wall", w.id);
      draw();
      msg(`Selected wall ${String(w.id).slice(-6)}`);
    }
    return;
  }
  if (btn.dataset.sel === "rot-m" && selected?.kind === "door") {
    pushHistory();
    const d = doc.doors.find((x) => x.id === selected.id);
    d.closedOffsetDeg = (d.closedOffsetDeg || 0) - 15;
    applyDoorFrame(d);
    lastInspectorKey = "";
    draw();
  }
  if (btn.dataset.sel === "rot-p" && selected?.kind === "door") {
    pushHistory();
    const d = doc.doors.find((x) => x.id === selected.id);
    d.closedOffsetDeg = (d.closedOffsetDeg || 0) + 15;
    applyDoorFrame(d);
    lastInspectorKey = "";
    draw();
  }
  if (btn.dataset.sel === "flip-open" && selected?.kind === "door") {
    pushHistory();
    const d = doc.doors.find((x) => x.id === selected.id);
    flipDoorSwing(d);
    placeDoor.openSide = d.openSide;
    lastInspectorKey = "";
    draw();
    msg(d.openSide >= 0 ? "Opens wall-left (L)" : "Opens wall-right (R)");
    return;
  }
  if (btn.dataset.sel === "flip-hinge" && selected?.kind === "door") {
    pushHistory();
    const d = doc.doors.find((x) => x.id === selected.id);
    flipDoorHinge(d);
    placeDoor.hingeAt = d.hingeAt;
    lastInspectorKey = "";
    draw();
    msg(d.hingeAt === "end" ? "Hinge at end jamb" : "Hinge at start jamb");
    return;
  }
  if (btn.dataset.sel === "hinge-start" && selected?.kind === "door") {
    pushHistory();
    const d = doc.doors.find((x) => x.id === selected.id);
    setDoorHinge(d, "start");
    placeDoor.hingeAt = "start";
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.sel === "hinge-end" && selected?.kind === "door") {
    pushHistory();
    const d = doc.doors.find((x) => x.id === selected.id);
    setDoorHinge(d, "end");
    placeDoor.hingeAt = "end";
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.sel === "open-side" && selected?.kind === "door") {
    pushHistory();
    const d = doc.doors.find((x) => x.id === selected.id);
    setDoorOpenSide(d, Number(btn.dataset.side));
    placeDoor.openSide = d.openSide;
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.placeDoor === "hinge") {
    placeDoor.hingeAt = btn.dataset.hinge === "end" ? "end" : "start";
    lastInspectorKey = "";
    if (placeHover) placeHover = computePlaceHover(cursorMm, "door");
    draw();
    return;
  }
  if (btn.dataset.placeDoor === "open") {
    placeDoor.openSide = Number(btn.dataset.side) >= 0 ? 1 : -1;
    lastInspectorKey = "";
    if (placeHover) placeHover = computePlaceHover(cursorMm, "door");
    draw();
    return;
  }
  if (btn.dataset.sel === "add-door" && selected?.kind === "opening") {
    const o = doc.openings.find((x) => x.id === selected.id);
    const w = doc.walls.find((x) => x.id === o.wallId);
    if (!o || !w) return;
    pushHistory();
    o.type = "door";
    o.sillMm = 0;
    o.heightMm = o.heightMm || defaultDoorHeight();
    const hinge = pointAt(w, Math.min(o.t0, o.t1));
    const closedDeg = (Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x) * 180) / Math.PI;
    const len = openingWidth(o);
    const d = normalizeDoor({
      id: uid("door"), openingId: o.id, hinge, len, widthMm: len,
      heightMm: o.heightMm, sillMm: 0, open: false,
      hingeAt: placeDoor.hingeAt === "end" ? "end" : "start",
      openSide: placeDoor.openSide >= 0 ? 1 : -1,
      openAngle: placeDoor.openAngle || 85, closedOffsetDeg: 0,
      style: placeDoor.style, label: "Door",
    });
    applyDoorFrame(d);
    doc.doors.push(d);
    setSelected("door", d.id);
    draw();
  }
  if (btn.dataset.sel === "add-window" && selected?.kind === "opening") {
    const o = doc.openings.find((x) => x.id === selected.id);
    if (!o) return;
    pushHistory();
    o.type = "window";
    o.sillMm = o.sillMm || placeWindow.sillMm;
    o.heightMm = o.heightMm || placeWindow.heightMm;
    if (!doc.windows) doc.windows = [];
    const win = normalizeWindow({
      id: uid("win"), openingId: o.id, wallId: o.wallId,
      style: placeWindow.style, widthMm: openingWidth(o) || placeWindow.widthMm,
      heightMm: o.heightMm, sillMm: o.sillMm, label: "Window",
    });
    doc.windows.push(win);
    setSelected("window", win.id);
    draw();
  }
  if (btn.dataset.sel === "fit-plan" && selected?.kind === "image") {
    pushHistory();
    const im = doc.images.find((x) => x.id === selected.id);
    const b = planBounds();
    if (im) { im.x = b.x; im.y = b.y; im.w = b.w; im.h = b.h; }
    draw();
    msg("Image fitted to plan");
  }
  if (btn.dataset.sel === "walls-from-room" && selected?.kind === "room") {
    const r = doc.rooms.find((x) => x.id === selected.id);
    if (r) wallsFromRoom(r);
  }

  if (btn.dataset.sel === "toggle-on" && (selected?.kind === "light" || selected?.kind === "fan")) {
    pushHistory();
    const arr = selected.kind === "light" ? doc.lights : doc.fans;
    const o = arr.find((x) => x.id === selected.id);
    if (o) {
      o.on = !o.on;
      ensureOhClient().pushDevice(selected.kind, o);
    }
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.sel === "toggle-cab-open" && selected?.kind === "cabinet") {
    pushHistory();
    const o = (doc.cabinets || []).find((x) => x.id === selected.id);
    const def = o ? furnitureDef(o.type || "cabinet") : null;
    if (o && (def.hasDoors || def.hasOpen)) {
      o.open = !o.open;
      ensureOhClient().pushDevice("cabinet", o);
    }
    lastInspectorKey = "";
    dirty = true;
    saveDraft();
    draw();
    return;
  }
  if (btn.dataset.sel === "toggle-win-open" && selected?.kind === "window") {
    pushHistory();
    const o = (doc.windows || []).find((x) => x.id === selected.id);
    if (o && o.style !== "fixed") {
      o.open = !o.open;
      ensureOhClient().pushDevice("window", o);
    }
    lastInspectorKey = "";
    dirty = true;
    saveDraft();
    draw();
    return;
  }
  if (btn.dataset.sel === "cab-rot-m" && selected?.kind === "cabinet") {
    pushHistory();
    const o = (doc.cabinets || []).find((x) => x.id === selected.id);
    if (o) {
      o.rotationDeg = (o.rotationDeg || 0) - 15;
      placeCabinet.rotationDeg = o.rotationDeg;
    }
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.sel === "cab-rot-p" && selected?.kind === "cabinet") {
    pushHistory();
    const o = (doc.cabinets || []).find((x) => x.id === selected.id);
    if (o) {
      o.rotationDeg = (o.rotationDeg || 0) + 15;
      placeCabinet.rotationDeg = o.rotationDeg;
    }
    lastInspectorKey = "";
    draw();
    return;
  }

  const kelvin = btn.dataset.kelvin;
  if (kelvin && selected?.kind === "light") {
    pushHistory();
    const o = doc.lights.find((x) => x.id === selected.id);
    if (o) {
      o.colorTempK = Number(kelvin);
      placeLight.colorTempK = o.colorTempK;
    }
    lastInspectorKey = "";
    draw();
    return;
  }
  const bladesBtn = btn.dataset.blades;
  if (bladesBtn && selected?.kind === "fan") {
    pushHistory();
    const o = doc.fans.find((x) => x.id === selected.id);
    if (o) {
      o.blades = Number(bladesBtn);
      placeFan.blades = o.blades;
    }
    lastInspectorKey = "";
    draw();
    return;
  }

  const preset = btn.dataset.preset;
  if (preset === "door" || preset === "window") {
    const w = Number(btn.dataset.w);
    if (!w) return;
    if (preset === "door") {
      placeDoor.widthMm = w;
      if (placeHover) placeHover = computePlaceHover(cursorMm, "door");
    } else {
      placeWindow.widthMm = w;
      if (placeHover) placeHover = computePlaceHover(cursorMm, "window");
    }
    lastInspectorKey = "";
    draw();
    return;
  }
  if (preset === "cabinet-doors") {
    const n = Math.max(1, Math.min(6, Number(btn.dataset.doors) || 2));
    placeCabinet.doors = n;
    if (placeCabinet.type === "cabinet" || placeCabinet.type === "kitchen_island") placeCabinet.widthMm = n * 450;
    lastInspectorKey = "";
    draw();
    return;
  }
  if (preset === "cabinet-drawers") {
    placeCabinet.drawers = Math.max(2, Math.min(5, Number(btn.dataset.drawers) || 3));
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.furnType) {
    applyFurniturePresetAsync(btn.dataset.furnType);
    return;
  }
  if (btn.dataset.furnCat) {
    selectFurnCategory(btn.dataset.furnCat);
    return;
  }
  if (btn.dataset.furnColor) {
    placeCabinet.colorHex = normalizeHexColor(btn.dataset.furnColor);
    lastInspectorKey = "";
    draw();
    return;
  }
  if (btn.dataset.selFurnColor && selected?.kind === "cabinet") {
    pushHistory();
    const o = (doc.cabinets || []).find((x) => x.id === selected.id);
    if (o) {
      o.colorHex = normalizeHexColor(btn.dataset.selFurnColor);
      placeCabinet.colorHex = o.colorHex;
    }
    lastInspectorKey = "";
    dirty = true;
    saveDraft();
    draw();
    return;
  }

  const presetSel = btn.dataset.presetSel;
  if (presetSel === "door" && selected?.kind === "door") {
    const d = doc.doors.find((x) => x.id === selected.id);
    const w = Number(btn.dataset.w);
    if (!d || !w) return;
    pushHistory();
    d.widthMm = w;
    d.len = w;
    placeDoor.widthMm = w;
    syncDoorToOpening(d);
    lastInspectorKey = "";
    draw();
    return;
  }
  if (presetSel === "window" && selected?.kind === "window") {
    const win = doc.windows.find((x) => x.id === selected.id);
    const w = Number(btn.dataset.w);
    if (!win || !w) return;
    pushHistory();
    win.widthMm = w;
    placeWindow.widthMm = w;
    syncWindowToOpening(win);
    lastInspectorKey = "";
    draw();
    return;
  }
  if (presetSel === "cabinet-doors" && selected?.kind === "cabinet") {
    const o = (doc.cabinets || []).find((x) => x.id === selected.id);
    const n = Math.max(1, Math.min(6, Number(btn.dataset.doors) || 2));
    if (!o) return;
    pushHistory();
    const prevDoors = o.doors || 2;
    o.doors = n;
    placeCabinet.doors = n;
    if (Math.abs(o.widthMm - prevDoors * 450) < 1) {
      o.widthMm = n * 450;
      placeCabinet.widthMm = o.widthMm;
    }
    lastInspectorKey = "";
    draw();
    return;
  }
  if (presetSel === "cabinet-drawers" && selected?.kind === "cabinet") {
    const o = (doc.cabinets || []).find((x) => x.id === selected.id);
    const n = Math.max(2, Math.min(5, Number(btn.dataset.drawers) || 3));
    if (!o) return;
    pushHistory();
    o.drawers = n;
    placeCabinet.drawers = n;
    lastInspectorKey = "";
    draw();
    return;
  }
});

layersEl.addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-layer-act]");
  if (!actEl || actEl.tagName === "INPUT") return;
  if (actEl.dataset.layerAct === "activate") {
    const row = actEl.closest("[data-layer-id]");
    const L = getLayer(row?.dataset.layerId);
    if (!L) return;
    activeLayerId = L.id;
    draw();
    msg(`Active: ${L.name}`);
  }
});
layersEl.addEventListener("dblclick", (e) => {
  const nameEl = e.target.closest("[data-layer-act=activate]");
  const row = nameEl?.closest("[data-layer-id]");
  if (!row) return;
  renameLayerCad(row.dataset.layerId).catch(() => {});
});
layersEl.addEventListener("pointerdown", (e) => {
  if (e.target.dataset?.layerAct === "opacity") pushHistory();
});
layersEl.addEventListener("input", (e) => {
  const input = e.target;
  if (input.dataset.layerAct !== "opacity") return;
  const row = input.closest("[data-layer-id]");
  const L = getLayer(row?.dataset.layerId);
  if (!L) return;
  L.opacity = clamp01(Number(input.value) / 100);
  dirty = true;
  const g = svg.querySelector(`g[data-layer="${L.id}"]`);
  if (g) g.setAttribute("opacity", String(L.opacity));
  input.title = `Layer opacity ${Math.round(L.opacity * 100)}%`;
});
layersEl.addEventListener("change", (e) => {
  if (e.target.dataset.layerAct !== "opacity") return;
  saveDraft();
  draw();
});

function applyProp(input, live) {
  if (input.dataset.doc === "flooring") {
    pushHistory();
    const id = input.value;
    if (FLOORING_STYLES.some((s) => s.id === id)) {
      doc.flooring = id;
      dirty = true;
      saveDraft();
      lastInspectorKey = "";
      toast(`Flooring: ${FLOORING_STYLES.find((s) => s.id === id)?.label || id}`);
    }
    return;
  }
  if (input.dataset.doc === "wallHeightMm") {
    pushHistory();
    const fromH = doc.wallHeightMm ?? REF_WALL_H;
    const toH = Math.max(1000, readLen(input, REF_WALL_H));
    applyDefaultWallHeight(doc, { fromHeight: fromH, toHeight: toH });
    // Keep placement tools in sync with new defaults when they still match the old presets
    if (nearPlace(placeDoor.heightMm, DOOR_HEIGHT_DEFAULT, fromH)) placeDoor.heightMm = defaultDoorHeight();
    if (nearPlace(placeWindow.heightMm, WINDOW_HEIGHT_DEFAULT, fromH)) placeWindow.heightMm = defaultWindowHeight();
    if (nearPlace(placeWindow.sillMm, WINDOW_SILL_DEFAULT, fromH)) placeWindow.sillMm = defaultWindowSill();
    dirty = true;
    saveDraft();
    lastInspectorKey = "";
    draw();
    toast(`Wall height ${fmtLen(doc.wallHeightMm)} · applied to defaults`);
    return;
  }
  if (input.dataset.doc === "wallThicknessMm") {
    pushHistory();
    const fromT = doc.wallThicknessMm ?? 120;
    const toT = Math.max(50, readLen(input, 120));
    applyDefaultWallThickness(doc, { fromThickness: fromT, toThickness: toT });
    dirty = true;
    saveDraft();
    lastInspectorKey = "";
    draw();
    toast(`Wall thickness ${fmtLen(doc.wallThicknessMm)} · applied to defaults`);
    return;
  }
  if (input.dataset.doc === "snapMm") {
    pushHistory();
    doc.snapMm = Math.max(1, readLen(input, 50));
    dirty = true;
    saveDraft();
    lastInspectorKey = "";
    syncStatus();
    toast(`Snap ${fmtLen(doc.snapMm)}`);
    return;
  }
  if (input.dataset.doc === "gridMm") {
    pushHistory();
    doc.gridMm = Math.max(1, readLen(input, 50));
    dirty = true;
    saveDraft();
    lastInspectorKey = "";
    draw();
    toast(`Grid ${fmtLen(doc.gridMm)}`);
    return;
  }
  if (!input.dataset.prop) return;

  // Placement defaults (Door / Win tools) — no selection required
  if (input.dataset.place === "door") {
    const prop = input.dataset.prop;
    if (prop === "style") placeDoor.style = input.value;
    if (prop === "widthMm") placeDoor.widthMm = Math.max(200, readLen(input, placeDoor.widthMm));
    if (prop === "heightMm") placeDoor.heightMm = Math.max(100, readLen(input, placeDoor.heightMm));
    if (prop === "sillMm") placeDoor.sillMm = Math.max(0, readLen(input, 0));
    lastInspectorKey = "";
    if (placeHover) placeHover = computePlaceHover(cursorMm, "door");
    draw();
    return;
  }
  if (input.dataset.place === "window") {
    const prop = input.dataset.prop;
    if (prop === "style") placeWindow.style = input.value;
    if (prop === "widthMm") placeWindow.widthMm = Math.max(200, readLen(input, placeWindow.widthMm));
    if (prop === "heightMm") placeWindow.heightMm = Math.max(100, readLen(input, placeWindow.heightMm));
    if (prop === "sillMm") placeWindow.sillMm = Math.max(0, readLen(input, 0));
    lastInspectorKey = "";
    if (placeHover) placeHover = computePlaceHover(cursorMm, "window");
    draw();
    return;
  }
  if (input.dataset.place === "light") {
    const prop = input.dataset.prop;
    if (prop === "shape") placeLight.shape = input.value;
    if (prop === "colorTempK") placeLight.colorTempK = Math.max(2200, Math.min(6500, Number(input.value) || 3000));
    if (prop === "intensity") placeLight.intensity = Math.max(0, Math.min(2, Number(input.value) || 0));
    if (prop === "lengthMm") placeLight.lengthMm = Math.max(300, readLen(input, 1200));
    lastInspectorKey = "";
    draw();
    return;
  }
  if (input.dataset.place === "fan") {
    const prop = input.dataset.prop;
    if (prop === "blades") placeFan.blades = Math.max(2, Math.min(6, Number(input.value) || 3));
    if (prop === "diameterMm") placeFan.diameterMm = Math.max(600, readLen(input, 1200));
    if (prop === "hangMm") placeFan.hangMm = Math.max(80, Math.min(1200, readLen(input, 320)));
    if (prop === "speed") placeFan.speed = Math.max(0, Math.min(3, Number(input.value) || 0));
    lastInspectorKey = "";
    draw();
    return;
  }
  if (input.dataset.place === "socket") {
    const prop = input.dataset.prop;
    if (prop === "style") placeSocket.style = input.value;
    lastInspectorKey = "";
    draw();
    return;
  }
  if (input.dataset.place === "cabinet") {
    const prop = input.dataset.prop;
    if (prop === "kind") {
      placeCabinet.kind = input.value;
      const def = CABINET_KINDS.find((k) => k.id === placeCabinet.kind);
      if (def) placeCabinet.heightMm = def.heightMm;
      if (placeCabinet.kind === "wall") placeCabinet.depthMm = 350;
      else if (placeCabinet.depthMm < 500) placeCabinet.depthMm = 600;
    }
    if (prop === "curtainStyle") placeCabinet.curtainStyle = input.value;
    if (prop === "foldMode") placeCabinet.foldMode = input.value;
    if (prop === "colorHex") placeCabinet.colorHex = normalizeHexColor(input.value);
    if (prop === "doors") {
      placeCabinet.doors = Math.max(1, Math.min(6, Number(input.value) || 2));
      if (placeCabinet.type === "cabinet") placeCabinet.widthMm = placeCabinet.doors * 450;
    }
    if (prop === "widthMm") placeCabinet.widthMm = Math.max(200, readLen(input, placeCabinet.widthMm));
    if (prop === "depthMm") {
      const minD = furnitureDef(placeCabinet.type).isCurtain || placeCabinet.type === "mirror" ? 40 : 150;
      placeCabinet.depthMm = Math.max(minD, readLen(input, placeCabinet.depthMm));
    }
    if (prop === "heightMm") placeCabinet.heightMm = Math.max(20, readLen(input, placeCabinet.heightMm));
    if (prop === "rotationDeg") placeCabinet.rotationDeg = Number(input.value) || 0;
    lastInspectorKey = "";
    draw();
    return;
  }

  if (!selected) return;
  const prop = input.dataset.prop;
  if (!live) pushHistory();
  if (selected.kind === "image") {
    const im = doc.images.find((x) => x.id === selected.id);
    if (!im) return;
    if (prop === "opacity") {
      im.opacity = clamp01(Number(input.value) / 100);
      const span = document.getElementById("opVal");
      if (span) span.textContent = `${Math.round(im.opacity * 100)}%`;
      if (live) {
        const node = svg.querySelector(`image[data-id="${im.id}"]`);
        if (node) node.setAttribute("opacity", String(im.opacity));
        dirty = true;
        return;
      }
    }
    if (prop === "w") im.w = Math.max(200, readLen(input, im.w));
    if (prop === "h") im.h = Math.max(200, readLen(input, im.h));
    if (prop === "x") im.x = readLen(input, 0);
    if (prop === "y") im.y = readLen(input, 0);
  }
  if (selected.kind === "wall" && prop === "lengthMm") {
    const w = doc.walls.find((x) => x.id === selected.id);
    if (w) {
      setWallLength(w, readLen(input, wallLen(w)));
      lastInspectorKey = "";
    }
  }
  if (selected.kind === "wall" && prop === "thickness") {
    const w = doc.walls.find((x) => x.id === selected.id);
    if (w) w.thickness = Math.max(50, readLen(input, 120));
  }
  if (selected.kind === "wall" && prop === "elevMm") {
    const w = doc.walls.find((x) => x.id === selected.id);
    if (w) {
      w.elevMm = Math.max(0, readLen(input, 0));
      lastInspectorKey = "";
    }
  }
  if (selected.kind === "wall" && prop === "height") {
    const w = doc.walls.find((x) => x.id === selected.id);
    if (w) {
      w.height = Math.max(1000, readLen(input, defaultWallHeight()));
      lastInspectorKey = "";
    }
  }
  if (selected.kind === "opening" && prop === "openWidth") {
    const o = doc.openings.find((x) => x.id === selected.id);
    if (o) setOpeningWidth(o, readLen(input, OPENING_DEFAULT));
  }
  if (selected.kind === "opening" && (prop === "heightMm" || prop === "sillMm" || prop === "type")) {
    const o = doc.openings.find((x) => x.id === selected.id);
    if (!o) return;
    if (prop === "type") o.type = input.value;
    if (prop === "heightMm") o.heightMm = Math.max(100, readLen(input, 100));
    if (prop === "sillMm") o.sillMm = Math.max(0, readLen(input, 0));
  }
  if (selected.kind === "door") {
    const d = doc.doors.find((x) => x.id === selected.id);
    if (!d) return;
    if (prop === "label") d.label = input.value;
    if (prop === "style") { d.style = input.value; placeDoor.style = input.value; }
    if (prop === "widthMm" || prop === "len") {
      d.widthMm = Math.max(200, readLen(input, d.widthMm));
      d.len = d.widthMm;
      placeDoor.widthMm = d.widthMm;
      syncDoorToOpening(d);
    }
    if (prop === "heightMm") {
      d.heightMm = Math.max(100, readLen(input, DOOR_HEIGHT_DEFAULT));
      placeDoor.heightMm = d.heightMm;
      syncDoorToOpening(d);
    }
    if (prop === "sillMm") {
      d.sillMm = Math.max(0, readLen(input, 0));
      placeDoor.sillMm = d.sillMm;
      syncDoorToOpening(d);
    }
    if (prop === "closedOffsetDeg") {
      d.closedOffsetDeg = Number(input.value) || 0;
      applyDoorFrame(d);
    }
    if (prop === "openAngle") {
      d.openAngle = Math.max(30, Math.min(180, Number(input.value) || 85));
      applyDoorFrame(d);
    }
    if (prop === "closedDeg") d.closedDeg = Number(input.value) || 0;
  }
  if (selected.kind === "window") {
    const win = doc.windows.find((x) => x.id === selected.id);
    if (!win) return;
    if (prop === "label") win.label = input.value;
    if (prop === "style") { win.style = input.value; placeWindow.style = input.value; }
    if (prop === "widthMm") {
      win.widthMm = Math.max(200, readLen(input, win.widthMm));
      placeWindow.widthMm = win.widthMm;
      syncWindowToOpening(win);
    }
    if (prop === "heightMm") {
      win.heightMm = Math.max(100, readLen(input, win.heightMm));
      placeWindow.heightMm = win.heightMm;
      syncWindowToOpening(win);
    }
    if (prop === "sillMm") {
      win.sillMm = Math.max(0, readLen(input, 0));
      placeWindow.sillMm = win.sillMm;
      syncWindowToOpening(win);
    }
  }
  if (selected.kind === "light") {
    const o = doc.lights.find((x) => x.id === selected.id);
    if (!o) return;
    if (prop === "label") o.label = input.value;
    if (prop === "shape") { o.shape = input.value; placeLight.shape = input.value; lastInspectorKey = ""; }
    if (prop === "colorTempK") { o.colorTempK = Math.max(2200, Math.min(6500, Number(input.value) || 3000)); placeLight.colorTempK = o.colorTempK; }
    if (prop === "intensity") { o.intensity = Math.max(0, Math.min(2, Number(input.value) || 0)); placeLight.intensity = o.intensity; }
    if (prop === "rotationDeg") { o.rotationDeg = Number(input.value) || 0; placeLight.rotationDeg = o.rotationDeg; }
    if (prop === "lengthMm") { o.lengthMm = Math.max(300, readLen(input, 1200)); placeLight.lengthMm = o.lengthMm; }
  }
  if (selected.kind === "fan") {
    const o = doc.fans.find((x) => x.id === selected.id);
    if (!o) return;
    if (prop === "label") o.label = input.value;
    if (prop === "blades") { o.blades = Math.max(2, Math.min(6, Number(input.value) || 3)); placeFan.blades = o.blades; }
    if (prop === "diameterMm") { o.diameterMm = Math.max(600, readLen(input, 1200)); placeFan.diameterMm = o.diameterMm; }
    if (prop === "hangMm") { o.hangMm = Math.max(80, Math.min(1200, readLen(input, 320))); placeFan.hangMm = o.hangMm; lastInspectorKey = ""; }
    if (prop === "speed") { o.speed = Math.max(0, Math.min(3, Number(input.value) || 0)); placeFan.speed = o.speed; }
    if (prop === "rotationDeg") { o.rotationDeg = Number(input.value) || 0; placeFan.rotationDeg = o.rotationDeg; }
  }
  if (selected.kind === "socket") {
    const o = (doc.sockets || []).find((x) => x.id === selected.id);
    if (!o) return;
    if (prop === "label") o.label = input.value;
    if (prop === "style") {
      const prev = o.style;
      o.style = input.value;
      placeSocket.style = input.value;
      // Retarget mount height when switching style if still on previous default
      if (near(o.elevMm, defaultSocketElev(prev))) o.elevMm = defaultSocketElev(o.style);
      lastInspectorKey = "";
    }
    if (prop === "elevMm") o.elevMm = Math.max(0, readLen(input, defaultSocketElev(o.style)));
    if (prop === "rotationDeg") { o.rotationDeg = Number(input.value) || 0; placeSocket.rotationDeg = o.rotationDeg; }
  }
  if (selected.kind === "cabinet") {
    const o = (doc.cabinets || []).find((x) => x.id === selected.id);
    if (!o) return;
    if (prop === "label") o.label = input.value;
    if (prop === "type") {
      const def = furnitureDef(input.value);
      o.type = def.id;
      o.label = def.label;
      o.widthMm = def.widthMm;
      o.depthMm = def.depthMm;
      o.heightMm = def.heightMm;
      o.doors = def.hasDoors ? (def.doors || 2) : 0;
      o.open = false;
      o.colorHex = normalizeHexColor(def.color);
      o.curtainStyle = def.isCurtain ? (def.curtainStyle || o.curtainStyle || "cloth") : undefined;
      o.foldMode = def.isCurtain ? (o.foldMode || placeCabinet.foldMode || "both") : undefined;
      if (def.isCabinet || def.id === "cabinet" || def.id === "kitchen_island") {
        o.kind = def.id === "kitchen_island" ? "base" : (o.kind || "base");
        o.drawers = o.drawers || 3;
      } else {
        o.kind = undefined;
        o.drawers = undefined;
      }
      applyFurniturePreset(def.id);
      lastInspectorKey = "";
    }
    if (prop === "curtainStyle") {
      o.curtainStyle = input.value;
      placeCabinet.curtainStyle = o.curtainStyle;
      lastInspectorKey = "";
    }
    if (prop === "foldMode") {
      o.foldMode = input.value;
      placeCabinet.foldMode = o.foldMode;
      lastInspectorKey = "";
    }
    if (prop === "colorHex") {
      o.colorHex = normalizeHexColor(input.value);
      placeCabinet.colorHex = o.colorHex;
    }
    if (prop === "kind") {
      o.kind = input.value;
      placeCabinet.kind = o.kind;
      const def = CABINET_KINDS.find((k) => k.id === o.kind);
      if (def) {
        o.heightMm = def.heightMm;
        placeCabinet.heightMm = def.heightMm;
      }
      if (o.kind === "wall") { o.depthMm = 350; placeCabinet.depthMm = 350; }
      else if (o.depthMm < 500) { o.depthMm = 600; placeCabinet.depthMm = 600; }
      lastInspectorKey = "";
    }
    if (prop === "doors") {
      o.doors = Math.max(1, Math.min(6, Number(input.value) || 2));
      placeCabinet.doors = o.doors;
    }
    if (prop === "widthMm") { o.widthMm = Math.max(200, readLen(input, o.widthMm)); placeCabinet.widthMm = o.widthMm; }
    if (prop === "depthMm") {
      const minD = furnitureDef(o.type || "cabinet").isCurtain || o.type === "mirror" ? 40 : 150;
      o.depthMm = Math.max(minD, readLen(input, o.depthMm));
      placeCabinet.depthMm = o.depthMm;
    }
    if (prop === "heightMm") { o.heightMm = Math.max(20, readLen(input, o.heightMm)); placeCabinet.heightMm = o.heightMm; }
    if (prop === "rotationDeg") { o.rotationDeg = Number(input.value) || 0; placeCabinet.rotationDeg = o.rotationDeg; }
  }
  if (selected.kind === "room" && prop === "label") {
    const r = doc.rooms.find((x) => x.id === selected.id);
    if (r) r.label = input.value;
  }
  if (live) {
    if (selected.kind === "door") {
      const d = doc.doors.find((x) => x.id === selected.id);
      if (d) refreshInspectorSizeFields("door", d);
    }
    if (selected.kind === "window") {
      const win = doc.windows.find((x) => x.id === selected.id);
      if (win) refreshInspectorSizeFields("window", win);
    }
    dirty = true;
    draw();
    return;
  }
  lastInspectorKey = "";
  draw();
}

inspector.addEventListener("input", (e) => {
  if (e.target.matches?.("[data-furn-search]") || e.target.dataset.furnSearch != null) {
    furnUi.search = e.target.value || "";
    lastInspectorKey = "";
    renderInspector();
    return;
  }
  if (e.target.dataset.live) applyProp(e.target, true);
});
inspector.addEventListener("change", (e) => {
  if (e.target.dataset.sel === "move-layer") {
    moveSelectionToLayer(e.target.value);
    return;
  }
  applyProp(e.target, false);
});

ctxMenu?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-ctx]");
  if (!btn || btn.disabled) return;
  runCtxAction(btn.dataset.ctx);
});
document.addEventListener("pointerdown", (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) hideCtxMenu();
}, true);
window.addEventListener("blur", hideCtxMenu);
window.addEventListener("resize", hideCtxMenu);
wrap?.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  if (!doc) return;
  const target = ev.target.closest?.("[data-kind]");
  let hit = null;
  if (target?.dataset.kind && target.dataset.id) {
    hit = { kind: target.dataset.kind, id: target.dataset.id };
  } else {
    const p = snapPoint(clientToMm(ev.clientX, ev.clientY));
    const door = hitDoor(p);
    if (door) hit = { kind: "door", id: door.id };
    else {
      const cab = hitCabinet(p);
      if (cab) hit = { kind: "cabinet", id: cab.id };
      else {
        const light = hitLight(p);
        if (light) hit = { kind: "light", id: light.id };
        else {
          const hw = hitWall(p);
          if (hw) hit = { kind: "wall", id: hw.wall.id };
          else {
            const room = hitRoom(p);
            if (room) hit = { kind: "room", id: room.id };
          }
        }
      }
    }
  }
  showCtxMenu(ev.clientX, ev.clientY, hit);
});

fileImport.addEventListener("change", async () => {
  const file = fileImport.files?.[0];
  if (!file) return;
  try {
    pushHistory();
    doc = normalize(JSON.parse(await file.text()));
    clearSelection();
    dirty = true;
    saveDraft();
    setBanner("Imported JSON — Save shared to publish to layout.json");
    msg("Imported");
    draw();
  } catch {
    msg("Import failed");
  }
  fileImport.value = "";
});

async function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

fileImage.addEventListener("change", async () => {
  const file = fileImage.files?.[0];
  if (!file) return;
  try {
    const dataUrl = await readFileAsDataURL(file);
    let src = dataUrl;
    try {
      const r = await fetch("/api/asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, dataUrl }),
      });
      if (r.ok) {
        const j = await r.json();
        src = j.url;
      }
    } catch { /* keep data URL */ }

    // natural size → plan mm (assume ~1px ≈ 10mm as starting scale, then fit)
    const dims = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 1000, h: 1000 });
      img.src = dataUrl;
    });
    const b = planBounds();
    const scale = Math.min(b.w / dims.w, b.h / dims.h) * (dims.w > 10 ? 1 : 10);
    const wMm = Math.max(1000, dims.w * Math.max(scale, 8));
    const hMm = Math.max(1000, dims.h * Math.max(scale, 8));
    // fit into plan bounds
    const fit = Math.min(b.w / wMm, b.h / hMm, 1);
    pushHistory();
    const im = {
      id: uid("img"),
      layerId: activeLayerOrFirst(),
      name: file.name,
      src,
      x: b.x,
      y: b.y,
      w: wMm * fit,
      h: hMm * fit,
      opacity: 0.45,
    };
    doc.images.push(im);
    activeLayerId = "ly_ref";
    const ref = getLayer("ly_ref");
    if (ref) { ref.visible = true; ref.opacity = 1; }
    setSelected("image", im.id);
    dirty = true;
    saveDraft();
    draw();
    msg("Trace image added — set opacity and draw walls on Walls layer");
  } catch (err) {
    console.warn(err);
    msg("Image upload failed");
  }
  fileImage.value = "";
});

/* ---------- boot ---------- */
buildTools();
restorePanelCollapse();
liveSync = createLiveSync({
  modelId: Models.getActiveModelId(),
  onRemote(remoteDoc, meta) {
    if (!remoteDoc || meta?.source === "cad") return;
    if (dirty) return;
    try {
      doc = normalize(remoteDoc);
      clearSelection();
      draw();
      msg("Synced from 3D");
    } catch (err) {
      console.warn(err);
    }
  },
});
try {
  await loadShared();
  liveSync?.setModelId(activeModel?.id || Models.getActiveModelId());
  draw();
  msg(dirty ? "Loaded draft" : `Loaded ${activeModel?.name || "model"}`);
  const emptyPlan = !(doc?.walls?.length) && !(doc?.rooms?.length) && !(doc?.images?.length);
  if (emptyPlan && !dirty) {
    setBanner("Import a plan image → draw walls → Publish a share link for clients.");
  }
} catch (err) {
  console.warn(err);
  if (!doc) {
    doc = normalize({
      version: 2, walls: [], rooms: [], doors: [], windows: [],
      lights: [], fans: [], sockets: [], cabinets: [], images: [], openings: [], layers: [],
    });
  }
  draw();
  toast(String(err.message || err), "err");
  msg("Loaded offline fallback");
}
ensureOhClient();
syncOhMenuLabel();
document.getElementById("modelSelect")?.addEventListener("change", (e) => {
  switchToModel(e.target.value).catch((err) => { console.warn(err); toast(String(err.message || err), "err"); });
});
document.getElementById("versionSelect")?.addEventListener("change", () => {
  // selecting a version does not auto-restore; Reset / confirm restores
  msg(document.getElementById("versionSelect").value ? "Version selected — click Reset to restore" : "Working copy");
});
document.getElementById("modelUser")?.addEventListener("change", async (e) => {
  Models.setUser(e.target.value || "local");
  await refreshModelsList();
  toast(`User: ${Models.getUser()}`);
});

document.getElementById("openPreview3d")?.addEventListener("click", (e) => {
  saveDraft();
  if (dirty) toast("Opening 3D with current draft — Save to publish");
  const id = activeModel?.id || Models.getActiveModelId();
  if (id) {
    e.preventDefault();
    const href = `./preview3d.html?model=${encodeURIComponent(id)}`;
    window.open(href, "_blank", "noopener");
  }
});
