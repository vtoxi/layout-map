/** Room area schedule helpers for export packs. */

export function roomPoints(r) {
  if (!r) return [];
  if (Array.isArray(r.points) && r.points.length >= 3) return r.points;
  if (r.w != null && r.h != null) {
    return [
      { x: r.x || 0, y: r.y || 0 },
      { x: (r.x || 0) + r.w, y: r.y || 0 },
      { x: (r.x || 0) + r.w, y: (r.y || 0) + r.h },
      { x: r.x || 0, y: (r.y || 0) + r.h },
    ];
  }
  return [];
}

/** Shoelace area in mm² */
export function polygonAreaMm2(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return Math.abs(a) / 2;
}

export function buildAreaSchedule(doc) {
  const rows = [];
  for (const r of doc?.rooms || []) {
    const pts = roomPoints(r);
    const mm2 = polygonAreaMm2(pts);
    rows.push({
      id: r.id,
      label: r.label || r.id,
      areaMm2: Math.round(mm2),
      areaM2: Math.round((mm2 / 1e6) * 100) / 100,
      sides: pts.length,
    });
  }
  return rows;
}

export function areaScheduleCsv(doc) {
  const rows = buildAreaSchedule(doc);
  const lines = ["id,label,area_m2,area_mm2,sides"];
  for (const r of rows) {
    const label = String(r.label).replace(/"/g, '""');
    lines.push(`${r.id},"${label}",${r.areaM2},${r.areaMm2},${r.sides}`);
  }
  return lines.join("\n") + "\n";
}

export function docCounts(doc) {
  return {
    walls: (doc?.walls || []).length,
    doors: (doc?.doors || []).length,
    windows: (doc?.windows || []).length,
    rooms: (doc?.rooms || []).length,
    lights: (doc?.lights || []).length,
    fans: (doc?.fans || []).length,
    sockets: (doc?.sockets || []).length,
    furniture: (doc?.cabinets || []).length,
    images: (doc?.images || []).length,
  };
}
