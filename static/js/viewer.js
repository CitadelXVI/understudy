// The stage: draws the selected animation's skeleton on a canvas with a camera
// that follows the root, and owns playback (30 fps, frame stepping).
const canvas = document.querySelector('#view');
const ctx = canvas.getContext('2d');
const slider = document.querySelector('#frame');
const ui = document.querySelector('#viewui'), uiCtx = ui.getContext('2d'); // above the body overlay: handles stay visible inside the mesh
const frameText = document.querySelector('#frameText');
const playButton = document.querySelector('#play');

// Skeleton of the loaded animation (parent index and parent-local rest offset per joint).
let parents = [];
let offsets = [];
let jointNames = [];
export const skeleton = { get parents() { return parents; }, get offsets() { return offsets; }, get names() { return jointNames; } };

export const state = {
  selectedProp: -1,   // index into animation.props of the box picked on the stage (props.js), or -1
  override: null,    // { frame, root, rotations[][4] } shown instead of the clip's pose on that frame
  animation: null,   // the gallery record being shown
  root: null,        // Float32Array [frames * 3]
  rotations: null,   // Float32Array [frames * joints * 4], parent-local XYZW
  frame: 0,
  playing: true,
};
let playbackBlend = 0, last = 0, cameraLast = 0;
// Trails: off, the hips, or hips + hands + feet. Every frame's joint positions
// are computed once per clip (allPositions) so the curves are cheap to draw.
// Off for a fresh profile: the figure comes first; T (or the Trail button) brings them in.
const trailDefaults = { on: false, hips: true, ground: true, arrows: true, metres: true, head: false, dots: true, lhand: true, rhand: true, lfoot: true, rfoot: true, follow: true };
// Joint paths only show this many frames either side of the current one, fading with age,
// so a long clip never buries the hands and face under its whole route.
const TRAIL_WINDOW = 45;
let trails = { ...trailDefaults };
try { trails = { ...trailDefaults, ...JSON.parse(localStorage.getItem('understudy.trails') || '{}') }; } catch { /* keep defaults */ }
const trailButton = document.querySelector('#trail'), trailPanel = document.querySelector('#trailPanel');
let allPositions = null; // [frame][joint][3]
let trailJoints = {};    // key -> joint index, for the skeleton on screen
function trailLabel() { trailButton.classList.toggle('on', trails.on); }
function syncTrailPanel() { for (const input of trailPanel.querySelectorAll('input')) input.checked = !!trails[input.dataset.trail]; }
export function setTrails(patch) { Object.assign(trails, patch); localStorage.setItem('understudy.trails', JSON.stringify(trails)); trailLabel(); syncTrailPanel(); draw(); }
export function toggleTrails() { setTrails({ on: !trails.on }); }
const syncTrailOpen = () => trailButton.classList.toggle('open', !trailPanel.hidden);
trailButton.onclick = () => { trailPanel.hidden = !trailPanel.hidden; syncTrailOpen(); };
document.addEventListener('pointerdown', e => { if (!trailPanel.hidden && !trailPanel.contains(e.target) && !trailButton.contains(e.target)) { trailPanel.hidden = true; syncTrailOpen(); } });
trailPanel.addEventListener('change', e => { if (e.target.dataset.trail) setTrails({ [e.target.dataset.trail]: e.target.checked }); });
trailLabel(); syncTrailPanel();

function computeAllPositions() {
  const { animation, root, rotations } = state;
  allPositions = null; trailJoints = {};
  if (!animation || !root || !rotations || !parents.length) return;
  const joints = parents.length, out = [];
  for (let f = 0; f < animation.frames; f++) {
    const positions = [], global = [];
    for (let j = 0; j < joints; j++) {
      const q = Array.from(rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)), p = parents[j];
      if (p < 0) { global[j] = q; positions[j] = [root[f * 3], root[f * 3 + 1], root[f * 3 + 2]]; }
      else { global[j] = multiply(global[p], q); positions[j] = add(positions[p], rotate(global[p], offsets[j])); }
    }
    out.push(positions);
  }
  allPositions = out;
  const names = jointNames.map(n => n.toLowerCase());
  const pick = (key, test) => { const i = names.findIndex(test); if (i >= 0) trailJoints[key] = i; };
  pick('lhand', n => n === 'lefthand' || n === 'left_wrist' || n.startsWith('left_hand') || n.startsWith('left_wrist'));
  pick('rhand', n => n === 'righthand' || n === 'right_wrist' || n.startsWith('right_hand') || n.startsWith('right_wrist'));
  pick('lfoot', n => n === 'leftfoot' || n === 'left_foot' || n.startsWith('left_ankle'));
  pick('rfoot', n => n === 'rightfoot' || n === 'right_foot' || n.startsWith('right_ankle'));
  pick('head', n => n === 'head' || n.endsWith('_head') || n.startsWith('head'));
}
const trailColours = { hips: '#ffffff', head: '#ffd27f', lhand: '#7fd0ff', rhand: '#7fd0ff', lfoot: '#8fe3a2', rfoot: '#8fe3a2' };

// One joint's path as a thin curve that fades with age: strongest at the current
// frame, gone TRAIL_WINDOW frames away. The played side is brighter than what is
// still to come; a small dot marks every half second.
function trailAlpha(f) {
  const d = Math.abs(f - state.frame);
  if (d > TRAIL_WINDOW) return 0;
  const k = 1 - d / TRAIL_WINDOW;
  return (f <= state.frame ? .85 : .45) * k * k;
}
function drawPath(points, colour, width) {
  const { frame } = state, s = scale(), n = points.length;
  if (n < 2) return;
  const from = Math.max(0, frame - TRAIL_WINDOW), to = Math.min(n - 1, frame + TRAIL_WINDOW);
  const projected = [];
  for (let f = from; f <= to; f++) projected[f] = project(points[f]);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = colour; ctx.lineWidth = width * s;
  for (let f = from; f < to; f++) {
    ctx.globalAlpha = trailAlpha(f + .5);
    ctx.beginPath(); ctx.moveTo(projected[f][0], projected[f][1]); ctx.lineTo(projected[f + 1][0], projected[f + 1][1]); ctx.stroke();
  }
  ctx.fillStyle = colour;
  for (let f = from; f <= to; f++) {
    const big = f % 15 === 0;
    if (!big && (!trails.dots || f % 5)) continue;
    ctx.globalAlpha = Math.min(1, trailAlpha(f) * 1.2);
    ctx.beginPath(); ctx.arc(projected[f][0], projected[f][1], (big ? 2.4 : 1.3) * s, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawTrail() {
  const { animation, root } = state;
  if (!trails.on || !animation || !root || !allPositions) return;
  const s = scale();
  const hips = allPositions.map(p => p[0]);
  if (trails.ground) {
    // The route: a solid line on the ground, played part bright.
    const n = hips.length, f0 = state.frame;
    for (const [from, to, alpha] of [[f0, n - 1, .3], [0, f0, .9]]) {
      if (to <= from) continue;
      ctx.globalAlpha = alpha; ctx.strokeStyle = '#ff8a80'; ctx.lineWidth = 3 * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let f = from; f <= to; f++) { const p = project([hips[f][0], state.floorY || 0, hips[f][2]]); f === from ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]); }
      ctx.stroke();
    }
    // Facing arrows every half second: where the hips point, not where they move.
    if (trails.arrows) {
      const { rotations } = state, joints = parents.length;
      for (let f = 0; f < n; f += 15) {
        const [x, y, z, w] = rotations.subarray((f * joints) * 4, (f * joints) * 4 + 4);
        const fx = 2 * (x * z + w * y), fz = 1 - 2 * (x * x + y * y), len = Math.hypot(fx, fz) || 1;
        const base = [hips[f][0], state.floorY || 0, hips[f][2]], tip = [base[0] + fx / len * .35, state.floorY || 0, base[2] + fz / len * .35];
        const b = project(base), t = project(tip), ang = Math.atan2(t[1] - b[1], t[0] - b[0]);
        ctx.globalAlpha = f <= f0 ? .95 : .4; ctx.strokeStyle = '#ffd700'; ctx.fillStyle = '#ffd700'; ctx.lineWidth = 2 * s;
        ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(t[0], t[1]); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(t[0] - 7 * s * Math.cos(ang - .5), t[1] - 7 * s * Math.sin(ang - .5)); ctx.lineTo(t[0] - 7 * s * Math.cos(ang + .5), t[1] - 7 * s * Math.sin(ang + .5)); ctx.closePath(); ctx.fill();
      }
    }
    // Metre marks along the route.
    if (trails.metres) {
      let walked = 0, next = 1;
      ctx.globalAlpha = .9; ctx.fillStyle = '#ffffff'; ctx.font = `${Math.round(12 * s)}px ${getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'}`; ctx.textAlign = 'center';
      for (let f = 1; f < n; f++) {
        walked += Math.hypot(hips[f][0] - hips[f - 1][0], hips[f][2] - hips[f - 1][2]);
        if (walked >= next) { const p = project([hips[f][0], state.floorY || 0, hips[f][2]]); ctx.beginPath(); ctx.arc(p[0], p[1], 3.5 * s, 0, Math.PI * 2); ctx.fill(); ctx.fillText(`${next} m`, p[0], p[1] - 8 * s); next++; }
      }
      ctx.textAlign = 'start';
    }
    const [x, y, z] = renderedRoot(), a = project([x, state.floorY || 0, z]), b = project([x, y, z]);
    ctx.globalAlpha = .45; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1 * s; ctx.setLineDash([3 * s, 3 * s]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  const current = [];
  if (trails.hips) { drawPath(hips, trailColours.hips, 1.4); current.push(hips[state.frame]); }
  for (const key of ['head', 'lhand', 'rhand', 'lfoot', 'rfoot']) {
    const j = trailJoints[key];
    if (!trails[key] || j == null) continue;
    drawPath(allPositions.map(p => p[j]), trailColours[key], 1.1);
    current.push(allPositions[state.frame][j]);
  }
  // The current frame, a small gold ring on every tracked joint.
  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 1.5 * s; ctx.globalAlpha = .9;
  for (const q of current) { const p = project(q); ctx.beginPath(); ctx.arc(p[0], p[1], 4.5 * s, 0, Math.PI * 2); ctx.stroke(); }
  ctx.globalAlpha = 1;
}

const defaultView = { yaw: 2.52, pitch: -.20, zoom: 2700, panX: 0, panY: 0, cameraX: 0, cameraZ: 0, cameraZoom: 2700, cameraSpeed: 0 };
const view = { ...defaultView };

// Drawing scale: the look was tuned at 1280 px wide; keep it the same at any canvas size.
export const scale = () => canvas.width / 1280;

function fitCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; ui.width = w; ui.height = h; draw(); }
}
new ResizeObserver(fitCanvas).observe(canvas);

function renderedRoot() {
  const { root, animation, frame } = state;
  if (!animation || !root) return [0, 0, 0];
  const at = frame * 3, next = ((frame + 1) % animation.frames) * 3, b = frame >= animation.frames - 1 ? 0 : playbackBlend;   // no blend from the last frame back to the first
  return [root[at] * (1 - b) + root[next] * b, root[at + 1] * (1 - b) + root[next + 1] * b, root[at + 2] * (1 - b) + root[next + 2] * b];
}
function snapCamera() {
  const [x, , z] = renderedRoot();
  view.cameraX = x; view.cameraZ = z; view.cameraZoom = view.zoom; view.cameraSpeed = 0;
  cameraLast = performance.now();
}
export function resetView() { Object.assign(view, defaultView); snapCamera(); draw(); }

function updateCamera(now) {
  const { root, animation, frame, playing } = state;
  if (!animation || !root) return;
  if (!trails.follow) { cameraLast = now; return; }
  const dt = Math.min(.1, Math.max(0, (now - cameraLast) / 1000));
  cameraLast = now;
  const at = frame * 3, next = ((frame + 1) % animation.frames) * 3, [rootX, , rootZ] = renderedRoot();
  const speed = playing ? Math.hypot(root[next] - root[at], root[next + 2] - root[at + 2]) * 30 : 0;
  const dx = rootX - view.cameraX, dz = rootZ - view.cameraZ, distance = Math.hypot(dx, dz), deadZone = .18;
  const targetX = distance > deadZone ? rootX - dx / distance * deadZone : view.cameraX;
  const targetZ = distance > deadZone ? rootZ - dz / distance * deadZone : view.cameraZ;
  const follow = 1 - Math.exp(-3 * dt), speedFollow = 1 - Math.exp(-2.4 * dt), zoomFollow = 1 - Math.exp(-2.6 * dt);
  view.cameraSpeed += (speed - view.cameraSpeed) * speedFollow;
  const targetZoom = view.zoom * (1 - Math.min(.22, view.cameraSpeed * .035));
  view.cameraX += (targetX - view.cameraX) * follow;
  view.cameraZ += (targetZ - view.cameraZ) * follow;
  view.cameraZoom += (targetZoom - view.cameraZoom) * zoomFollow;
}

export function rotate(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v, tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export function multiply(a, b) {
  const [x, y, z, w] = a, [X, Y, Z, W] = b;
  return [x * W + w * X + y * Z - z * Y, y * W + w * Y + z * X - x * Z, z * W + w * Z + x * Y - y * X, w * W - x * X - y * Y - z * Z];
}

const frameListeners = [], drawListeners = [];
export function onFrameChange(fn) { frameListeners.push(fn); }
export function onDraw(fn) { drawListeners.push(fn); }
export function getView() { return { ...view }; }
// For inspection scripts (videos for judging): a still camera on the whole clip — centred on the hips' path, zoomed so
// the path and the body fit (the follow camera trails by ~0.3 s, and a capture that steps frames slower than real time
// drives it by the wall clock). Turn follow off first (setTrails({ follow: false })).
// For inspection scripts: the camera exactly on the hips this frame (no lag; follow off so the clock does not move it).
export function lockCameraOnHips() { snapCamera(); draw(); }
export function frameWholeClip() {
  const { root, animation } = state; if (!animation || !root) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let f = 0; f < animation.frames; f++) { const x = root[f * 3], z = root[f * 3 + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const span = Math.max(x1 - x0, z1 - z0);
  view.cameraX = (x0 + x1) / 2; view.cameraZ = (z0 + z1) / 2; view.cameraSpeed = 0;
  view.cameraZoom = view.zoom * Math.min(1, 2.2 / (span + 2.2));
  cameraLast = performance.now(); draw();
}
export function rootPosition() { return state.animation && state.root ? (state.override && state.override.frame === state.frame ? [...state.override.root] : renderedRoot()) : null; }
// World rotation of every joint at the current frame (the override's when on this frame).
// A filter over the clip's parent-local rotations as the stage reads them
// (wrist clean-up previews through it). Identity when nothing is registered.
let localFilter = null;
export function setLocalFilter(fn) { localFilter = fn; allPositions = null; draw(); }
function localAt(frame, j) {
  const q = Array.from(state.rotations.subarray((frame * parents.length + j) * 4, (frame * parents.length + j + 1) * 4));
  return localFilter ? localFilter(frame, j, q) : q;
}
// The joint as drawn: during playback blended toward the next frame by the same amount as the hips. (Blending only
// the hips moved the body between frames while the legs held the last pose: planted feet sawed back and forth.)
function drawnLocal(frame, j) {
  const q = localAt(frame, j), b = playbackBlend, last = state.animation.frames - 1;
  if (!(b > 0) || frame >= last) return q;
  const r = localAt(frame + 1, j);
  let d = q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3];
  const s = d < 0 ? -1 : 1; d = Math.abs(d);
  let a, c;
  if (d > 0.9995) { a = 1 - b; c = b * s; }
  else { const th = Math.acos(d), sn = Math.sin(th); a = Math.sin((1 - b) * th) / sn; c = Math.sin(b * th) / sn * s; }
  const o = [q[0] * a + r[0] * c, q[1] * a + r[1] * c, q[2] * a + r[2] * c, q[3] * a + r[3] * c];
  const n = Math.hypot(...o); return o.map(x => x / n);
}
export function globalRotations() {
  const { animation, rotations, frame, override } = state;
  if (!animation || !rotations) return null;
  const useOverride = override && override.frame === frame, joints = parents.length, global = [];
  for (let j = 0; j < joints; j++) {
    const q = useOverride ? override.rotations[j] : drawnLocal(frame, j), p = parents[j];
    global[j] = p < 0 ? q : multiply(global[p], q);
  }
  return global;
}
// Joint positions of any frame of the clip, straight from the streams (no override, no scaling).
export function positionsAt(f) {
  const { animation, root, rotations } = state;
  if (!animation || !root || !rotations) return null;
  f = Math.max(0, Math.min(animation.frames - 1, f));
  const positions = [], global = [], joints = parents.length;
  for (let j = 0; j < joints; j++) {
    const q = localAt(f, j), p = parents[j];
    if (p < 0) { global[j] = q; positions[j] = [root[f * 3], root[f * 3 + 1], root[f * 3 + 2]]; }
    else { global[j] = multiply(global[p], q); positions[j] = add(positions[p], rotate(global[p], offsets[j])); }
  }
  return positions;
}
// When a character is shown, the stick figure steps back unless asked for.
let characterShown = false, skeletonOverCharacter = false;
export function setCharacterShown(shown, skeleton) { characterShown = shown; skeletonOverCharacter = skeleton; }
// A body can offer its own joint positions (one per clip joint, same order) and finger segments for the X-ray figure.
let bodySkeleton = null;
export function setBodySkeleton(fn) { bodySkeleton = fn; }
let lastSeenFrame = -1;
export function setOverride(o) { state.override = o; }

// World position of every joint at the current frame (the override's pose when it is on this frame).
export function pose(original = false) {
  const { animation, root, rotations, frame, override } = state;
  if (!animation || !root || !rotations) return [];
  const useOverride = !original && override && override.frame === frame;
  const positions = [], global = [], rootPosition = useOverride ? override.root : renderedRoot(), joints = parents.length;
  for (let j = 0; j < joints; j++) {
    const q = useOverride ? override.rotations[j] : drawnLocal(frame, j), p = parents[j];
    if (p < 0) { global[j] = q; positions[j] = rootPosition; }
    else { global[j] = multiply(global[p], q); positions[j] = add(positions[p], rotate(global[p], offsets[j])); }
  }
  return positions;
}

// Where the floor under the camera's target sits on the screen: 78% of the way down, lifted while a tool bar floats over
// the bottom of the stage (setLift, eased) so the figure's feet stay clear of it.
let lift = 0, liftTarget = 0, liftRaf = 0;
function anchorY() { return canvas.height * .78 - lift; }
export const anchorFrac = () => anchorY() / (canvas.height || 1);
// while lifted the view also zooms out by the share of the stage the bar took, so the figure's head stays in view on a
// short window (at 900 px tall the lift pushed the head off the top)
export const liftScale = () => canvas.height ? Math.max(0.5, 1 - lift / canvas.height) : 1;
// Side room: the figure's anchor moves left of centre while a panel floats over the stage's right (the Checks card
// covered half the figure at 1440 px wide). Eased like the lift.
let room = 0, roomTarget = 0, roomRaf = 0;
function anchorX() { return canvas.width / 2 - room; }
export const figureTiny = () => { const hs = handleSource(); if (hs.length < 3) return false; const ys = hs.map(h => project(h.world)[1]); return Math.max(...ys) - Math.min(...ys) < 120 * scale(); };
export const anchorXFrac = () => anchorX() / (canvas.width || 1);
export function setSideRoom(cssPx) {
  const k = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
  roomTarget = Math.max(0, Math.min(canvas.width * .3, cssPx * k));
  if (roomRaf) return;
  const step = () => { const d = roomTarget - room; room = Math.abs(d) < 0.5 ? roomTarget : room + d * 0.25; draw(); roomRaf = room === roomTarget ? 0 : requestAnimationFrame(step); };
  roomRaf = requestAnimationFrame(step);
}
export function setLift(cssPx) {
  const k = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
  liftTarget = Math.max(0, Math.min(canvas.height * .3, cssPx * k));
  if (liftRaf) return;
  const step = () => { const d = liftTarget - lift; lift = Math.abs(d) < 0.5 ? liftTarget : lift + d * 0.25; draw(); liftRaf = lift === liftTarget ? 0 : requestAnimationFrame(step); };
  liftRaf = requestAnimationFrame(step);
}
function cameraSpace([x, y, z]) {
  x -= view.cameraX; z -= view.cameraZ;
  // screen-right is -rx before the sign: without it the stage drew the world mirror-imaged (a right-leg kick read
  // as a left-leg kick); syncCamera in character.js applies the same flip to the 3D view
  const rx = -(x * Math.cos(view.yaw) - z * Math.sin(view.yaw)), rz = x * Math.sin(view.yaw) + z * Math.cos(view.yaw);
  const ry = y * Math.cos(view.pitch) - rz * Math.sin(view.pitch), dz = y * Math.sin(view.pitch) + rz * Math.cos(view.pitch) + 8;
  return [rx, ry, dz];
}
function projectCamera(rx, ry, dz) {
  const s = scale(), zoom = view.cameraZoom * s * liftScale();
  return [anchorX() + view.panX * s + zoom * rx / dz, anchorY() + view.panY * s - zoom * ry / dz];
}
export function project(p) {
  const [rx, ry, dz] = cameraSpace(p);
  return projectCamera(rx, ry, dz);
}
// A world segment clipped at the near plane, as two screen points (null when it is all behind the camera).
function clipSegment(a, b, near = .12) {
  let [ax, ay, az] = cameraSpace(a), [bx, by, bz] = cameraSpace(b);
  if (az < near && bz < near) return null;
  if (az < near) { const t = (near - az) / (bz - az); ax += (bx - ax) * t; ay += (by - ay) * t; az = near; }
  else if (bz < near) { const t = (near - bz) / (az - bz); bx += (ax - bx) * t; by += (ay - by) * t; bz = near; }
  return [projectCamera(ax, ay, az), projectCamera(bx, by, bz)];
}
export function depthOf(p) { return cameraSpace(p)[2]; }
// Screen point back to the world at a camera depth (the plane facing the camera).
export function unproject(sx, sy, dz) {
  if (!(dz > .05)) return null;
  const s = scale(), zoom = view.cameraZoom * s * liftScale();
  const rx = -(sx - anchorX() - view.panX * s) * dz / zoom, ry = -(sy - anchorY() - view.panY * s) * dz / zoom, d = dz - 8;   // un-mirrored (see cameraSpace)
  const y = ry * Math.cos(view.pitch) + d * Math.sin(view.pitch), rz = -ry * Math.sin(view.pitch) + d * Math.cos(view.pitch);
  return [rx * Math.cos(view.yaw) + rz * Math.sin(view.yaw) + view.cameraX, y, -rx * Math.sin(view.yaw) + rz * Math.cos(view.yaw) + view.cameraZ];
}
// Screen point back to the world on the horizontal plane at height y0.
export function unprojectOnGround(sx, sy, y0) {
  const s = scale(), zoom = view.cameraZoom * s * liftScale(), k = -(sy - anchorY() - view.panY * s) / zoom;
  const denom = Math.sin(view.pitch) + k * Math.cos(view.pitch);
  if (Math.abs(denom) < 1e-4) return null;
  const dz = (y0 + 8 * Math.sin(view.pitch)) / denom;
  const p = unproject(sx, sy, dz);
  if (p) p[1] = y0;
  return p;
}

// The stage backdrop: a calm grey studio. A soft sky above the horizon, a darker floor
// below it carrying a metre grid (fine lines every 0.5 m, strong lines every 2 m, the
// world axes a shade warmer and cooler) that fades into the horizon haze. The grid
// travels with the camera so the floor never runs out.
const stageColours = { skyTop: '#4b4c51', skyHorizon: '#86878d', floorFar: '#75767c', floorNear: '#46474c', fine: '#a2a3aa', strong: '#c8c9cf', axisX: '#d08a8e', axisZ: '#8aa6d0' };
function horizonY() { return anchorY() + view.panY * scale() + view.cameraZoom * scale() * liftScale() * Math.tan(view.pitch); }
// The clip's own floor: where the balls of its feet rest (5th percentile of the toe joints over the clip). Kimodo
// clips often stand a centimetre or two above y = 0, so the grid and the shadow are drawn here, not at zero.
function clipFloor() {
  // the server's floor (where planted toes stand), so the stage, the checks and Clean up agree on it
  const m = state.animation?.metrics; if (m && m.v >= 20 && typeof m.floor_y === 'number') return m.floor_y;
  if (!allPositions?.length) return 0;
  const toes = jointNames.map((n, j) => /toe/i.test(n) ? j : -1).filter(j => j >= 0);
  const feet = toes.length ? toes : jointNames.map((n, j) => /foot|ankle/i.test(n) ? j : -1).filter(j => j >= 0);
  if (!feet.length) return 0;
  const hs = []; for (const p of allPositions) for (const j of feet) hs.push(p[j][1]);
  hs.sort((a, b) => a - b);
  return Math.max(-0.1, Math.min(0.1, hs[Math.floor(hs.length / 20)]));
}
function ground() {
  const s = scale(), W = canvas.width, H = canvas.height, hy = horizonY();
  const FY = state.floorY || 0;
  const fromAbove = view.pitch < 0; // camera above the floor: the floor is everything under the horizon
  // Sky and floor.
  const sky = ctx.createLinearGradient(0, hy - H * .9, 0, hy);
  sky.addColorStop(0, stageColours.skyTop); sky.addColorStop(1, stageColours.skyHorizon);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
  const floor = ctx.createLinearGradient(0, hy, 0, hy + (fromAbove ? 1 : -1) * H * .85);
  floor.addColorStop(0, stageColours.floorFar); floor.addColorStop(1, stageColours.floorNear);
  ctx.fillStyle = floor;
  if (fromAbove) ctx.fillRect(0, Math.max(0, hy), W, H); else ctx.fillRect(0, 0, W, Math.min(H, hy));
  // Grid lines, clipped at the camera so long lines never fold over.
  const line = (a, b) => { const seg = clipSegment(a, b); if (!seg) return; ctx.beginPath(); ctx.moveTo(seg[0][0], seg[0][1]); ctx.lineTo(seg[1][0], seg[1][1]); ctx.stroke(); };
  const strongStep = 2, fineStep = .5, reach = 40, fineReach = 14;
  const cx = Math.round(view.cameraX / strongStep) * strongStep, cz = Math.round(view.cameraZ / strongStep) * strongStep;
  ctx.lineCap = 'butt';
  ctx.globalAlpha = .55; ctx.strokeStyle = stageColours.fine; ctx.lineWidth = Math.max(1, .9 * s);
  for (let i = -fineReach / fineStep; i <= fineReach / fineStep; i++) {
    const v = i * fineStep;
    if (Math.abs((v + cx) / strongStep - Math.round((v + cx) / strongStep)) < 1e-6) { /* a strong line, drawn below */ } else line([cx - fineReach, FY, cz + v], [cx + fineReach, FY, cz + v]);
    if (Math.abs((v + cz) / strongStep - Math.round((v + cz) / strongStep)) < 1e-6) { /* ditto */ } else line([cx + v, FY, cz - fineReach], [cx + v, FY, cz + fineReach]);
  }
  ctx.globalAlpha = .8; ctx.strokeStyle = stageColours.strong; ctx.lineWidth = Math.max(1.2, 1.6 * s);
  for (let i = -reach / strongStep; i <= reach / strongStep; i++) {
    const v = i * strongStep;
    if (cz + v !== 0) line([cx - reach, FY, cz + v], [cx + reach, FY, cz + v]);
    if (cx + v !== 0) line([cx + v, FY, cz - reach], [cx + v, FY, cz + reach]);
  }
  ctx.globalAlpha = .85; ctx.lineWidth = Math.max(1.5, 2.2 * s);
  ctx.strokeStyle = stageColours.axisX; line([-reach, FY, 0], [reach, FY, 0]);
  ctx.strokeStyle = stageColours.axisZ; line([0, FY, -reach], [0, FY, reach]);
  // Haze: the floor and its lines dissolve into the horizon.
  const haze = ctx.createLinearGradient(0, hy, 0, hy + (fromAbove ? 1 : -1) * H * .34);
  haze.addColorStop(0, stageColours.skyHorizon); haze.addColorStop(.35, stageColours.floorFar + 'b0'); haze.addColorStop(1, stageColours.floorFar + '00');
  ctx.globalAlpha = 1; ctx.fillStyle = haze;
  if (fromAbove) ctx.fillRect(0, Math.max(0, hy - 1), W, H); else ctx.fillRect(0, 0, W, Math.min(H, hy + 1));
  // A hairline where the floor meets the sky.
  ctx.globalAlpha = .35; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, Math.round(hy) + .5); ctx.lineTo(W, Math.round(hy) + .5); ctx.stroke();
  ctx.globalAlpha = 1;
}

// Body view: capsules around the bones (radii as the self-clip check uses).
let showBody = localStorage.getItem('understudy.body') === 'on';
const bodyButton = document.querySelector('#body');
export function setBody(on) { showBody = on; bodyButton.classList.toggle('on', on); localStorage.setItem('understudy.body', on ? 'on' : 'off'); draw(); }
export function isBodyShown() { return showBody; }
export function boneRadiusOf(name) { return boneRadius(name); }
bodyButton.onclick = () => setBody(!showBody);
bodyButton.classList.toggle('on', showBody);
function boneRadius(name) {
  const n = name.toLowerCase();
  if (n.includes('hand')) return .03;
  if (n.includes('forearm') || n.includes('elbow')) return .04;
  if (n.includes('arm') || n.includes('shoulder')) return .05;
  if (n.includes('shin') || n.includes('knee')) return .055;
  if (n.includes('leg') || n.includes('hip')) return .075;
  if (n.includes('toe') || n.includes('foot') || n.includes('ankle')) return .04;
  if (n.includes('head') || n.includes('neck') || n.includes('eye') || n.includes('jaw')) return .07;
  if (n.includes('spine') || n.includes('chest') || n.includes('hips')) return .12;
  return .04;
}
function drawBody(p, colour = 'rgba(255, 140, 130, .55)') {
  const s = scale();
  for (let i = 1; i < parents.length; i++) {
    const a = p[i], b = p[parents[i]];
    const [, , dz] = cameraSpace([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    const r = Math.min(boneRadius(jointNames[i] || ''), boneRadius(jointNames[parents[i]] || '')) * view.cameraZoom * s / Math.max(.2, dz);
    const pa = project(a), pb = project(b);
    ctx.strokeStyle = colour; ctx.lineWidth = Math.max(2, 2 * r); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
  }
}

// Ghost: a second clip drawn faintly at the same frame, for comparing takes.
export const ghost = { animation: null, root: null, rotations: null, parents: null, offsets: null, align: true, offset: [0, 0, 0] };
export async function setGhost(animation, skeleton) {
  if (!animation) { ghost.animation = null; draw(); return; }
  const [root, rotations] = await Promise.all([
    fetch(`/api/animations/${animation.id}/root.f32`).then(r => r.arrayBuffer()).then(b => new Float32Array(b)),
    fetch(`/api/animations/${animation.id}/rotations.f32`).then(r => r.arrayBuffer()).then(b => new Float32Array(b)),
  ]);
  Object.assign(ghost, { animation, root, rotations, parents: skeleton?.parents || parents, offsets: skeleton?.offsets || offsets });
  alignGhost(); draw();
}
export function alignGhost() {
  const { root } = state;
  if (!ghost.root || !root) { ghost.offset = [0, 0, 0]; return; }
  if (ghost.align === 'none' || ghost.align === false) ghost.offset = [0, 0, 0];
  else if (ghost.align === 'side') ghost.offset = [root[0] - ghost.root[0] + 1, 0, root[2] - ghost.root[2]];
  else ghost.offset = [root[0] - ghost.root[0], 0, root[2] - ghost.root[2]];
}
// Other actors of the scene (scene.js): clips placed in the stage clip's space,
// drawn in their own colours, each with a frame offset.
export const extras = [];
const streamCache = new Map();
export function streamsOf(animation) {
  const k = `${animation.id}:${animation.edits || 0}`;
  if (!streamCache.has(k)) streamCache.set(k, Promise.all([
    fetch(`/api/animations/${animation.id}/root.f32`).then(r => r.arrayBuffer()).then(b => new Float32Array(b)),
    fetch(`/api/animations/${animation.id}/rotations.f32`).then(r => r.arrayBuffer()).then(b => new Float32Array(b)),
  ]).then(([root, rotations]) => ({ root, rotations })));
  return streamCache.get(k);
}
export async function setExtras(items) {
  const out = [];
  for (const e of items) { const st = await streamsOf(e.animation); out.push({ ...e, root: st.root, rotations: st.rotations, parents: e.skeleton?.parents || parents, offsets: e.skeleton?.offsets || offsets }); }
  extras.length = 0; extras.push(...out); draw();
}
function extraPose(e) {
  const n = e.animation.frames, f = Math.max(0, Math.min(n - 1, state.frame - (e.frameOffset || 0))), joints = e.parents.length;
  const r = (e.yaw || 0) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  const place = p => [p[0] * c + p[2] * sn + (e.x || 0), p[1], -p[0] * sn + p[2] * c + (e.z || 0)];
  const positions = [], global = [];
  for (let j = 0; j < joints; j++) {
    const q = Array.from(e.rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)), p = e.parents[j];
    if (p < 0) { global[j] = q; positions[j] = [e.root[f * 3], e.root[f * 3 + 1], e.root[f * 3 + 2]]; }
    else { global[j] = multiply(global[p], q); positions[j] = add(positions[p], rotate(global[p], e.offsets[j])); }
  }
  return positions.map(place);
}
// Onion skin: faint poses at other frames of the clip.
let onion = localStorage.getItem('understudy.onion') || 'off';
export function setOnion(v) { onion = v; localStorage.setItem('understudy.onion', v); draw(); }
function drawOnion(s) {
  if (onion === 'off' || !state.animation) return;
  let frames = [];
  if (onion === 'near') { for (let d = -12; d <= 12; d += 4) if (d) frames.push(state.frame + d); }
  else { const set = new Set(); for (const c of state.animation.constraints || []) for (const f of c.frame_indices || []) set.add(f); for (const m of state.animation.markers || []) set.add(m.frame); for (const k of state.animation.layer?.keys || []) set.add(k.frame); frames = [...set]; }
  for (const f of frames) {
    if (f < 0 || f >= state.animation.frames || f === state.frame) continue;
    const p = positionsAt(f), dist = Math.abs(f - state.frame);
    ctx.globalAlpha = onion === 'near' ? Math.max(.08, .32 - dist * .02) : .18;
    ctx.strokeStyle = f < state.frame ? '#9ff0ff' : '#ffd27f'; ctx.lineWidth = 3 * s; ctx.lineCap = 'round';
    for (let i = 1; i < parents.length; i++) { const a = project(p[i]), b = project(p[parents[i]]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
}
// Everything character.js needs to pose a body from an extra actor: global rotations
// (turned by the actor's yaw), the placed root, the placed joint positions, the frame.
export function extraSource(e) { return extraSourceAt(e, Math.max(0, Math.min(e.animation.frames - 1, state.frame - (e.frameOffset || 0)))); }
export function extraSourceAt(e, f) {
  const joints = e.parents.length;
  const r = (e.yaw || 0) * Math.PI / 180, yawQ = [0, Math.sin(r / 2), 0, Math.cos(r / 2)];
  const c = Math.cos(r), sn = Math.sin(r);
  const place = p => [p[0] * c + p[2] * sn + (e.x || 0), p[1], -p[0] * sn + p[2] * c + (e.z || 0)];
  const globals = [], positions = [];
  for (let j = 0; j < joints; j++) {
    const q = Array.from(e.rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)), p = e.parents[j];
    if (p < 0) { globals[j] = multiply(yawQ, q); positions[j] = [e.root[f * 3], e.root[f * 3 + 1], e.root[f * 3 + 2]]; }
    else { globals[j] = multiply(globals[p], q); positions[j] = add(positions[p], rotate(multiply(yawQ, globalOf(e, f, p, joints)), e.offsets[j])); }
  }
  // positions above used unrotated parents for the chain; recompute them from the rotated globals for exactness
  const pos2 = [];
  for (let j = 0; j < joints; j++) { const p = e.parents[j]; pos2[j] = p < 0 ? place([e.root[f * 3], e.root[f * 3 + 1], e.root[f * 3 + 2]]) : add(pos2[p], rotate(globals[p], e.offsets[j])); }
  return { globals, root: pos2[0], pose: pos2, frame: f, rotations: e.rotations, animation: e.animation, skeleton: { names: jointNames, parents: e.parents, offsets: e.offsets } };
}
function globalOf(e, f, j, joints) { // unrotated global of joint j at frame f
  const chain = []; for (let k = j; k >= 0; k = e.parents[k]) chain.unshift(k);
  let g = null; for (const k of chain) { const q = Array.from(e.rotations.subarray((f * joints + k) * 4, (f * joints + k + 1) * 4)); g = g ? multiply(g, q) : q; }
  return g;
}
let extraBodyShown = () => false;
export function setExtraBodyCheck(fn) { extraBodyShown = fn; }
function drawExtras(s) {
  for (const e of extras) {
    if (extraBodyShown(e.label) && !skeletonOverCharacter) { const g0 = extraPose(e), top = g0.reduce((m, p) => p[1] > m[1] ? p : m, g0[0]), t = project(top); ctx.fillStyle = e.colour; ctx.font = `${Math.round(11 * s)}px "JetBrains Mono", monospace`; ctx.textAlign = 'center'; ctx.fillText(e.label || '', t[0], t[1] - 14 * s); ctx.textAlign = 'start'; continue; }
    const g = extraPose(e);
    ctx.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? e.colour : 'rgba(0,0,0,.6)'; ctx.lineWidth = (pass ? 5 : 9) * s;
      for (let i = 1; i < e.parents.length; i++) { const a = project(g[i]), b = project(g[e.parents[i]]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    }
    ctx.fillStyle = e.colour;
    for (const j of g) { const a = project(j); ctx.beginPath(); ctx.arc(a[0], a[1], 3 * s, 0, Math.PI * 2); ctx.fill(); }
    const top = g.reduce((m, p) => p[1] > m[1] ? p : m, g[0]), t = project(top);
    ctx.font = `${Math.round(11 * s)}px "JetBrains Mono", monospace`; ctx.textAlign = 'center'; ctx.fillText(e.label || '', t[0], t[1] - 14 * s); ctx.textAlign = 'start';
  }
}
// Proportion preview: scale the drawn skeleton about the root.
let bodyScale = 1;
export function setBodyScale(v) { bodyScale = v; draw(); }
function scaled(p) {
  if (bodyScale === 1 || !p.length) return p;
  const r = p[0];
  return p.map(j => [r[0] + (j[0] - r[0]) * bodyScale, j[1] * bodyScale, r[2] + (j[2] - r[2]) * bodyScale]);
}
// A prop held in a hand: a stick along the hand bone's direction.
let prop = { kind: '', length: 0, hand: 'rhand' };
export function setProp(kind, length, hand) { prop = { kind, length, hand }; draw(); }
function drawProp(p) {
  if (!prop.kind) return;
  const j = trailJoints[prop.hand]; if (j == null) return;
  const parent = parents[j]; if (parent < 0) return;
  const h = p[j], e = p[parent];
  const d = [h[0] - e[0], h[1] - e[1], h[2] - e[2]], l = Math.hypot(...d) || 1;
  const tip = [h[0] + d[0] / l * prop.length, h[1] + d[1] / l * prop.length, h[2] + d[2] / l * prop.length];
  const back = [h[0] - d[0] / l * prop.length * .15, h[1] - d[1] / l * prop.length * .15, h[2] - d[2] / l * prop.length * .15];
  const a = project(back), b = project(tip), s = scale();
  ctx.strokeStyle = '#ffd27f'; ctx.lineWidth = (prop.kind === 'staff' ? 5 : 7) * s; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}
function ghostPose() {
  if (!ghost.animation || !ghost.root) return [];
  const f = Math.min(state.frame, ghost.animation.frames - 1), joints = ghost.parents.length;
  const positions = [], global = [];
  for (let j = 0; j < joints; j++) {
    const q = Array.from(ghost.rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)), p = ghost.parents[j];
    if (p < 0) { global[j] = q; positions[j] = [ghost.root[f * 3] + ghost.offset[0], ghost.root[f * 3 + 1], ghost.root[f * 3 + 2] + ghost.offset[2]]; }
    else { global[j] = multiply(global[p], q); positions[j] = add(positions[p], rotate(global[p], ghost.offsets[j])); }
  }
  return positions;
}

// The drawn path (path.js): one stroke per prompt segment, numbered, and pose pins.
let pathOverlay = null; // { strokes: [{points}], pins: [{x, z, label}] } or a plain point list
export function setPathOverlay(data) { pathOverlay = data; }
function drawPathOverlay() {
  if (!pathOverlay) return;
  const s = scale();
  const strokes = Array.isArray(pathOverlay) ? [{ points: pathOverlay }] : pathOverlay.strokes || [];
  const colours = ['#7fd0ff', '#8fe3a2', '#ffd27f', '#ff9ad5'];
  strokes.forEach((stroke, i) => {
    const pts = stroke.points; if (!pts.length) return;
    ctx.globalAlpha = .95; ctx.strokeStyle = colours[i % colours.length]; ctx.lineWidth = 3 * s; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach((p, k) => { const q = project(p); k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]); }); ctx.stroke();
    const start = project(pts[0]); ctx.fillStyle = colours[i % colours.length];
    ctx.beginPath(); ctx.arc(start[0], start[1], 6 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000'; ctx.font = `bold ${Math.round(10 * s)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), start[0], start[1]);
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'start';
  });
  for (const pin of pathOverlay.pins || []) {
    const q = project([pin.x, 0, pin.z]), top = project([pin.x, .25, pin.z]);
    ctx.globalAlpha = 1; ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(top[0], top[1]); ctx.stroke();
    ctx.fillStyle = '#ffd700'; ctx.beginPath(); ctx.arc(top[0], top[1], 5 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = `${Math.round(11 * s)}px sans-serif`; ctx.fillText(pin.label, top[0] + 8 * s, top[1] + 4 * s);
  }
  ctx.globalAlpha = 1;
}

// Points (point.js): a tennis ball where the next clip must touch, with its shadow on the ground and a dashed stem
// when it floats; the selected one ringed.
let pointOverlay = [];   // [{ pos: [x, y, z], label, selected }]
export function setPointOverlay(list) { pointOverlay = list || []; }
export function pointsOf() { return pointOverlay; }   // the body layer draws them as balls too (it covers this canvas)
function drawPointOverlay() {
  if (!pointOverlay.length) return;
  const s = scale();
  for (const pt of pointOverlay) {
    const [x, y, z] = pt.pos, g = project([x, 0.02, z]), c = project([x, y, z]), r = (pt.selected ? 10 : 8) * s;
    ctx.globalAlpha = .35; ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(g[0], g[1], r * 1.1, r * .45, 0, 0, Math.PI * 2); ctx.fill();
    if (y > 0.06) { ctx.globalAlpha = .8; ctx.strokeStyle = '#d7f24a'; ctx.lineWidth = 1.5 * s; ctx.setLineDash([4 * s, 4 * s]); ctx.beginPath(); ctx.moveTo(g[0], g[1]); ctx.lineTo(c[0], c[1]); ctx.stroke(); ctx.setLineDash([]); }
    ctx.globalAlpha = 1; ctx.fillStyle = '#d7f24a'; ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f7ffe0'; ctx.lineWidth = 1.5 * s;
    ctx.beginPath(); ctx.arc(c[0] - r * .95, c[1], r * .8, -.85, .85); ctx.stroke();
    ctx.beginPath(); ctx.arc(c[0] + r * .95, c[1], r * .8, Math.PI - .85, Math.PI + .85); ctx.stroke();
    if (pt.selected) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 * s; ctx.beginPath(); ctx.arc(c[0], c[1], r + 3 * s, 0, Math.PI * 2); ctx.stroke(); }
    if (pt.label) { ctx.fillStyle = '#d7f24a'; ctx.font = `${Math.round(11 * s)}px sans-serif`; ctx.fillText(pt.label, c[0] + r + 5 * s, c[1] + 4 * s); }
  }
  ctx.globalAlpha = 1;
}

// Nearest drawn trail dot to a stage point: { joint, frame } within `radius` px, or null.
export function trailHit(sx, sy, radius = 10) {
  if (!trails.on || !allPositions || !state.animation) return null;
  const s = scale(); let best = null, bd = radius * s;
  for (const key of ['lhand', 'rhand', 'lfoot', 'rfoot']) {
    if (!trails[key]) continue;
    const j = trailJoints[key]; if (j == null) continue;
    const from = Math.max(0, state.frame - TRAIL_WINDOW), to = Math.min(allPositions.length - 1, state.frame + TRAIL_WINDOW);
    for (let f = from; f <= to; f += 1) { // only the drawn part of the path can be picked
      const p = project(allPositions[f][j]); const d = Math.hypot(p[0] - sx, p[1] - sy);
      if (d < bd) { bd = d; best = { joint: key, frame: f }; }
    }
  }
  return best;
}
let handleSource = () => [];
export function setHandleSource(fn) { handleSource = fn; }
// rotation rings (handles.js, Turn mode): [{ color, points: [[x,y,z]...], width }] drawn as closed outlines
let gizmoSource = () => [];
export function setGizmoSource(fn) { gizmoSource = fn; }
let handleLabels = localStorage.getItem('understudy.handleLabels') !== 'off';
export function setHandleLabels(on) { handleLabels = on; localStorage.setItem('understudy.handleLabels', on ? 'on' : 'off'); draw(); }
export function handleLabelsShown() { return handleLabels; }
export function figureSpanPx() {
  const pts = scaled(pose());
  if (pts.length < 3) return 260;
  const ys = pts.map(pt => project(pt)[1]);
  return (Math.max(...ys) - Math.min(...ys)) / (scale() || 1);
}
let uiWasActive = false;
function drawHandles() {
  const s = scale();
  const ghostOnUi = !!(ghost.animation && (characterShown || showBody));
  const gizmos = gizmoSource(), hs = handleSource();
  const uiActive = ghostOnUi || gizmos.length > 0 || hs.length > 0;
  if (!uiActive) {
    if (uiWasActive) { ui.width = ui.width; uiCtx.clearRect(0, 0, ui.width, ui.height); uiWasActive = false; }
    if (ui.style.visibility !== 'hidden') ui.style.visibility = 'hidden';
    return;
  }
  uiWasActive = true;
  if (ui.style.visibility === 'hidden') ui.style.visibility = '';
  if (!ghostOnUi) uiCtx.clearRect(0, 0, ui.width, ui.height);
  const ringMap = new Map();
  uiCtx.lineCap = 'round'; uiCtx.lineJoin = 'round';
  for (const g of gizmos) {
    const qs = g.points.map(pt => project(pt));
    if (!qs.length) continue;
    const lw = (g.width ?? (g.hot ? 3.8 : 2.2)) * s;
    if (g.halo) {
      uiCtx.globalAlpha = (g.alpha ?? 1) * .55; uiCtx.strokeStyle = 'rgba(10, 10, 12, .9)'; uiCtx.lineWidth = lw + 2.6 * s;
      uiCtx.beginPath(); qs.forEach((q, i) => { i ? uiCtx.lineTo(q[0], q[1]) : uiCtx.moveTo(q[0], q[1]); }); if (!g.open) uiCtx.closePath(); uiCtx.stroke();
    }
    uiCtx.globalAlpha = g.alpha ?? (g.hot ? 1 : .85); uiCtx.strokeStyle = g.color; uiCtx.lineWidth = lw;
    uiCtx.beginPath(); qs.forEach((q, i) => { i ? uiCtx.lineTo(q[0], q[1]) : uiCtx.moveTo(q[0], q[1]); }); if (!g.open) uiCtx.closePath(); uiCtx.stroke();
    if (g.center && qs.length) {
      const c = project(g.center), key = `${Math.round(c[0])},${Math.round(c[1])}`;
      let box = ringMap.get(key);
      if (!box) { box = { cx: c[0], cy: c[1], r: 0, x0: c[0], y0: c[1], x1: c[0], y1: c[1] }; ringMap.set(key, box); }
      for (const q of qs) {
        box.r = Math.max(box.r, Math.hypot(q[0] - c[0], q[1] - c[1]));
        box.x0 = Math.min(box.x0, q[0]); box.y0 = Math.min(box.y0, q[1]);
        box.x1 = Math.max(box.x1, q[0]); box.y1 = Math.max(box.y1, q[1]);
      }
    }
  }
  const ringBoxes = [...ringMap.values()];
  uiCtx.globalAlpha = 1;
  const labels = [];
  // dots scale and declutter with how big the figure is on screen so zoomed-out figures never turn into a blob
  const spanPx = figureSpanPx();
  const zoomK = Math.max(0.32, Math.min(1, spanPx / 290));
  const tiny = hs.length > 2 && spanPx < 105;
  // the far side of the body: those dots are drawn faint, so front and back (left and right) read apart
  const ds = hs.map(h => depthOf(h.world)), dMid = ds.length ? [...ds].sort((a, b) => a - b)[ds.length >> 1] : 0;
  hs.forEach((h, i) => { h._far = ds[i] > dMid + 0.06; });
  for (const h of hs) {
    const activeLabel = !!(h.hovered || h.selected || h.dragging);
    if (tiny && !activeLabel && !h.moved) continue;
    const turn = h.kind === 'turn';
    if (turn && h.minor && spanPx < 210 && !activeLabel && !h.moved) continue;
    const p = project(h.world);
    if (h.kind !== 'doll') {
      const secondary = !turn && (h.kind === 'pole' || h.kind === 'look');
      const inRing = turn && !activeLabel && !h.moved && ringBoxes.some(q => Math.hypot(p[0] - q.cx, p[1] - q.cy) < q.r + 9 * s);
      let alpha = h._far && !activeLabel ? .34 : 1;
      if (secondary && !activeLabel && !h.moved) alpha *= .58;
      if (inRing) alpha = Math.min(alpha, spanPx < 180 ? .07 : .16);
      uiCtx.globalAlpha = alpha;
      const strokeScale = Math.max(0.62, zoomK);
      uiCtx.lineWidth = (turn ? (activeLabel ? 2.2 : 1.35) * strokeScale : secondary && !activeLabel ? 1.4 : (activeLabel ? 2.5 : 2)) * s;
      const side = showSides ? (/left/i.test(h.name || h.label || '') ? '#5fb0ff' : /right/i.test(h.name || h.label || '') ? '#ff9a3c' : '') : '';
      const col = h.moved ? '#ffd700' : (side || (turn ? '#7dd3fc' : '#ffffff'));
      uiCtx.fillStyle = turn ? (activeLabel ? col : 'rgba(125, 211, 252, .12)') : (h.moved ? '#ffd700' : activeLabel ? 'rgba(255, 255, 255, .36)' : secondary ? 'rgba(255, 255, 255, .08)' : 'rgba(255, 255, 255, .18)');
      uiCtx.strokeStyle = col;
      const rad = (turn ? (activeLabel ? 6.4 : h.minor ? 4.2 : 5.4) : secondary && !activeLabel ? 5.4 : 10.5) * s * zoomK;
      uiCtx.beginPath(); uiCtx.arc(p[0], p[1], Math.max(turn ? 1.8 * s : 3 * s, rad), 0, Math.PI * 2); uiCtx.fill(); uiCtx.stroke();
      if (h.pinned) { // a pinned hand or foot: a pin above the dot
        uiCtx.globalAlpha = 1;
        uiCtx.fillStyle = '#ff6b6b'; uiCtx.beginPath(); uiCtx.moveTo(p[0], p[1] - 13 * s); uiCtx.lineTo(p[0] - 5 * s, p[1] - 24 * s); uiCtx.lineTo(p[0] + 5 * s, p[1] - 24 * s); uiCtx.closePath(); uiCtx.fill();
        uiCtx.beginPath(); uiCtx.arc(p[0], p[1] - 26 * s, 5 * s, 0, Math.PI * 2); uiCtx.fill();
      }
    }
    if (!tiny && handleLabels && activeLabel) labels.push({ h, p, turn, text: h.label || h.name });
  }
  uiCtx.globalAlpha = 1;
  if (!labels.length) return;
  const figXs = scaled(pose()).map(pt => project(pt)[0]);
  const figMidX = figXs.length ? (Math.min(...figXs) + Math.max(...figXs)) / 2 : ui.width / 2;
  uiCtx.font = `600 ${Math.round(12 * s)}px Inter, system-ui, sans-serif`;
  labels.sort((a, b) => (!!b.h.dragging - !!a.h.dragging) || (!!b.h.hovered - !!a.h.hovered) || (!!b.h.selected - !!a.h.selected) || (a.p[1] - b.p[1]));
  const placed = [], W = ui.width, H = ui.height, pad = 4 * s, pillX = 6 * s, pillH = 20 * s;
  for (const { h, p, turn, text } of labels) {
    const tw = uiCtx.measureText(text).width, bw = tw + pillX * 2, d = (turn ? 14 : 17) * s, r = (turn ? 6.5 : 10.5) * s * zoomK;
    const cand = (x, y, align, moved) => {
      const rx0 = align === 'center' ? x - bw / 2 : align === 'right' ? x - bw : x;
      const x0 = Math.max(pad, Math.min(W - bw - pad, rx0)), x1 = x0 + bw;
      const cy = Math.max(pillH - 3 * s, Math.min(H - 5 * s, y));
      const cx = align === 'center' ? x0 + bw / 2 : align === 'right' ? x1 - pillX : x0 + pillX, clip = Math.hypot(x0 - rx0, cy - y);
      return { cx, cy, align, x0, y0: cy - 14.5 * s, x1, y1: cy + 5.5 * s, moved: moved || clip > 1, clip };
    };
    let spots;
    const rb = turn ? ringBoxes.find(q => Math.hypot(q.cx - p[0], q.cy - p[1]) < 45 * s) : null;
    if (h.kind === 'doll' && h.segA && h.segB) {
      const pa = project(h.segA), pb = project(h.segB), outRight = p[0] >= figMidX;
      const horiz = Math.abs(pb[1] - pa[1]) < Math.abs(pb[0] - pa[0]) * 0.5;
      const topY = Math.min(pa[1], pb[1]), botY = Math.max(pa[1], pb[1]);
      spots = horiz ? [
        cand(p[0], topY - 12 * s, 'center', false),
        cand(p[0], botY + 20 * s, 'center', false),
        cand((outRight ? Math.max(pa[0], pb[0]) : Math.min(pa[0], pb[0])) + (outRight ? 12 : -12) * s, p[1] + 4 * s, outRight ? 'left' : 'right', false),
      ] : [
        cand(p[0] + (outRight ? 16 : -16) * s, p[1] + 4 * s, outRight ? 'left' : 'right', false),
        cand(p[0] + (outRight ? -16 : 16) * s, p[1] + 4 * s, outRight ? 'right' : 'left', false),
        cand(p[0], topY - 12 * s, 'center', false),
        cand(p[0], botY + 20 * s, 'center', false),
      ];
    } else if (rb) {
      spots = [
        cand(rb.cx, rb.y0 - 9 * s, 'center', false),
        cand(rb.cx, rb.y1 + 19 * s, 'center', false),
        cand(rb.x1 + 9 * s, rb.cy + 4 * s, 'left', false),
        cand(rb.x0 - 9 * s, rb.cy + 4 * s, 'right', false),
      ];
    } else {
      spots = [
        cand(p[0], p[1] - d, 'center', false),
        cand(p[0], p[1] + d + 11 * s, 'center', true),
        cand(p[0] - d, p[1] + 4 * s, 'right', true),
        cand(p[0] + d, p[1] + 4 * s, 'left', true),
        cand(p[0], p[1] - d - 14 * s, 'center', true),
        cand(p[0], p[1] - d - 28 * s, 'center', true),
        cand(p[0], p[1] - d - 42 * s, 'center', true),
      ];
    }
    const clearOfRings = b => !ringBoxes.some(q => b.x0 - pad < q.x1 && b.x1 + pad > q.x0 && b.y0 - pad < q.y1 && b.y1 + pad > q.y0);
    const ok = b => clearOfRings(b) && !placed.some(q => b.x0 - pad < q.x1 && b.x1 + pad > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
    const okPlaced = b => !placed.some(q => b.x0 - pad < q.x1 && b.x1 + pad > q.x0 && b.y0 < q.y1 && b.y1 > q.y0);
    const pick = spots.find(b => b.clip <= 1 && ok(b)) || [...spots].filter(ok).sort((a, b) => a.clip - b.clip)[0] || [...spots].filter(okPlaced).sort((a, b) => a.clip - b.clip)[0] || spots[0];
    placed.push(pick);
    if (pick.moved && h.kind !== 'doll' && !rb) {
      const lx = Math.max(pick.x0, Math.min(pick.x1, p[0])), ly = Math.max(pick.y0, Math.min(pick.y1, p[1]));
      const dx = lx - p[0], dy = ly - p[1], l = Math.hypot(dx, dy) || 1;
      uiCtx.strokeStyle = 'rgba(255,255,255,.6)'; uiCtx.lineWidth = 1.2 * s;
      uiCtx.beginPath(); uiCtx.moveTo(l > r ? p[0] + dx / l * r : p[0], l > r ? p[1] + dy / l * r : p[1]); uiCtx.lineTo(lx, ly); uiCtx.stroke();
    }
    uiCtx.beginPath();
    if (uiCtx.roundRect) uiCtx.roundRect(pick.x0, pick.y0, pick.x1 - pick.x0, pick.y1 - pick.y0, 5 * s);
    else uiCtx.rect(pick.x0, pick.y0, pick.x1 - pick.x0, pick.y1 - pick.y0);
    uiCtx.fillStyle = 'rgba(12, 12, 14, .88)'; uiCtx.fill();
    uiCtx.strokeStyle = 'rgba(255, 255, 255, .28)'; uiCtx.lineWidth = 1 * s; uiCtx.stroke();
    uiCtx.textAlign = pick.align;
    uiCtx.fillStyle = '#fff';
    uiCtx.fillText(text, pick.cx, pick.cy);
  }
  uiCtx.textAlign = 'start';
}
// Left limbs blue, right limbs orange on the figure (the clip's own joint names say which is which), so a move
// "with the right leg" is checked at a glance; off, the figure is all one red.
let showSides = localStorage.getItem('understudy.sides') === 'on';
const sidesButton = document.querySelector('#sides');
export function setSides(on) { showSides = on; sidesButton?.classList.toggle('on', on); localStorage.setItem('understudy.sides', on ? 'on' : 'off'); draw(); }
export function sidesShown() { return showSides; }
if (sidesButton) { sidesButton.onclick = () => setSides(!showSides); sidesButton.classList.toggle('on', showSides); }
function sideColour(j, plain = '#ff5c5c') {
  if (!showSides) return plain;
  const n = jointNames[j] || '';
  return /left/i.test(n) ? '#5fb0ff' : /right/i.test(n) ? '#ff9a3c' : plain;
}
// Where a foot's sole ends. The clip's foot joints are the ankle (~7 cm up) and the ball of the foot (~4 cm up), so a
// figure drawn joint to joint hangs above the floor like an airwalk. Each foot gets a toe tip 6 cm past the ball
// along the foot and 3.5 cm lower: a planted stick foot reaches the floor where the body's sole does.
function footTips(p) {
  const out = [];
  for (let j = 0; j < parents.length; j++) {
    if (!/toe/i.test(jointNames[j] || '') || parents[j] < 0) continue;
    const a = p[parents[j]], t = p[j]; if (!a || !t) continue;
    const d = [t[0] - a[0], t[1] - a[1], t[2] - a[2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
    out.push([j, [t[0] + d[0] / l * .06, t[1] + d[1] / l * .06 - .035, t[2] + d[2] / l * .06]]);
  }
  return out;
}
// Stage props: the clip's boxes (a seat, a ledge), drawn as wire boxes on the floor grid. The checks treat a box
// top as floor inside its footprint; Clean up's physics keeps the body on it.
export function propsOf() { return state.animation?.props || []; }
function boxCorners(b) {
  const [cx, cy, cz] = b.pos, [w, h, d] = b.size, c = Math.cos(b.yaw || 0), sn = Math.sin(b.yaw || 0);
  const out = [];
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    const x = cx + lx * c - lz * sn, z = cz + lx * sn + lz * c;
    out.push([x, cy, z], [x, cy + h, z]);
  }
  return out; // bottom/top pairs for 4 corners
}
function drawProps() {
  const props = propsOf(); if (!props.length) return;
  const s = scale();
  const line = (a, b) => { const seg = clipSegment(a, b); if (!seg) return; ctx.beginPath(); ctx.moveTo(seg[0][0], seg[0][1]); ctx.lineTo(seg[1][0], seg[1][1]); ctx.stroke(); };
  for (const [i, b] of props.entries()) {
    if (b.kind && b.kind !== 'box') continue;
    const c = boxCorners(b); const sel = i === state.selectedProp;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // top face filled faintly, then the 12 edges
    const top = c.filter((_, i) => i % 2 === 1).map(p => project(p));
    ctx.globalAlpha = .18; ctx.fillStyle = '#ffd27f'; ctx.beginPath(); ctx.moveTo(top[0][0], top[0][1]); for (const q of top.slice(1)) ctx.lineTo(q[0], q[1]); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = sel ? 1 : .9; ctx.strokeStyle = sel ? '#fff1c2' : '#ffd27f'; ctx.lineWidth = Math.max(1.5, (sel ? 3.5 : 2) * s);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      line(c[i * 2], c[j * 2]); line(c[i * 2 + 1], c[j * 2 + 1]); line(c[i * 2], c[i * 2 + 1]);
    }
    if (b.name) { const t = project(c[1]); ctx.fillStyle = '#ffd27f'; ctx.font = `${Math.round(12 * s)}px sans-serif`; ctx.fillText(b.name, t[0] + 6 * s, t[1] - 6 * s); }
    ctx.globalAlpha = 1;
  }
}
export function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = scale(), p = scaled(pose());
  ground();
  drawProps();
  drawTrail();
  if (state.frame !== lastSeenFrame) { lastSeenFrame = state.frame; for (const fn of frameListeners) fn(state.frame); }
  drawPathOverlay();
  drawPointOverlay();
  if (ghost.animation) {
    // with the body shown the ghost goes on the top canvas, or the doll would hide it
    const g = ghostPose(), gc = (characterShown || showBody) ? uiCtx : ctx;
    if (gc === uiCtx) uiCtx.clearRect(0, 0, ui.width, ui.height);
    // the auto-poser's suggestion (handles.js) is green and dashed, labelled at the head, so it never reads as the
    // left side (blue) or a compared take
    const sug = ghost.animation.id === 'suggestion', col = sug ? '#7dffb0' : '#7fd0ff';
    gc.globalAlpha = sug ? .85 : .7; gc.strokeStyle = col; gc.lineWidth = (sug ? 3 : 4) * s; gc.lineCap = 'round'; gc.setLineDash(sug ? [7 * s, 5 * s] : []);
    for (let i = 1; i < ghost.parents.length; i++) { const a = project(g[i]), b = project(g[ghost.parents[i]]); gc.beginPath(); gc.moveTo(a[0], a[1]); gc.lineTo(b[0], b[1]); gc.stroke(); }
    gc.setLineDash([]);
    gc.fillStyle = col; for (const j of g) { const a = project(j); gc.beginPath(); gc.arc(a[0], a[1], 3 * s, 0, Math.PI * 2); gc.fill(); }
    if (sug) { const h = g[jointNames.indexOf('Head')] || g[g.length - 1], a = project(h); gc.font = `${Math.round(12 * s)}px sans-serif`; gc.fillText('suggested', a[0] + 12 * s, a[1] - 12 * s); }
    gc.globalAlpha = 1;
  }
  drawOnion(s);
  if (extras.length) drawExtras(s);
  if (p.length) drawProp(p);
  if (state.override && state.override.frame === state.frame) { // the pose before the edit, faint
    const o = pose(true);
    ctx.globalAlpha = .25; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 5 * s; ctx.lineCap = 'round';
    for (let i = 1; i < parents.length; i++) { const a = project(o[i]), b = project(o[parents[i]]); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (p.length && (!(characterShown || showBody) || skeletonOverCharacter)) {
    // through the body the figure is the doll's own skeleton: the same clip on the doll's bones
    const viaBody = (characterShown || showBody) && skeletonOverCharacter && bodySkeleton ? bodySkeleton() : null;
    const q = p; // the clip's skeleton is the reference, always drawn at its own scale
    const thin = viaBody ? 1 : 0; // through the body it draws lighter so the shells stay readable under it
    ctx.lineCap = 'round';
    const tips = footTips(q);
    for (let pass = 0; pass < 2; pass++) {
      ctx.lineWidth = (pass ? 7 - thin * 2 : 13 - thin * 4) * s;
      for (let i = 1; i < parents.length; i++) {
        ctx.strokeStyle = pass ? sideColour(i) : '#140606';
        const a = project(q[i]), b = project(q[parents[i]]);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      for (const [j, tip] of tips) {
        ctx.strokeStyle = pass ? sideColour(j) : '#140606';
        const a = project(q[j]), b = project(tip);
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    }
    if (viaBody?.fingers?.length) {
      ctx.lineWidth = 2.5 * s; ctx.strokeStyle = '#ff8a8a';
      for (const [a0, b0] of viaBody.fingers) { const a = project(a0), b = project(b0); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    }
    if (viaBody?.joints?.length === p.length) { // where the doll's own joints are: white dots; a gap to the red figure is a fit error
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      for (const x of viaBody.joints) { const a = project(x); ctx.beginPath(); ctx.arc(a[0], a[1], 2.5 * s, 0, Math.PI * 2); ctx.fill(); }
    }
    for (const x of q) {
      const a = project(x);
      ctx.fillStyle = '#140606'; ctx.beginPath(); ctx.arc(a[0], a[1], (7 - thin * 2) * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff0ee'; ctx.beginPath(); ctx.arc(a[0], a[1], (4 - thin) * s, 0, Math.PI * 2); ctx.fill();
    }
  }
  drawHandles();
  for (const fn of drawListeners) fn();
  slider.value = state.frame;
  frameText.textContent = state.animation ? `frame ${state.frame + 1} / ${state.animation.frames}` : 'No animation selected';
}

let speed = 1;
export function setSpeed(v) { speed = v; }
const presets = { front: { yaw: Math.PI, pitch: -.1 }, side: { yaw: Math.PI / 2, pitch: -.1 }, top: { yaw: 0, pitch: -1.25 }, three: { yaw: defaultView.yaw, pitch: defaultView.pitch } };
// For inspection scripts: the in-between blend playback would be at (0..1), without playing.
export function setBlendForTest(b) { playbackBlend = b; }
// For inspection scripts (contact sheets): an exact camera angle.
export function setViewAngles(yaw, pitch) { view.yaw = yaw; view.pitch = pitch; view.panX = 0; view.panY = 0; draw(); }
export function setViewPreset(name) { const p = presets[name]; if (!p) return; view.yaw = p.yaw; view.pitch = p.pitch; view.panX = 0; view.panY = 0; draw(); }
function tick(t) {
  if (state.animation) {
    const interval = 1000 / 30 / speed;
    if (!last) last = t;
    if (state.playing) {
      while (t - last >= interval) { state.frame = (state.frame + 1) % state.animation.frames; last += interval; }
      playbackBlend = Math.min(1, (t - last) / interval);
    } else playbackBlend = 0;
    updateCamera(t);
    draw();
  }
  requestAnimationFrame(tick);
}

export function setPlaying(playing) {
  state.playing = playing; last = performance.now(); playbackBlend = 0;
  playButton.textContent = playing ? 'Pause' : 'Play';
}
export function setFrame(frame) {
  if (!state.animation) return;
  const n = state.animation.frames;
  state.frame = ((Math.round(frame) % n) + n) % n;
  playbackBlend = 0; last = performance.now(); draw();
}
export function step(delta) { setPlaying(false); setFrame(state.frame + delta); }

// Show an animation: fetch its streams and start at `frame` (paused when one is given).
// A clean stage: no clip, no ghost, no override; the grid and the floor stay.
export function unload() {
  setPlaying(false);
  state.animation = null; state.root = null; state.rotations = null; state.override = null; state.frame = 0;
  ghost.animation = null;
  slider.max = 0;
  draw();
}

export async function load(animation, skeleton, { frame = null } = {}) {
  if (skeleton?.parents?.length && skeleton.offsets?.length === skeleton.parents.length) { parents = skeleton.parents; offsets = skeleton.offsets; jointNames = skeleton.joint_names || []; }
  // a clip whose files are gone (deleted for good elsewhere) says so instead of failing inside a typed array
  const stream = url => fetch(url).then(r => { if (!r.ok) throw new Error(`this clip's motion files are missing (${r.status})`); return r.arrayBuffer(); }).then(b => new Float32Array(b));
  const [root, rotations] = await Promise.all([stream(`/api/animations/${animation.id}/root.f32`), stream(`/api/animations/${animation.id}/rotations.f32`)]);
  state.animation = animation; state.root = root; state.rotations = rotations; state.override = null;
  computeAllPositions();
  state.floorY = clipFloor();
  alignGhost();
  slider.max = animation.frames - 1;
  if (frame != null) { setPlaying(false); state.frame = Math.max(0, Math.min(animation.frames - 1, frame)); }
  else { state.frame = 0; setPlaying(true); }
  playbackBlend = 0; last = performance.now();
  snapCamera();
  if (!trails.follow && allPositions) { // show the whole route: centre on its middle
    const xs = allPositions.map(p => p[0][0]), zs = allPositions.map(p => p[0][2]);
    view.cameraX = (Math.min(...xs) + Math.max(...xs)) / 2; view.cameraZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  }
  draw();
}

// One frame on its own canvas from a locked view: the frame sheet for 2D reference.
export function renderFrame(frame, { width = 320, height = 320, side = true, yaw = null } = {}) {
  const off = document.createElement('canvas'); off.width = width; off.height = height;
  const saved = { ...view }, savedFrame = state.frame, savedBlend = playbackBlend;
  state.frame = frame; playbackBlend = 0;
  Object.assign(view, { yaw: yaw ?? (side ? Math.PI / 2 : Math.PI), pitch: -.05, panX: 0, panY: 0, zoom: 2200 });
  const [x, , z] = renderedRoot(); view.cameraX = x; view.cameraZ = z; view.cameraZoom = view.zoom;
  const p = pose(), c = off.getContext('2d'), s = width / 1280 * 2.2;
  const proj = ([px, py, pz]) => { const [rx, ry, dz] = cameraSpace([px, py, pz]); return [width / 2 + view.cameraZoom * s * rx / dz, height * .9 - view.cameraZoom * s * ry / dz]; };
  c.fillStyle = '#fff'; c.fillRect(0, 0, width, height);
  const FY = state.floorY || 0; // the ground line on the clip's own floor (it was y = 0: every figure hung 2 cm above it)
  c.strokeStyle = '#ddd'; c.lineWidth = 1; const g0 = proj([x - 1, FY, z]), g1 = proj([x + 1, FY, z]); c.beginPath(); c.moveTo(g0[0], g0[1]); c.lineTo(g1[0], g1[1]); c.stroke();
  c.lineCap = 'round'; c.lineWidth = 4 * s;
  for (let i = 1; i < parents.length; i++) { c.strokeStyle = sideColour(i, '#111'); const a = proj(p[i]), b = proj(p[parents[i]]); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
  for (const [j, tip] of footTips(p)) { c.strokeStyle = sideColour(j, '#111'); const a = proj(p[j]), b = proj(tip); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); }
  c.fillStyle = '#e33';
  for (const j of p) { const a = proj(j); c.beginPath(); c.arc(a[0], a[1], 3 * s, 0, Math.PI * 2); c.fill(); }
  Object.assign(view, saved); state.frame = savedFrame; playbackBlend = savedBlend;
  return off;
}

// The pose on screen, in the clip's space: what "Pin current pose" sends as a keyframe.
export function currentPose() {
  const { animation, root, rotations, frame, override } = state;
  if (!animation || !root || !rotations) return null;
  const joints = rotations.length / (animation.frames * 4);
  if (override && override.frame === frame) return { model: animation.model, frames: animation.frames, frame, root: [...override.root], rotations: override.rotations.flat() };
  return { model: animation.model, frames: animation.frames, frame, root: [...root.slice(frame * 3, frame * 3 + 3)], rotations: [...rotations.slice(frame * joints * 4, (frame + 1) * joints * 4)] };
}

// Stage input: orbit, pan, zoom, scrub.
let drag;
canvas.addEventListener('dblclick', resetView);
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => { try { canvas.setPointerCapture(e.pointerId); } catch {} drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; canvas.classList.add('dragging'); });
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
  if (drag.pan) { view.panX += dx; view.panY += dy; }
  else { view.yaw -= dx * .008;   /* the stage is no longer mirror-imaged: dragging keeps the old feel */ view.pitch = Math.max(-1.25, Math.min(1.25, view.pitch + dy * .008)); }
  draw();
});
const endDrag = () => { drag = undefined; canvas.classList.remove('dragging'); };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('wheel', e => { e.preventDefault(); const dy = Math.max(-180, Math.min(180, e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1))); view.zoom = Math.max(900, Math.min(9000, view.zoom * Math.exp(-dy * .0012))); view.cameraZoom = view.zoom * (1 - Math.min(.22, view.cameraSpeed * .035)); draw(); }, { passive: false });
slider.oninput = () => { setPlaying(false); setFrame(Number(slider.value)); };
playButton.onclick = () => setPlaying(!state.playing);
document.querySelector('#stepBack').onclick = () => step(-1);
document.querySelector('#stepForward').onclick = () => step(1);
document.querySelector('#resetView').onclick = resetView;

fitCanvas();
requestAnimationFrame(tick);
