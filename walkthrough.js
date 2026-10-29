/**
 * First-person walkthrough for the 3D preview.
 * Wide FOV in walk mode; collision respects open doors; Space/E/O toggles nearby actuators.
 */
import {
  placementAllowed,
  roomPointsFrom,
  pointInPoly,
  walkCollisionWalls,
  pointInOpenPassage,
  nearestWalkActuator,
  distPointSeg,
} from "./placement-physics.js";

const M = 0.001; // mm → m (must match preview3d)

const FOV_MODES = {
  normal: { id: "normal", label: "Normal", fov: 75 },
  wide: { id: "wide", label: "Wide", fov: 90 },
  ultra: { id: "ultra", label: "Ultra", fov: 105 },
};
const FOV_ORDER = ["normal", "wide", "ultra"];
const FOV_STORAGE_KEY = "a15.walk.fovMode";
const ORBIT_NEAR = 0.1;
const WALK_NEAR = 0.05;
/** Body half-size for stand probe (mm) — slightly leaner than before so doorways feel less sticky. */
const BODY_MM = 380;
/** Extra clearance past wall half when standing in an open passage (mm). */
const PASSAGE_PAD_MM = 70;

function loadFovMode() {
  try {
    const v = localStorage.getItem(FOV_STORAGE_KEY);
    if (v && FOV_MODES[v]) return v;
  } catch { /* */ }
  return "wide";
}

function saveFovMode(id) {
  try { localStorage.setItem(FOV_STORAGE_KEY, id); } catch { /* */ }
}

/**
 * @param {object} opts
 * @param {import('three').PerspectiveCamera} opts.camera
 * @param {HTMLElement} opts.dom
 * @param {() => object|null} opts.getDoc
 * @param {() => object[]} [opts.getWalls]
 * @param {number} [opts.eyeHeightM]
 * @param {number} [opts.speedMps]
 * @param {(active: boolean) => void} [opts.onModeChange]
 * @param {(device: object|null) => void} [opts.onNearbyChange]
 * @param {(device: object) => void} [opts.onToggleActuator]
 * @param {(mode: {id:string,label:string,fov:number}) => void} [opts.onFovChange]
 * @param {(text: string) => void} [opts.onHint]
 */
export function createWalkthrough({
  camera,
  dom,
  getDoc,
  getWalls,
  eyeHeightM = 1.6,
  speedMps = 2.2,
  onModeChange,
  onNearbyChange,
  onToggleActuator,
  onFovChange,
  onHint,
}) {
  let active = false;
  let yaw = 0;
  let pitch = 0;
  const keys = new Set();
  let prevT = 0;
  let nearby = null;
  let hintAcc = 0;
  let fovMode = loadFovMode();
  let savedFov = null;
  let savedNear = null;
  let pointerLocked = false;
  let dragLooking = false;
  let lookHintShown = false;

  function fovDeg() {
    return FOV_MODES[fovMode]?.fov ?? 90;
  }

  function applyWalkProjection() {
    camera.fov = fovDeg();
    camera.near = WALK_NEAR;
    camera.updateProjectionMatrix();
  }

  function restoreOrbitProjection() {
    if (savedFov != null) camera.fov = savedFov;
    if (savedNear != null) camera.near = savedNear;
    camera.updateProjectionMatrix();
    savedFov = null;
    savedNear = null;
  }

  function syncCameraFromAngles() {
    camera.lookAt(
      camera.position.x + Math.sin(yaw) * Math.cos(pitch),
      camera.position.y + Math.sin(pitch),
      camera.position.z - Math.cos(yaw) * Math.cos(pitch),
    );
  }

  function planFromWorld(x, z) {
    return { x: x / M, y: -z / M };
  }
  function worldFromPlan(p) {
    return { x: p.x * M, z: -p.y * M };
  }

  function canStandAt(wx, wz) {
    const doc = getDoc();
    if (!doc) return false;
    const plan = planFromWorld(wx, wz);
    const walls = walkCollisionWalls(doc);

    if (pointInOpenPassage(doc, plan, 240)) {
      for (const wall of walls) {
        if (!wall?.a || !wall?.b) continue;
        const half = (wall.thickness ?? doc.wallThicknessMm ?? 120) / 2;
        if (distPointSeg(plan, wall.a, wall.b) < half + PASSAGE_PAD_MM) return false;
      }
      return true;
    }

    const inRoom = !(doc.rooms || []).length
      || (doc.rooms || []).some((r) => {
        const pts = roomPointsFrom(r);
        return pts.length >= 3 && pointInPoly(plan, pts);
      });
    if (!inRoom) return false;
    const probe = { widthMm: BODY_MM, depthMm: BODY_MM, rotationDeg: 0, id: "__walker__" };
    return placementAllowed({
      doc,
      kind: "cabinet",
      obj: probe,
      x: plan.x,
      y: plan.y,
      walls: walls.length ? walls : (getWalls?.() || doc.walls || []),
      ignoreObjects: true,
    });
  }

  function tryMove(dx, dz) {
    const nx = camera.position.x + dx;
    const nz = camera.position.z + dz;
    if (canStandAt(nx, nz)) {
      camera.position.x = nx;
      camera.position.z = nz;
      return true;
    }
    if (canStandAt(camera.position.x + dx, camera.position.z)) {
      camera.position.x += dx;
      return true;
    }
    if (canStandAt(camera.position.x, camera.position.z + dz)) {
      camera.position.z += dz;
      return true;
    }
    return false;
  }

  /** Longest clear walk distance (meters) from (wx,wz) along plan yaw angle. */
  function clearDistance(wx, wz, ang, maxM = 4) {
    const step = 0.12;
    let d = 0;
    while (d + step <= maxM) {
      d += step;
      if (!canStandAt(wx + Math.sin(ang) * d, wz - Math.cos(ang) * d)) return d - step;
    }
    return maxM;
  }

  function pickSpawnFacing(wx, wz) {
    let bestAng = 0;
    let bestDist = -1;
    for (let i = 0; i < 16; i++) {
      const ang = (i / 16) * Math.PI * 2;
      const d = clearDistance(wx, wz, ang);
      if (d > bestDist) {
        bestDist = d;
        bestAng = ang;
      }
    }
    return bestAng;
  }

  function refreshNearby() {
    const doc = getDoc();
    if (!doc || !active) {
      if (nearby) {
        nearby = null;
        onNearbyChange?.(null);
      }
      return;
    }
    const plan = planFromWorld(camera.position.x, camera.position.z);
    const next = nearestWalkActuator(doc, plan, { maxMm: 1300, yawRad: yaw });
    const same = nearby && next
      && nearby.kind === next.kind
      && nearby.id === next.id
      && nearby.open === next.open;
    if (!same) {
      nearby = next;
      onNearbyChange?.(nearby);
    } else if (next) {
      nearby = next;
    }
  }

  function tryToggleNearby() {
    if (!nearby) return false;
    onToggleActuator?.(nearby);
    refreshNearby();
    return true;
  }

  function getFovMode() {
    return { ...FOV_MODES[fovMode] };
  }

  function setFovMode(id, { silent = false } = {}) {
    if (!FOV_MODES[id]) return getFovMode();
    fovMode = id;
    saveFovMode(id);
    if (active) applyWalkProjection();
    const mode = getFovMode();
    if (!silent) onFovChange?.(mode);
    return mode;
  }

  function cycleFovMode(dir = 1) {
    const i = FOV_ORDER.indexOf(fovMode);
    const next = FOV_ORDER[(i + (dir >= 0 ? 1 : -1) + FOV_ORDER.length) % FOV_ORDER.length];
    return setFovMode(next);
  }

  function onKeyDown(e) {
    if (!active) return;
    keys.add(e.code);
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      e.preventDefault();
    }
    if (e.code === "Escape") {
      setActive(false);
      return;
    }
    if (e.code === "BracketLeft") {
      e.preventDefault();
      cycleFovMode(-1);
      return;
    }
    if (e.code === "BracketRight") {
      e.preventDefault();
      cycleFovMode(1);
      return;
    }
    if (e.code === "Space" || e.code === "KeyE" || e.code === "KeyO") {
      if (tryToggleNearby()) e.preventDefault();
    }
  }
  function onKeyUp(e) {
    keys.delete(e.code);
  }

  function applyLookDelta(dx, dy) {
    const sens = 0.0022;
    yaw -= dx * sens;
    pitch -= dy * sens;
    pitch = Math.max(-1.2, Math.min(1.2, pitch));
  }

  function onMouseMove(e) {
    if (!active) return;
    if (pointerLocked || dragLooking) {
      applyLookDelta(e.movementX || 0, e.movementY || 0);
    }
  }

  function onPointerDown(e) {
    if (!active) return;
    if (e.button !== 0) return;
    if (!pointerLocked) {
      requestLookLock();
      dragLooking = true;
      try { dom.setPointerCapture?.(e.pointerId); } catch { /* */ }
    }
  }
  function onPointerUp(e) {
    if (!dragLooking) return;
    dragLooking = false;
    try { dom.releasePointerCapture?.(e.pointerId); } catch { /* */ }
  }

  function onPointerLockChange() {
    pointerLocked = document.pointerLockElement === dom;
  }

  function requestLookLock() {
    try {
      const p = dom.requestPointerLock?.();
      if (p && typeof p.then === "function") {
        p.catch(() => { /* Safari / denied — drag look still works */ });
      }
    } catch { /* optional */ }
    window.setTimeout(() => {
      if (active && !pointerLocked && !lookHintShown) {
        lookHintShown = true;
        onHint?.("Click canvas and drag to look");
      }
    }, 450);
  }

  function setActive(next) {
    const want = !!next;
    if (want) {
      const doc = getDoc();
      if (!doc) {
        onModeChange?.(false);
        return;
      }
      const hasRooms = (doc.rooms || []).some((r) => roomPointsFrom(r).length >= 3);
      if (!hasRooms && (doc.walls || []).length === 0) {
        onModeChange?.(false);
        return;
      }
    }
    active = want;
    keys.clear();
    prevT = 0;
    dragLooking = false;
    lookHintShown = false;

    if (active) {
      savedFov = camera.fov;
      savedNear = camera.near;
      applyWalkProjection();

      const doc = getDoc();
      let wx = camera.position.x;
      let wz = camera.position.z;
      if (doc?.rooms?.length) {
        const r = doc.rooms.find((room) => roomPointsFrom(room).length >= 3) || doc.rooms[0];
        const pts = roomPointsFrom(r);
        if (pts.length) {
          const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
          const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
          const w = worldFromPlan({ x: cx, y: cy });
          wx = w.x;
          wz = w.z;
        }
      }
      if (!canStandAt(wx, wz)) {
        for (const rad of [0.4, 0.8, 1.2, 1.8]) {
          let found = false;
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            const tx = wx + Math.cos(a) * rad;
            const tz = wz + Math.sin(a) * rad;
            if (canStandAt(tx, tz)) { wx = tx; wz = tz; found = true; break; }
          }
          if (found) break;
        }
      }
      camera.position.set(wx, eyeHeightM, wz);
      yaw = pickSpawnFacing(wx, wz);
      pitch = 0;
      syncCameraFromAngles();
      requestLookLock();
      refreshNearby();
    } else {
      try { document.exitPointerLock?.(); } catch { /* */ }
      pointerLocked = false;
      restoreOrbitProjection();
      nearby = null;
      onNearbyChange?.(null);
    }
    onModeChange?.(active);
  }

  function canWalk() {
    const doc = getDoc();
    if (!doc) return false;
    return (doc.rooms || []).some((r) => roomPointsFrom(r).length >= 3) || (doc.walls || []).length > 0;
  }

  function toggle() {
    setActive(!active);
  }

  function update(nowMs) {
    if (!active) return;
    const t = nowMs || performance.now();
    const dt = Math.min(0.05, (t - (prevT || t)) / 1000);
    prevT = t;
    let vx = 0;
    let vz = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) { vx += Math.sin(yaw); vz -= Math.cos(yaw); }
    if (keys.has("KeyS") || keys.has("ArrowDown")) { vx -= Math.sin(yaw); vz += Math.cos(yaw); }
    if (keys.has("KeyA") || keys.has("ArrowLeft")) { vx -= Math.cos(yaw); vz -= Math.sin(yaw); }
    if (keys.has("KeyD") || keys.has("ArrowRight")) { vx += Math.cos(yaw); vz += Math.sin(yaw); }
    const len = Math.hypot(vx, vz);
    if (len > 1e-6) {
      const sprint = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 1.7 : 1;
      const sp = (speedMps * sprint * dt) / len;
      tryMove(vx * sp, vz * sp);
    }
    camera.position.y = eyeHeightM;
    syncCameraFromAngles();
    hintAcc += dt;
    if (hintAcc > 0.12) {
      hintAcc = 0;
      refreshNearby();
    }
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  dom.addEventListener("mousemove", onMouseMove);
  dom.addEventListener("pointerdown", onPointerDown);
  dom.addEventListener("pointerup", onPointerUp);
  dom.addEventListener("pointercancel", onPointerUp);

  return {
    get active() { return active; },
    get nearby() { return nearby; },
    canWalk,
    setActive,
    toggle,
    update,
    getFovMode,
    setFovMode,
    cycleFovMode,
    dispose() {
      setActive(false);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      dom.removeEventListener("mousemove", onMouseMove);
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("pointercancel", onPointerUp);
    },
  };
}
