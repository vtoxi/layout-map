/**
 * Plan-space physics: solid walls, room containment, path blocking, object overlap.
 * Used by CAD + 3D preview so both agree.
 */

export function pointInPoly(p, pts) {
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

export function distPointSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function projectPointSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy, t, dist: Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) };
}

export function segIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cross(a, b, c), d2 = cross(a, b, d);
  const d3 = cross(c, d, a), d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

/** True if segment ab comes within `clear` of segment cd (thick walls). */
export function segNearSeg(a, b, c, d, clear) {
  if (segIntersect(a, b, c, d)) return true;
  if (distPointSeg(a, c, d) < clear) return true;
  if (distPointSeg(b, c, d) < clear) return true;
  if (distPointSeg(c, a, b) < clear) return true;
  if (distPointSeg(d, a, b) < clear) return true;
  // Sample midpoints for long moves
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (distPointSeg(p, c, d) < clear) return true;
  }
  return false;
}

export function footprintCorners(x, y, wMm, dMm, rotDeg) {
  const rad = ((rotDeg || 0) * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const hw = (wMm || 400) / 2, hd = (dMm || 400) / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, ly]) => ({
    x: x + lx * c - ly * s,
    y: y + lx * s + ly * c,
  }));
}

export function isWallMounted(kind, obj) {
  if (kind === "socket") return true;
  if (kind !== "cabinet" || !obj) return false;
  const t = obj.type;
  return obj.kind === "wall"
    || t === "mirror" || t === "tv" || t === "wall_art"
    || t === "curtain" || t === "blinds" || t === "sheer"
    || (typeof t === "string" && /curtain|blind|shade|drape/i.test(t));
}

export function objectFootprint(kind, obj) {
  if (kind === "cabinet") {
    return {
      w: obj.widthMm || 800,
      d: obj.depthMm || 600,
      rot: obj.rotationDeg || 0,
      pad: isWallMounted(kind, obj) ? 8 : 35,
    };
  }
  if (kind === "fan") {
    const dia = obj.diameterMm || 1200;
    return { w: dia, d: dia, rot: 0, pad: 40 };
  }
  if (kind === "light") {
    const w = obj.shape === "tube" || obj.shape === "panel" ? (obj.lengthMm || 1200) : 280;
    const d = obj.shape === "tube" ? 120 : (obj.shape === "panel" ? Math.min(600, w) : 280);
    return { w, d, rot: obj.rotationDeg || 0, pad: 25 };
  }
  if (kind === "socket") return { w: 120, d: 80, rot: obj.rotationDeg || 0, pad: 5 };
  return { w: 400, d: 400, rot: 0, pad: 40 };
}

export function roomPointsFrom(r) {
  if (!r) return [];
  if (Array.isArray(r.points) && r.points.length >= 3) {
    return r.points.map((p) => ({ x: p.x, y: p.y }));
  }
  const x = r.x ?? 0, y = r.y ?? 0, w = r.w ?? 1000, h = r.h ?? 1000;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function findRoomAt(doc, p) {
  const rooms = doc?.rooms || [];
  for (const r of rooms) {
    const pts = roomPointsFrom(r);
    if (pts.length >= 3 && pointInPoly(p, pts)) return r;
  }
  return null;
}

function wallHalf(wall, doc) {
  return (wall.thickness ?? doc?.wallThicknessMm ?? 120) / 2;
}


/** Polyline wall centerline points (points[] or legacy a/b). */
export function wallPoints(w) {
  if (!w) return [];
  if (Array.isArray(w.points) && w.points.length >= 2) {
    return w.points.map((p) => ({ x: Number(p.x) || 0, y: Number(p.y) || 0 }));
  }
  if (w.a && w.b) return [{ x: w.a.x, y: w.a.y }, { x: w.b.x, y: w.b.y }];
  return [];
}

/** Edge list along a wall polyline (includes closing edge when wall.closed). */
export function wallSegments(w) {
  const pts = wallPoints(w);
  const edges = [];
  for (let i = 0; i < pts.length - 1; i++) {
    edges.push({ a: pts[i], b: pts[i + 1] });
  }
  if (w?.closed && pts.length >= 3) {
    edges.push({ a: pts[pts.length - 1], b: pts[0] });
  }
  return edges;
}

function wallLenMm(w) {
  let L = 0;
  for (const e of wallSegments(w)) L += Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
  return L || 1;
}

function pointAlongWall(w, t) {
  const edges = wallSegments(w);
  if (!edges.length) return { x: 0, y: 0 };
  const L = wallLenMm(w);
  let rem = Math.max(0, Math.min(1, Number(t) || 0)) * L;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) || 1e-9;
    if (rem <= len || i === edges.length - 1) {
      const u = Math.max(0, Math.min(1, rem / len));
      return { x: e.a.x + (e.b.x - e.a.x) * u, y: e.a.y + (e.b.y - e.a.y) * u };
    }
    rem -= len;
  }
  return { ...edges[edges.length - 1].b };
}

function projectOnWall(w, p) {
  const edges = wallSegments(w);
  if (!edges.length) return { t: 0, q: { x: 0, y: 0 }, dist: Infinity };
  const L = wallLenMm(w);
  let best = null;
  let acc = 0;
  for (const e of edges) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const len2 = dx * dx + dy * dy || 1;
    let u = ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / len2;
    u = Math.max(0, Math.min(1, u));
    const q = { x: e.a.x + dx * u, y: e.a.y + dy * u };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    const len = Math.sqrt(len2);
    const t = (acc + u * len) / L;
    if (!best || d < best.dist) best = { t, q, dist: d };
    acc += len;
  }
  return best;
}


function aabbOverlap(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
  return ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
}

function footprintAabb(corners, pad = 0) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function listMovables(doc, exclude) {
  const out = [];
  for (const l of doc?.lights || []) out.push({ kind: "light", id: l.id, o: l });
  for (const f of doc?.fans || []) out.push({ kind: "fan", id: f.id, o: f });
  for (const s of doc?.sockets || []) out.push({ kind: "socket", id: s.id, o: s });
  for (const c of doc?.cabinets || []) out.push({ kind: "cabinet", id: c.id, o: c });
  if (!exclude) return out;
  return out.filter((it) => !(it.kind === exclude.kind && it.id === exclude.id)
    && !(exclude.ids && exclude.ids.has(`${it.kind}:${it.id}`)));
}

/**
 * @param {object} opts
 * @param {object} opts.doc
 * @param {string} opts.kind
 * @param {object} opts.obj
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {object[]} [opts.walls]
 * @param {object} [opts.from] previous {x,y} — path must not cross walls
 * @param {object} [opts.stickyRoom] room object to stay inside
 * @param {boolean} [opts.ignoreObjects]
 * @param {Set<string>|null} [opts.ignoreIds] `${kind}:${id}` to skip in object collision (multi-drag)
 */
export function placementAllowed(opts) {
  const {
    doc,
    kind,
    obj,
    x,
    y,
    walls: wallsIn,
    from = null,
    stickyRoom = null,
    ignoreObjects = false,
    ignoreIds = null,
  } = opts;
  if (!doc || !obj || x == null || y == null) return false;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return false;

  const fp = objectFootprint(kind, obj);
  const corners = footprintCorners(x, y, fp.w, fp.d, fp.rot);
  const center = { x, y };
  // Wall-mounted (curtains, mirrors, …) may sit flush on a face, but never penetrate
  // or pass through walls — same solid physics as every other object.
  const flushMount = isWallMounted(kind, obj);
  const walls = wallsIn?.length ? wallsIn : (doc.walls || []);
  // Empty floor plan (no walls yet): allow placement
  if (!walls.length && !(doc.rooms || []).length) return true;

  // --- Solid walls (thickness + footprint) — no exceptions ---
  for (const wall of walls) {
    const edges = wallSegments(wall);
    if (!edges.length) continue;
    const half = wallHalf(wall, doc);
    // Freestanding keep comfort pad; flush mounts may touch the wall face (half + 1 mm).
    const clear = half + (flushMount ? 1 : fp.pad);
    const centerClear = half + (flushMount ? Math.max(1, (fp.d || 0) * 0.5) : Math.max(40, fp.pad));

    for (const edge of edges) {
      // Center must stay outside wall mass (and not sit mid-wall)
      if (distPointSeg(center, edge.a, edge.b) < centerClear) return false;
      // Every footprint corner stays outside the solid wall
      for (const p of corners) {
        if (distPointSeg(p, edge.a, edge.b) < clear) return false;
      }
      // Footprint edges must not cut through the thick wall band
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i], b = corners[(i + 1) % corners.length];
        if (segNearSeg(a, b, edge.a, edge.b, clear * 0.95)) return false;
      }
    }
  }

  // --- Path cannot teleport through walls ---
  // Sample along the path (skip t=0 so an already-illegal start can escape).
  if (from && (from.x !== x || from.y !== y)) {
    const dx = x - from.x, dy = y - from.y;
    const steps = Math.min(12, Math.max(3, Math.ceil(Math.hypot(dx, dy) / 80)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const sx = from.x + dx * t, sy = from.y + dy * t;
      const sc = footprintCorners(sx, sy, fp.w, fp.d, fp.rot);
      const scenter = { x: sx, y: sy };
      for (const wall of walls) {
        const edges = wallSegments(wall);
        if (!edges.length) continue;
        const half = wallHalf(wall, doc);
        const clear = half + (flushMount ? 1 : fp.pad);
        const centerClear = half + (flushMount ? Math.max(1, (fp.d || 0) * 0.5) : Math.max(40, fp.pad));
        for (const edge of edges) {
          if (distPointSeg(scenter, edge.a, edge.b) < centerClear) return false;
          for (const p of sc) {
            if (distPointSeg(p, edge.a, edge.b) < clear * 0.95) return false;
          }
        }
      }
    }
  }

  // --- Room containment (entire footprint stays in room) ---
  const rooms = doc.rooms || [];
  if (rooms.length) {
    const ptsList = stickyRoom
      ? [roomPointsFrom(stickyRoom)].filter((p) => p.length >= 3)
      : rooms.map((r) => roomPointsFrom(r)).filter((p) => p.length >= 3);
    if (ptsList.length) {
      // Flush mounts may rest on the boundary: center must be inside; freestanding = all corners.
      if (flushMount) {
        const ok = ptsList.some((pts) => pointInPoly(center, pts));
        if (!ok) return false;
      } else {
        for (const p of corners) {
          if (!ptsList.some((pts) => pointInPoly(p, pts))) return false;
        }
        if (!ptsList.some((pts) => pointInPoly(center, pts))) return false;
      }
    }
  }

  // --- Object–object collision (every kind, including sockets) ---
  if (!ignoreObjects) {
    const my = footprintAabb(corners, Math.max(10, fp.pad * 0.35));
    const others = listMovables(doc, {
      kind,
      id: obj.id,
      ids: ignoreIds,
    });
    for (const it of others) {
      if (it.o.x == null || it.o.y == null) continue;
      if (it.o.hidden) continue;
      const ofp = objectFootprint(it.kind, it.o);
      const oc = footprintCorners(it.o.x, it.o.y, ofp.w, ofp.d, ofp.rot);
      const oa = footprintAabb(oc, Math.max(10, ofp.pad * 0.35));
      if (aabbOverlap(my.minX, my.minY, my.maxX, my.maxY, oa.minX, oa.minY, oa.maxX, oa.maxY)) {
        // tighter: edge cross
        let hit = false;
        for (let i = 0; i < corners.length && !hit; i++) {
          const a = corners[i], b = corners[(i + 1) % corners.length];
          for (let j = 0; j < oc.length; j++) {
            if (segIntersect(a, b, oc[j], oc[(j + 1) % oc.length])) { hit = true; break; }
          }
        }
        // center inside other footprint AABB is enough for lights/fans
        if (hit
          || (center.x > oa.minX && center.x < oa.maxX && center.y > oa.minY && center.y < oa.maxY)
          || aabbOverlap(my.minX, my.minY, my.maxX, my.maxY, oa.minX, oa.minY, oa.maxX, oa.maxY)
            && Math.hypot(x - it.o.x, y - it.o.y) < (Math.min(fp.w, fp.d) + Math.min(ofp.w, ofp.d)) * 0.35
        ) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Try to move to target; slide along X/Y; binary-search along path if blocked.
 * @returns {{ x:number, y:number } | null}
 */
export function resolveMove(opts) {
  const {
    doc,
    kind,
    obj,
    fromX,
    fromY,
    toX,
    toY,
    walls,
    stickyRoom,
    ignoreIds,
    snapFn = (x, y) => ({ x, y }),
  } = opts;

  const from = { x: fromX, y: fromY };
  // If already intersecting a wall (legacy/illegal pose), drop path constraint so it can escape.
  const fromLegal = placementAllowed({
    doc, kind, obj, x: fromX, y: fromY, walls, stickyRoom, ignoreIds, ignoreObjects: true,
  });
  const tryAt = (x, y) => {
    const s = snapFn(x, y);
    return placementAllowed({
      doc, kind, obj, x: s.x, y: s.y, walls,
      from: fromLegal ? from : null,
      stickyRoom, ignoreIds,
    }) ? s : null;
  };

  let hit = tryAt(toX, toY);
  if (hit) return hit;

  // Axis slide (slide along walls) — ignore no-op results
  hit = tryAt(toX, fromY);
  if (hit && (hit.x !== fromX || hit.y !== fromY)) return hit;
  hit = tryAt(fromX, toY);
  if (hit && (hit.x !== fromX || hit.y !== fromY)) return hit;

  // Binary search along intended path — stop at last legal point
  let lo = 0, hi = 1, best = null;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const x = fromX + (toX - fromX) * mid;
    const y = fromY + (toY - fromY) * mid;
    const ok = tryAt(x, y);
    if (ok) {
      best = ok;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (best && (best.x !== fromX || best.y !== fromY)) return best;

  // Micro slides toward target
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  for (const step of [400, 200, 100, 50, 25]) {
    const s = tryAt(fromX + ux * step, fromY + uy * step);
    if (s && (s.x !== fromX || s.y !== fromY)) return s;
  }
  return null;
}

/** Convenience wrapper matching older call signature. */
export function canPlace(doc, kind, obj, x, y, extra = {}) {
  return placementAllowed({ doc, kind, obj, x, y, ...extra });
}

/**
 * Wall segments solid for first-person walking.
 * Open doors / passages punch gaps; closed doors stay blocked; windows stay solid.
 * Ready for openHAB: door.open is the local actuator state.
 */
export function walkCollisionWalls(doc) {
  const walls = doc?.walls || [];
  const openings = doc?.openings || [];
  const doorByOpening = new Map((doc?.doors || []).map((d) => [d.openingId, d]));
  const out = [];

  for (const wall of walls) {
    const pts = wallPoints(wall);
    if (pts.length < 2) continue;
    const gaps = [];
    for (const o of openings) {
      if (o.wallId !== wall.id) continue;
      const typ = String(o.type || "opening").toLowerCase();
      if (typ === "window") continue;
      if (typ === "door") {
        const door = doorByOpening.get(o.id);
        // Missing door leaf ⇒ treat as passage; otherwise only when open.
        if (door && !door.open) continue;
      }
      const t0 = Math.min(Number(o.t0) || 0, Number(o.t1) || 0);
      const t1 = Math.max(Number(o.t0) || 0, Number(o.t1) || 0);
      if (t1 - t0 > 0.02) gaps.push([t0, t1]);
    }
    gaps.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const g of gaps) {
      if (!merged.length || g[0] > merged[merged.length - 1][1] + 0.002) merged.push([...g]);
      else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], g[1]);
    }

    const emit = (tA, tB) => {
      if (tB - tA < 0.012) return;
      // Emit as one or more straight segments along the polyline span
      const spanPts = [];
      const L = wallLenMm(wall);
      let acc = 0;
      spanPts.push(pointAlongWall(wall, tA));
      for (let i = 1; i < pts.length; i++) {
        acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        const t = acc / L;
        if (t > tA + 1e-6 && t < tB - 1e-6) spanPts.push({ ...pts[i] });
      }
      if (wall.closed && pts.length >= 3) {
        // closing edge vertices already covered via pointAlongWall / edges
      }
      spanPts.push(pointAlongWall(wall, tB));
      for (let i = 0; i < spanPts.length - 1; i++) {
        if (Math.hypot(spanPts[i + 1].x - spanPts[i].x, spanPts[i + 1].y - spanPts[i].y) < 5) continue;
        out.push({
          id: `${wall.id}_${tA.toFixed(3)}_${tB.toFixed(3)}_${i}`,
          a: { ...spanPts[i] },
          b: { ...spanPts[i + 1] },
          thickness: wall.thickness,
        });
      }
    };
    let cursor = 0;
    for (const [g0, g1] of merged) {
      emit(cursor, g0);
      cursor = g1;
    }
    emit(cursor, 1);
  }
  return out;
}

/** True if plan point sits in an open door / passage clear opening (incl. wall thickness). */
export function pointInOpenPassage(doc, p, padMm = 180) {
  if (!doc || !p) return false;
  const doorByOpening = new Map((doc.doors || []).map((d) => [d.openingId, d]));
  for (const o of doc.openings || []) {
    const typ = String(o.type || "opening").toLowerCase();
    if (typ === "window") continue;
    if (typ === "door") {
      const door = doorByOpening.get(o.id);
      if (door && !door.open) continue;
    }
    const wall = (doc.walls || []).find((w) => w.id === o.wallId);
    if (!wallPoints(wall).length) continue;
    const t0 = Math.min(Number(o.t0) || 0, Number(o.t1) || 0);
    const t1 = Math.max(Number(o.t0) || 0, Number(o.t1) || 0);
    const half = (wall.thickness ?? doc.wallThicknessMm ?? 120) / 2 + padMm;
    const pr = projectOnWall(wall, p);
    if (pr.dist > half) continue;
    if (pr.t >= t0 - 0.02 && pr.t <= t1 + 0.02) return true;
  }
  return false;
}

function openingMid(doc, opening) {
  const wall = (doc.walls || []).find((w) => w.id === opening.wallId);
  if (!wallPoints(wall).length) return null;
  const t = (Number(opening.t0) + Number(opening.t1)) / 2;
  const p = pointAlongWall(wall, t);
  return { x: p.x, y: p.y, wall };
}

/**
 * Nearest automatable device for walkthrough prompts (doors / windows / curtains).
 * Returns { kind, id, label, open, distMm, verb } or null.
 */
export function nearestWalkActuator(doc, plan, { maxMm = 1400, yawRad = null } = {}) {
  if (!doc || !plan) return null;
  const candidates = [];

  for (const d of doc.doors || []) {
    const o = (doc.openings || []).find((x) => x.id === d.openingId);
    const mid = o ? openingMid(doc, o) : null;
    if (!mid) continue;
    const dist = Math.hypot(plan.x - mid.x, plan.y - mid.y);
    candidates.push({
      kind: "door",
      id: d.id,
      label: d.label || "Door",
      open: !!d.open,
      distMm: dist,
      x: mid.x,
      y: mid.y,
      verb: d.open ? "Close" : "Open",
    });
  }

  for (const w of doc.windows || []) {
    if (w.style === "fixed") continue;
    const o = (doc.openings || []).find((x) => x.id === w.openingId);
    const mid = o ? openingMid(doc, o) : (w.x != null ? { x: w.x, y: w.y } : null);
    if (!mid) continue;
    const dist = Math.hypot(plan.x - mid.x, plan.y - mid.y);
    candidates.push({
      kind: "window",
      id: w.id,
      label: w.label || "Window",
      open: !!w.open,
      distMm: dist,
      x: mid.x,
      y: mid.y,
      verb: w.open ? "Close" : "Open",
    });
  }

  for (const c of doc.cabinets || []) {
    const t = String(c.type || "");
    if (!/curtain|blind|sheer|shade|drape/i.test(t) && c.kind !== "curtain") continue;
    if (c.x == null || c.y == null) continue;
    const dist = Math.hypot(plan.x - c.x, plan.y - c.y);
    candidates.push({
      kind: "cabinet",
      id: c.id,
      label: c.label || "Curtain",
      open: !!c.open,
      distMm: dist,
      x: c.x,
      y: c.y,
      verb: c.open ? "Close" : "Open",
    });
  }

  let best = null;
  for (const c of candidates) {
    if (c.distMm > maxMm) continue;
    let score = c.distMm;
    if (yawRad != null) {
      // Prefer devices roughly in front of the player (openHAB-style local control).
      const ang = Math.atan2(c.x - plan.x, -(c.y - plan.y)); // plan y → -world z
      let dAng = Math.abs(ang - yawRad);
      while (dAng > Math.PI) dAng = Math.abs(dAng - Math.PI * 2);
      if (dAng > 1.35) score += 500; // behind / side penalty
      else score += dAng * 120;
    }
    if (!best || score < best._score) best = { ...c, _score: score };
  }
  if (!best) return null;
  delete best._score;
  return best;
}
