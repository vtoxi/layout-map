/** Shared solar / day-cycle math for 3D preview. */

export const SITE_PRESETS = [
  { id: "karachi", name: "Karachi", lat: 24.8607, lon: 67.0011 },
  { id: "lahore", name: "Lahore", lat: 31.5204, lon: 74.3587 },
  { id: "islamabad", name: "Islamabad", lat: 33.6844, lon: 73.0479 },
  { id: "dubai", name: "Dubai", lat: 25.2048, lon: 55.2708 },
  { id: "london", name: "London", lat: 51.5074, lon: -0.1278 },
  { id: "nyc", name: "New York", lat: 40.7128, lon: -74.0060 },
  { id: "tokyo", name: "Tokyo", lat: 35.6762, lon: 139.6503 },
  { id: "sydney", name: "Sydney", lat: -33.8688, lon: 151.2093 },
];

export const DAY_KEY = "a15-daycycle-v1";

export function defaultDayCycle() {
  return {
    hours: 14,
    dayOfYear: 172,
    lat: 24.8607,
    lon: 67.0011,
    preset: "karachi",
    syncRealtime: false,
  };
}

export function loadDayCycle() {
  const base = defaultDayCycle();
  try {
    const raw = localStorage.getItem(DAY_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return base;
    const next = { ...base, ...saved };
    next.lat = clampNum(next.lat, -90, 90, base.lat);
    next.lon = clampNum(next.lon, -180, 180, base.lon);
    next.hours = clampNum(next.hours, 0, 24, base.hours);
    next.dayOfYear = Math.round(clampNum(next.dayOfYear, 1, 366, base.dayOfYear));
    next.syncRealtime = !!next.syncRealtime;
    return next;
  } catch {
    return base;
  }
}

function clampNum(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function saveDayCycle(dayCycle) {
  try { localStorage.setItem(DAY_KEY, JSON.stringify(dayCycle)); } catch { /* */ }
}

export function syncHoursFromClock(dayCycle) {
  const now = new Date();
  dayCycle.hours = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600 + now.getMilliseconds() / 3.6e6;
  const start = new Date(now.getFullYear(), 0, 0);
  dayCycle.dayOfYear = Math.max(1, Math.min(366, Math.floor((now - start) / 8.64e7)));
  return dayCycle;
}

/** Solar elevation & azimuth (rad). hour = local solar time at site. */
export function solarCoords(latDeg, dayOfYear, hour) {
  const rad = Math.PI / 180;
  const lat = clampNum(latDeg, -90, 90, 0) * rad;
  const doy = clampNum(dayOfYear, 1, 366, 172);
  const hr = clampNum(hour, 0, 24, 12);
  const decl = 23.45 * rad * Math.sin(rad * (360 / 365) * (doy - 81));
  const ha = (hr - 12) * 15 * rad;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const elev = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const cosAz = (Math.sin(decl) - Math.sin(elev) * Math.sin(lat)) / (Math.cos(elev) * Math.cos(lat) + 1e-12);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (ha > 0) az = Math.PI * 2 - az;
  return { elev, az, decl };
}

export function dayPhaseLabel(elevDeg) {
  if (elevDeg < -12) return "Night";
  if (elevDeg < -4) return "Dawn / dusk";
  if (elevDeg < 8) return "Golden hour";
  if (elevDeg < 40) return "Day";
  return "High sun";
}

/** Approximate Kelvin → RGB (0–1). */
export function kelvinToRgb(k, THREE) {
  const temp = Math.max(1000, Math.min(40000, k)) / 100;
  let r; let g; let b;
  if (temp <= 66) {
    r = 1;
    g = Math.max(0, Math.min(1, (99.4708025861 * Math.log(temp) - 161.1195681661) / 255));
  } else {
    r = Math.max(0, Math.min(1, (329.698727446 * (temp - 60) ** -0.1332047592) / 255));
    g = Math.max(0, Math.min(1, (288.1221695283 * (temp - 60) ** -0.0755148492) / 255));
  }
  if (temp >= 66) b = 1;
  else if (temp <= 19) b = 0;
  else b = Math.max(0, Math.min(1, (138.5177312231 * Math.log(temp - 10) - 305.0447927307) / 255));
  return new THREE.Color(r, g, b);
}
