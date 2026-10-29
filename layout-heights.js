/** Apply document default wall height to walls and related elevations. */

export const REF_WALL_H = 2600;

export const HEIGHT_PRESETS = {
  door: 2100,
  window: 1200,
  windowSill: 900,
  clerestorySill: 1600,
  clerestoryH: 400,
  socket: 300,
  socketFloor: 25,
  panelBoard: 1200,
  lightBelowCeiling: 0.1, // fraction of wall height below ceiling
};

export function near(a, b, tol = 8) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

export function scaleH(value, fromH, toH) {
  const f = Number(fromH) || REF_WALL_H;
  const t = Number(toH) || REF_WALL_H;
  if (!f || f === t) return Math.round(Number(value) || 0);
  return Math.round((Number(value) || 0) * (t / f));
}

function matchesScaled(value, preset, fromH) {
  if (value == null) return true;
  return near(value, preset) || near(value, scaleH(preset, REF_WALL_H, fromH));
}

/**
 * Apply default wall height to existing walls / openings / devices.
 * @param {object} n document
 * @param {{ fromHeight?: number, toHeight?: number, forceWalls?: boolean }} opts
 */
export function applyDefaultWallHeight(n, opts = {}) {
  if (!n) return n;
  const toH = Math.max(1000, Number(opts.toHeight ?? n.wallHeightMm) || REF_WALL_H);
  const fromH = Math.max(1000, Number(opts.fromHeight ?? REF_WALL_H) || REF_WALL_H);
  n.wallHeightMm = toH;

  for (const w of n.walls || []) {
    if (
      opts.forceWalls
      || w.height == null
      || near(w.height, fromH)
      || near(w.height, REF_WALL_H)
    ) {
      w.height = toH;
    }
    if (w.elevMm == null) w.elevMm = 0;
  }

  const doorTo = scaleH(HEIGHT_PRESETS.door, REF_WALL_H, toH);
  for (const d of n.doors || []) {
    if (matchesScaled(d.heightMm, HEIGHT_PRESETS.door, fromH)) d.heightMm = doorTo;
    if (d.sillMm == null) d.sillMm = 0;
  }

  const winH = scaleH(HEIGHT_PRESETS.window, REF_WALL_H, toH);
  const winSill = scaleH(HEIGHT_PRESETS.windowSill, REF_WALL_H, toH);
  const clerH = scaleH(HEIGHT_PRESETS.clerestoryH, REF_WALL_H, toH);
  const clerSill = scaleH(HEIGHT_PRESETS.clerestorySill, REF_WALL_H, toH);
  for (const w of n.windows || []) {
    const isCler =
      matchesScaled(w.sillMm, HEIGHT_PRESETS.clerestorySill, fromH)
      || matchesScaled(w.heightMm, HEIGHT_PRESETS.clerestoryH, fromH);
    if (isCler) {
      if (matchesScaled(w.heightMm, HEIGHT_PRESETS.clerestoryH, fromH) || w.heightMm == null) w.heightMm = clerH;
      if (matchesScaled(w.sillMm, HEIGHT_PRESETS.clerestorySill, fromH) || w.sillMm == null) w.sillMm = clerSill;
    } else {
      if (matchesScaled(w.heightMm, HEIGHT_PRESETS.window, fromH) || w.heightMm == null) w.heightMm = winH;
      if (matchesScaled(w.sillMm, HEIGHT_PRESETS.windowSill, fromH) || w.sillMm == null) w.sillMm = winSill;
    }
    // Keep head below ceiling
    const head = (w.sillMm || 0) + (w.heightMm || 0);
    if (head > toH - 40) {
      w.heightMm = Math.max(200, toH - 40 - (w.sillMm || 0));
    }
  }

  for (const o of n.openings || []) {
    if (o.type === "door" || o.type === "passage") {
      if (matchesScaled(o.heightMm, HEIGHT_PRESETS.door, fromH) || o.heightMm == null) o.heightMm = doorTo;
      if (o.sillMm == null) o.sillMm = 0;
    } else if (o.type === "window") {
      const isCler =
        matchesScaled(o.sillMm, HEIGHT_PRESETS.clerestorySill, fromH)
        || matchesScaled(o.heightMm, HEIGHT_PRESETS.clerestoryH, fromH);
      if (isCler) {
        if (matchesScaled(o.heightMm, HEIGHT_PRESETS.clerestoryH, fromH) || o.heightMm == null) o.heightMm = clerH;
        if (matchesScaled(o.sillMm, HEIGHT_PRESETS.clerestorySill, fromH) || o.sillMm == null) o.sillMm = clerSill;
      } else {
        if (matchesScaled(o.heightMm, HEIGHT_PRESETS.window, fromH) || o.heightMm == null) o.heightMm = winH;
        if (matchesScaled(o.sillMm, HEIGHT_PRESETS.windowSill, fromH) || o.sillMm == null) o.sillMm = winSill;
      }
    }
  }

  // Lights / fans sit relative to ceiling — store mount fraction for 3D
  for (const l of n.lights || []) {
    if (l.mountFrac == null) l.mountFrac = 1 - HEIGHT_PRESETS.lightBelowCeiling;
    if (l.elevMm == null) l.elevMm = 0;
  }
  for (const f of n.fans || []) {
    if (f.hangMm == null) f.hangMm = 320;
    // keep hang; ceiling rises with wall height automatically in 3D
  }

  // Power outlets & boards — fixed AFF heights (not ceiling-scaled)
  const floorH = HEIGHT_PRESETS.socketFloor;
  const sockH = HEIGHT_PRESETS.socket;
  const panelH = HEIGHT_PRESETS.panelBoard;
  for (const s of n.sockets || []) {
    const style = s.style || "single";
    if (style === "floor") {
      if (s.elevMm == null || near(s.elevMm, floorH) || near(s.elevMm, 200)) s.elevMm = floorH;
    } else if (style === "panel" || style === "board" || /board|panel|db|mccb/i.test(s.label || "")) {
      if (s.elevMm == null || near(s.elevMm, panelH) || near(s.elevMm, scaleH(panelH, REF_WALL_H, fromH))) {
        s.elevMm = panelH;
      }
    } else {
      if (s.elevMm == null || near(s.elevMm, sockH) || near(s.elevMm, 200) || near(s.elevMm, scaleH(sockH, REF_WALL_H, fromH))) {
        s.elevMm = sockH;
      }
    }
  }

  // Wall cabinets / hoods that used fixed elevations keyed to 2600
  for (const c of n.cabinets || []) {
    if ((c.kind === "wall" || c.type === "range_hood") && c.elevMm == null) {
      // leave mesh logic to derive from wall height; optional elev offset stays 0
      c.elevMm = c.elevMm ?? 0;
    }
  }

  return n;
}

/** If layout default height differs from legacy 2600 walls, sync them. */
export function syncLegacyWallHeights(n) {
  if (!n) return n;
  const toH = n.wallHeightMm ?? REF_WALL_H;
  const walls = n.walls || [];
  if (!walls.length) return n;
  const legacyCount = walls.filter((w) => w.height == null || near(w.height, REF_WALL_H)).length;
  if (toH !== REF_WALL_H && legacyCount >= Math.max(1, Math.ceil(walls.length * 0.4))) {
    applyDefaultWallHeight(n, { fromHeight: REF_WALL_H, toHeight: toH });
  } else {
    // still fill missing socket elevations / light mount
    applyDefaultWallHeight(n, { fromHeight: toH, toHeight: toH });
  }
  return n;
}

export function ceilingMm(doc, wall) {
  const h = wall?.height != null ? Number(wall.height) : Number(doc?.wallHeightMm);
  if (Number.isFinite(h) && h > 0) return h;
  return REF_WALL_H;
}

export const REF_WALL_TH = 120;

/**
 * Apply default wall thickness to walls that still use the previous default.
 * @param {object} n document
 * @param {{ fromThickness?: number, toThickness?: number, forceWalls?: boolean }} opts
 */
export function applyDefaultWallThickness(n, opts = {}) {
  if (!n) return n;
  const toT = Math.max(50, Number(opts.toThickness ?? n.wallThicknessMm) || REF_WALL_TH);
  const fromT = Math.max(50, Number(opts.fromThickness ?? REF_WALL_TH) || REF_WALL_TH);
  n.wallThicknessMm = toT;

  for (const w of n.walls || []) {
    if (
      opts.forceWalls
      || w.thickness == null
      || near(w.thickness, fromT)
      || near(w.thickness, REF_WALL_TH)
    ) {
      w.thickness = toT;
    }
  }
  return n;
}
