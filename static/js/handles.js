// IK handles on the stage: drag a hand, foot or the hips at the current frame;
// swing an elbow or knee around its limb; aim the head. Arms and legs are
// solved with two-bone IK in the skeleton's own rotation space, so the result
// is a real pose Kimodo can pin, bake into the clip, or regenerate around.
//
// Precision: X / Y / Z lock the drag to a world axis (again to release), Shift
// drags along the ground, Ctrl drags toward/away from the camera, Alt is fine
// (¼ speed). Arrow keys nudge the selected handle 1 cm (Shift: 5 cm), PageUp /
// PageDown lift it. The fields in the bar take exact metres and degrees.
// Ctrl+Z undoes the last move.
import * as viewer from './viewer.js';
import * as compose from './compose.js';
import * as library from './library.js';
import * as K from './keys.js';
import * as keep from './keep.js';
import { addKeyframe } from './compose.js';

const canvas = document.querySelector('#view');
const button = document.querySelector('#handles');
const bar = document.querySelector('#handleBar');
const $ = s => document.querySelector(s);

let active = false;
let edit = null;      // { frame, root: [3], rotations: [[4]...], base: [[4]...], moved: Set<name>, history: [] }
let drag = null;      // { handle, dz, y, mode, start:[sx,sy], startWorld }
let selected = null;  // handle name
let axisLock = null;  // 'x' | 'y' | 'z' | null
const handles = {};   // name -> { chain: [upper, lower, end] } | { root: true } | { pole: [upper, lower, end] } | { look: head }

const q = {
  mul: viewer.multiply,
  conj: ([x, y, z, w]) => [-x, -y, -z, w],
  axisAngle: (axis, angle) => { const l = Math.hypot(...axis) || 1, s = Math.sin(angle / 2); return [axis[0] / l * s, axis[1] / l * s, axis[2] / l * s, Math.cos(angle / 2)]; },
  normalize: v => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l, v[3] / l]; },
  fromEuler: (x, y, z) => { // degrees, XYZ
    const r = d => d * Math.PI / 180, cx = Math.cos(r(x) / 2), sx = Math.sin(r(x) / 2), cy = Math.cos(r(y) / 2), sy = Math.sin(r(y) / 2), cz = Math.cos(r(z) / 2), sz = Math.sin(r(z) / 2);
    return [sx * cy * cz + cx * sy * sz, cx * sy * cz - sx * cy * sz, cx * cy * sz + sx * sy * cz, cx * cy * cz - sx * sy * sz];
  },
};
const v = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  len: a => Math.hypot(a[0], a[1], a[2]),
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

function findChains() {
  for (const k of Object.keys(handles)) delete handles[k];
  const names = viewer.skeleton.names.map(n => n.toLowerCase());
  const idx = (...tests) => { for (const t of tests) { const i = names.findIndex(n => n === t); if (i >= 0) return i; } return -1; };
  const chain = (label, mid, upper, lower, end) => { const c = [idx(...upper), idx(...lower), idx(...end)]; if (c.every(i => i >= 0)) { handles[label] = { chain: c }; handles[mid] = { pole: c }; } };
  chain('Left hand', 'Left elbow', ['leftarm', 'left_shoulder'], ['leftforearm', 'left_elbow'], ['lefthand', 'left_wrist']);
  chain('Right hand', 'Right elbow', ['rightarm', 'right_shoulder'], ['rightforearm', 'right_elbow'], ['righthand', 'right_wrist']);
  chain('Left foot', 'Left knee', ['leftleg', 'left_hip'], ['leftshin', 'left_knee'], ['leftfoot', 'left_ankle']);
  chain('Right foot', 'Right knee', ['rightleg', 'right_hip'], ['rightshin', 'right_knee'], ['rightfoot', 'right_ankle']);
  handles.Hips = { root: true };
  const head = idx('head'); if (head >= 0) handles.Look = { look: head };
}
const effectorName = { 'Left hand': 'LeftHand', 'Right hand': 'RightHand', 'Left foot': 'LeftFoot', 'Right foot': 'RightFoot', Hips: 'Hips' };

// Forward kinematics of the edited pose: world positions and global rotations.
function fk() {
  const { parents, offsets } = viewer.skeleton;
  const positions = [], global = [];
  for (let j = 0; j < parents.length; j++) {
    const p = parents[j];
    if (p < 0) { global[j] = edit.rotations[j]; positions[j] = [...edit.root]; }
    else { global[j] = q.mul(global[p], edit.rotations[j]); positions[j] = v.add(positions[p], viewer.rotate(global[p], offsets[j])); }
  }
  return { positions, global };
}

// Two-bone IK: bend the lower joint to the right length, then aim the upper joint at the target.
function solve(chain, target, keepEndTurn = false) {
  const [u, l, e] = chain, { parents } = viewer.skeleton;
  let { positions: P, global: G } = fk();
  const endTurn = G[e];
  const A = P[u], B = P[l], C = P[e];
  const l1 = v.len(v.sub(B, A)), l2 = v.len(v.sub(C, B));
  const d = Math.max(Math.abs(l1 - l2) + 1e-4, Math.min(l1 + l2 - 1e-4, v.len(v.sub(target, A))));
  const a0 = Math.acos(Math.max(-1, Math.min(1, v.dot(v.norm(v.sub(A, B)), v.norm(v.sub(C, B))))));
  const a1 = Math.acos(Math.max(-1, Math.min(1, (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2))));
  let axis = v.cross(v.sub(B, A), v.sub(C, B));
  // a straight limb has no bend plane: bend about the joint's own hinge axis (knees +X, left elbow -Y, right +Y in
  // the joint's frame), so a knee straightened and bent again bends forward, never backwards
  const hinge = limits?.hinges?.[viewer.skeleton.names[l]]?.axis;
  if (v.len(axis) < 0.02 * l1 * l2 && hinge) axis = viewer.rotate(G[l], hinge);
  if (v.len(axis) < 1e-6) axis = v.cross(v.sub(B, A), [0, 1, 0]);
  if (v.len(axis) < 1e-6) axis = [1, 0, 0];
  const bend = q.axisAngle(axis, a0 - a1);
  edit.rotations[l] = q.normalize(q.mul(q.conj(G[parents[l]]), q.mul(bend, G[l])));
  ({ positions: P, global: G } = fk());
  const from = v.norm(v.sub(P[e], A)), to = v.norm(v.sub(target, A));
  const ang = Math.acos(Math.max(-1, Math.min(1, v.dot(from, to))));
  if (ang > 1e-5) {
    const aim = q.axisAngle(v.cross(from, to), ang);
    edit.rotations[u] = q.normalize(q.mul(q.conj(G[parents[u]]), q.mul(aim, G[u])));
  }
  // a planted foot or hand keeps its world turn (sole flat) while the knee or elbow bends; otherwise it tipped with
  // the shin, toe-down, and the floor guard lifted it onto tiptoe
  if (keepEndTurn) { ({ global: G } = fk()); edit.rotations[e] = q.normalize(q.mul(q.conj(G[l]), endTurn)); }
}
// Pole: swing the limb's plane around the upper→end line so the elbow/knee heads for the target; the end stays put.
function swing(chain, target) {
  const [u, l, e] = chain, { parents } = viewer.skeleton;
  const { positions: P, global: G } = fk();
  const A = P[u], C = P[e], axis = v.norm(v.sub(C, A));
  const flat = p => { const r = v.sub(p, A); return v.sub(r, v.scale(axis, v.dot(r, axis))); };
  const cur = flat(P[l]), want = flat(target);
  if (v.len(cur) < 1e-4 || v.len(want) < 1e-4) return;
  const c = v.norm(cur), w = v.norm(want);
  let ang = Math.acos(Math.max(-1, Math.min(1, v.dot(c, w))));
  if (v.dot(v.cross(c, w), axis) < 0) ang = -ang;
  const rot = q.axisAngle(axis, ang);
  edit.rotations[u] = q.normalize(q.mul(q.conj(G[parents[u]]), q.mul(rot, G[u])));
}
// Look: aim the head's forward (+Z in its own frame, where the skeleton faces at rest) at the target.
function look(head, target) {
  const { positions: P, global: G } = fk(), { parents } = viewer.skeleton;
  const from = v.norm(viewer.rotate(G[head], [0, 0, 1])), to = v.norm(v.sub(target, P[head]));
  const ang = Math.acos(Math.max(-1, Math.min(1, v.dot(from, to))));
  if (ang < 1e-5) return;
  const rot = q.axisAngle(v.cross(from, to), ang);
  edit.rotations[head] = q.normalize(q.mul(q.conj(G[parents[head]]), q.mul(rot, G[head])));
}

// Hard floor: while posing, no part of the body's surface (soles, toes, knees, hands, trunk) goes under the floor, or
// under a box top where it is over a box. A foot or hand pushed down slides along the floor instead; with the hips
// pushed down the limbs that would go through bend instead (their ends stay on the floor), and a knee or the trunk
// stops the body. It never makes a pose worse than the clip already was: a bone already 1 cm through may stay 1 cm
// through, no deeper. Uses the server's body surface (the one its floor checks use), so it matches the Checks row.
const hardFloorBox = document.querySelector('#hardFloor');
let bodyProxy = null, proxyLoading = false;
function loadProxy() {
  if (bodyProxy || proxyLoading) return;
  const names = viewer.skeleton.names;
  if (!(names.length === 30 && names.includes('LeftToeBase'))) return;      // only the SOMA body has a surface here
  proxyLoading = true;
  fetch('/api/body-proxy/soma30').then(r => r.ok ? r.json() : null).then(p => { bodyProxy = p; proxyLoading = false; if (edit) edit.allow = baseAllow(); }).catch(() => { proxyLoading = false; });
}
// the clip's own pose at this frame: how deep each bone already was (allowed, never deeper)
function baseAllow() {
  if (!bodyProxy || !edit) return {};
  const keep = [edit.root, edit.rotations];
  edit.root = edit.baseRoot; edit.rotations = edit.base.map(r => [...r]);
  const a = sinkDepths(); [edit.root, edit.rotations] = keep; return a;
}
const FLOOR_TOL = 0.002;
function supportAt(x, z) {
  let h = viewer.state.floorY || 0;
  for (const b of viewer.state.animation?.props || []) {
    if (b.kind && b.kind !== 'box') continue;
    const c = Math.cos(b.yaw || 0), sn = Math.sin(b.yaw || 0), dx = x - b.pos[0], dz = z - b.pos[2];
    const lx = dx * c + dz * sn, lz = -dx * sn + dz * c;
    if (Math.abs(lx) <= b.size[0] / 2 && Math.abs(lz) <= b.size[2] / 2) h = Math.max(h, b.pos[1] + b.size[1]);
  }
  return h;
}
// how far each bone's surface is under its support (0 = on or above), by joint index
function sinkDepths() {
  const { positions: P, global: G } = fk(), names = viewer.skeleton.names, out = {};
  for (const [bone, pts] of Object.entries(bodyProxy)) {
    const j = names.indexOf(bone); if (j < 0) continue;
    let d = 0;
    for (const p of pts) {
      const w = v.add(P[j], viewer.rotate(G[j], p)), under = supportAt(w[0], w[2]) - w[1];
      if (under > d) d = under;
    }
    out[j] = d;
  }
  return out;
}
function hardFloorOn() { return !!bodyProxy && (!hardFloorBox || hardFloorBox.checked); }
// the end bones of a limb: hand / foot + toe
function limbEnds(chain) {
  const { parents } = viewer.skeleton; const e = chain[2];
  return [e, ...parents.map((p, j) => p === e ? j : -1).filter(j => j >= 0 && bodyProxy[viewer.skeleton.names[j]])];
}
function settleFloor() {
  if (!edit || !hardFloorOn()) return;
  const allow = edit.allow || {};
  const over = depth => { const o = {}; for (const [j, d] of Object.entries(depth)) { const x = d - Math.max(FLOOR_TOL, allow[j] || 0); if (x > 0) o[j] = x; } return o; };
  const chains = Object.values(handles).filter(h => h.chain).map(h => h.chain);
  for (let it = 0; it < 4; it++) {
    const o = over(sinkDepths()); if (!Object.keys(o).length) return;
    // 1. a limb whose hand / foot / toe is pushed under the support plants against it: the sole or palm turns flat onto
    //    it (heading kept, toe flat with the foot), then the end lifts by whatever is still under (it slides on the
    //    floor). Lifting alone kept the foot's tilt: pushed down it tipped and rode up instead of planting. A foot the
    //    user tilted with the tilt fields keeps that tilt and rests on its toe or heel instead.
    let moved = false;
    for (const ch of chains) {
      const ends = limbEnds(ch);
      if (!(Math.max(0, ...ends.map(j => o[j] || 0)) > 0)) continue;
      if (!edit.tilted?.has(ch[2])) plantFlat(ch[2], ends.slice(1));
      const o2 = over(sinkDepths()), lift = Math.max(0, ...ends.map(j => o2[j] || 0));
      if (lift > 0) { const { positions } = fk(); solve(ch, v.add(positions[ch[2]], [0, lift + 0.001, 0]), true); }
      moved = true;
    }
    if (moved) continue;
    // 2. anything else under it (a knee, the hips, the back): the whole body goes up by that much
    const rest = Math.max(0, ...Object.values(o));
    if (rest > 0) edit.root = v.add(edit.root, [0, rest + 0.001, 0]);
  }
}
// Turn an end bone (foot, hand) so its flat side faces straight down, its heading kept: in the bone's own frame the
// sole of a foot and the palm of a hand face -y (measured on a flat-footed standing frame). Toes go flat with the foot.
function plantFlat(e, children = []) {
  const { parents } = viewer.skeleton, { global: G } = fk();
  const down = v.norm(viewer.rotate(G[e], [0, -1, 0])), want = [0, -1, 0];
  const ang = Math.acos(Math.max(-1, Math.min(1, v.dot(down, want))));
  if (ang > 1e-4) {
    const axis = v.cross(down, want), turn = v.len(axis) > 1e-6 ? q.axisAngle(axis, ang) : [1, 0, 0, 0];
    edit.rotations[e] = q.normalize(q.mul(q.conj(G[parents[e]]), q.mul(turn, G[e])));
  }
  for (const c of children) edit.rotations[c] = [0, 0, 0, 1];
}
// an end (hand / foot / toe) whose surface is within 1 cm of its support
function endTouching(chain) {
  const { positions: P, global: G } = fk(), names = viewer.skeleton.names;
  return limbEnds(chain).some(j => { const pts = bodyProxy?.[names[j]]; return pts && pts.some(p => { const w = v.add(P[j], viewer.rotate(G[j], p)); return w[1] - supportAt(w[0], w[2]) < 0.01; }); });
}
// with the hips dragged, limbs whose ends were on the floor keep them there (the knees bend); see moveTo
function plantedEnds() {
  if (!hardFloorOn()) return [];
  const { positions } = fk(), d = sinkDepths(), out = [];
  for (const h of Object.values(handles)) {
    if (!h.chain) continue;
    // an end touching its support (surface within 2 cm) counts as planted
    const ends = limbEnds(h.chain);
    const near = ends.some(j => { const pts = bodyProxy[viewer.skeleton.names[j]]; if (!pts) return false; const { global: G } = fk(); return pts.some(p => { const w = v.add(positions[j], viewer.rotate(G[j], p)); return w[1] - supportAt(w[0], w[2]) < 0.02; }); });
    if (near || ends.some(j => (d[j] || 0) > 0)) out.push({ chain: h.chain, at: [...positions[h.chain[2]]] });
  }
  return out;
}

// Joint limits: no joint is posed past what a body can do. The ranges: Clean up's (anatomy.py: spine, neck, shoulders,
// feet, toes as a total turn; knees and elbows as hinges: bend, backward bend, twist, side bend), the wrist range of
// Clean wrists, and for hips and shoulders the directions the library's 790 clips ever pointed the limb in
// (static/body/soma30_limits.json, tools/cleanup/build_reach_limits.py). A joint the clip already had outside its
// range may stay as it was.
const limitsBox = document.querySelector('#jointLimits');
let limits = null, limitsLoading = false;
function loadLimits() {
  if (limits || limitsLoading) return;
  const names = viewer.skeleton.names; if (!(names.length === 30 && names.includes('LeftToeBase'))) return;
  limitsLoading = true;
  fetch('/static/body/soma30_limits.json').then(r => r.ok ? r.json() : null).then(d => { limits = d; limitsLoading = false; if (edit) edit.limitBase = baseViolations(); }).catch(() => { limitsLoading = false; });
}
function limitsOn() { return !!limits && (!limitsBox || limitsBox.checked); }
const DEG = 180 / Math.PI;
function rotvec(qq) { let [x, y, z, w] = qq; if (w < 0) { x = -x; y = -y; z = -z; w = -w; } const sn = Math.hypot(x, y, z); if (sn < 1e-12) return [0, 0, 0]; const a = 2 * Math.atan2(sn, w); return [x / sn * a, y / sn * a, z / sn * a]; }
function fromRotvec(r) { const a = v.len(r); return a < 1e-12 ? [0, 0, 0, 1] : q.axisAngle(r, a); }
function swingTwist(qq, bone) {   // -> [swing quat, twist angle (rad) about bone]
  const p = qq[0] * bone[0] + qq[1] * bone[1] + qq[2] * bone[2];
  let tw = [p * bone[0], p * bone[1], p * bone[2], qq[3]]; const n = Math.hypot(...tw);
  tw = n < 1e-9 ? [0, 0, 0, 1] : tw.map(c => c / n);
  return [q.mul(qq, q.conj(tw)), v.dot(rotvec(tw), bone)];
}
const childBone = name => { const { names, offsets } = viewer.skeleton; return v.norm(offsets[names.indexOf(name)]); };
// one joint's local turn brought inside its range; returns [quat, degrees it was over]
function clampJoint(name, qq) {
  const L = limits;
  if (L.ankle?.joints?.includes(name)) {
    // the ankle's posing range (a real ankle, stricter than Clean up's broken-pose limit): in the foot's own frame,
    // turning about x points the toes down (+) or up (-), about y swings them sideways, about z rolls the foot
    const A = L.ankle, r = rotvec(qq), d = DEG;
    const r2 = [Math.max(-A.toes_up / d, Math.min(A.toes_down / d, r[0])), Math.max(-A.twist / d, Math.min(A.twist / d, r[1])), Math.max(-A.roll / d, Math.min(A.roll / d, r[2]))];
    const over = Math.max(Math.abs(r[0] - r2[0]), Math.abs(r[1] - r2[1]), Math.abs(r[2] - r2[2])) * d;
    return over > 0.05 ? [fromRotvec(r2), over] : [qq, 0];
  }
  if (L.limits[name] != null) {
    const r = rotvec(qq), a = v.len(r), lim = L.limits[name] / DEG;
    return a > lim ? [fromRotvec(v.scale(r, lim / a)), (a - lim) * DEG] : [qq, 0];
  }
  const hg = L.hinges[name];
  if (hg) {
    const bone = childBone(hg.child), h = hg.axis, [sw, tw] = swingTwist(qq, bone), sv = rotvec(sw);
    const bend = v.dot(sv, h), sidev = v.sub(sv, v.scale(h, bend)), side = v.len(sidev);
    const b2 = Math.max(-hg.back / DEG, Math.min(hg.bend / DEG, bend)), s2 = side > hg.side / DEG ? v.scale(sidev, hg.side / DEG / side) : sidev;
    const t2 = Math.max(-hg.twist / DEG, Math.min(hg.twist / DEG, tw));
    const over = Math.max(0, Math.abs(bend - b2) * DEG, (side - hg.side / DEG) * DEG, Math.abs(tw - t2) * DEG);
    return over > 0.05 ? [q.mul(fromRotvec(v.add(v.scale(h, b2), s2)), fromRotvec(v.scale(bone, t2))), over] : [qq, 0];
  }
  const rc = L.reach[name];
  if (rc) {
    const bone = rc.bone; let [sw, tw] = swingTwist(qq, bone); let over = 0;
    // the limb's direction in the parent's frame must be one the library reached
    const dir = viewer.rotate(sw, bone); let best = -2, bi = -1, bestA = -2, ai = -1;
    for (let i = 0; i < L.bins.length; i++) { const d = v.dot(dir, L.bins[i]); if (d > best) { best = d; bi = i; } }
    if (!L.allowedSet) L.allowedSet = Object.fromEntries(Object.entries(L.reach).map(([k, r]) => [k, new Set(r.allowed)]));
    if (!L.allowedSet[name].has(bi)) {
      for (const i of rc.allowed) { const d = v.dot(dir, L.bins[i]); if (d > bestA) { bestA = d; ai = i; } }
      const to = L.bins[ai], ang = Math.acos(Math.max(-1, Math.min(1, v.dot(dir, to))));
      const ax = v.cross(dir, to); if (v.len(ax) > 1e-9) { sw = q.mul(q.axisAngle(ax, ang), sw); over = ang * DEG; }
    }
    const t2 = Math.max(rc.twist[0] / DEG, Math.min(rc.twist[1] / DEG, tw)); over = Math.max(over, Math.abs(tw - t2) * DEG);
    return over > 0.05 ? [q.mul(sw, fromRotvec(v.scale(bone, t2))), over] : [qq, 0];
  }
  if (L.wrist.joints.includes(name)) {
    const bone = childBone(name.replace('Hand', 'HandMiddleEnd')), [sw, tw] = swingTwist(qq, bone), sv = rotvec(sw), sa = v.len(sv);
    const smax = L.wrist.swing / DEG, tmax = L.wrist.twist / DEG;
    const s2 = sa > smax ? v.scale(sv, smax / sa) : sv, t2 = Math.max(-tmax, Math.min(tmax, tw));
    const over = Math.max(0, (sa - smax) * DEG, Math.abs(tw - t2) * DEG);
    return over > 0.05 ? [q.mul(fromRotvec(s2), fromRotvec(v.scale(bone, t2))), over] : [qq, 0];
  }
  return [qq, 0];
}
function baseViolations() {   // joints the clip already had outside their range at this frame: left alone
  if (!limits || !edit) return new Set();
  const names = viewer.skeleton.names, out = new Set();
  edit.base.forEach((qq, j) => { if (clampJoint(names[j], qq)[1] > 0.5) out.add(j); });
  return out;
}
function clampPose() {
  if (!edit || !limitsOn()) return 0;
  const names = viewer.skeleton.names; let worst = 0;
  for (let j = 0; j < names.length; j++) {
    if (edit.limitBase?.has(j)) continue;
    const [qq, over] = clampJoint(names[j], edit.rotations[j]);
    if (over > 0) { edit.rotations[j] = q.normalize(qq); worst = Math.max(worst, over); }
  }
  return worst;
}

// Body: no limb is posed through the body. The capsules and pair rules are Clean up's (cleanup.py parts_of /
// check_pair, the server's metrics.go): forearm and hand against torso, head and legs; legs against each other;
// arms against each other. A limb pushed in has its hand or foot moved out by the overlap (turn kept), so the
// forearm slides along the chest instead of through it. Pairs the clip already had overlapping may stay as deep.
const bodyBox = document.querySelector('#bodySolid');
function bodyOn() { return !bodyBox || bodyBox.checked; }
let parts = null;
function partsOf() {
  if (parts) return parts;
  const names = viewer.skeleton.names, ix = n => names.indexOf(n); const out = [];
  const add = (name, group, a, b, r, extend = 0) => { if (ix(a) >= 0 && ix(b) >= 0) out.push({ name, group, a: ix(a), b: ix(b), r, extend }); };
  for (const [tag, pre] of [['l', 'Left'], ['r', 'Right']]) {
    add(pre + ' upper arm', 'arm-' + tag, pre + 'Arm', pre + 'ForeArm', 0.05);
    add(pre + ' forearm', 'arm-' + tag, pre + 'ForeArm', pre + 'Hand', 0.04);
    add(pre + ' hand', 'arm-' + tag, pre + 'Hand', pre + 'HandMiddleEnd', 0.03);
    add(pre + ' thigh', 'leg-' + tag, pre + 'Leg', pre + 'Shin', 0.07);
    add(pre + ' shin', 'leg-' + tag, pre + 'Shin', pre + 'Foot', 0.055);
    add(pre + ' foot', 'leg-' + tag, pre + 'Foot', pre + 'ToeBase', 0.04);
  }
  add('torso', 'torso', 'Hips', 'Chest', 0.13); add('neck', 'head', 'Neck1', 'Head', 0.06); add('head', 'head', 'Neck1', 'Head', 0.10, 0.2);
  return (parts = out);
}
function checkPair(a, b) {
  if (a.group === b.group) return false;
  const arm = g => g.startsWith('arm'), leg = g => g.startsWith('leg'), ga = a.group, gb = b.group;
  if (arm(ga) && arm(gb)) return !(a.name.endsWith(' hand') && b.name.endsWith(' hand'));
  if ((arm(ga) && leg(gb)) || (leg(ga) && arm(gb))) return true;
  if (leg(ga) && leg(gb)) return !a.name.includes('thigh') && !b.name.includes('thigh');
  if ((arm(ga) && gb === 'torso') || (ga === 'torso' && arm(gb))) return !(ga !== 'torso' ? a : b).name.includes('upper');
  if ((arm(ga) && gb === 'head') || (ga === 'head' && arm(gb))) return true;
  return false;
}
function segClosest(p1, q1, p2, q2) {   // closest points of segments p1q1, p2q2 -> [point on 1, point on 2]
  const d1 = v.sub(q1, p1), d2 = v.sub(q2, p2), r = v.sub(p1, p2);
  const a = v.dot(d1, d1), e = v.dot(d2, d2), f = v.dot(d2, r), c = v.dot(d1, r), b = v.dot(d1, d2), den = a * e - b * b;
  let sv = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0, t = e > 1e-12 ? (b * sv + f) / e : 0;
  if (t < 0) { t = 0; sv = a > 1e-12 ? Math.max(0, Math.min(1, -c / a)) : 0; } else if (t > 1) { t = 1; sv = a > 1e-12 ? Math.max(0, Math.min(1, (b - c) / a)) : 0; }
  return [v.add(p1, v.scale(d1, sv)), v.add(p2, v.scale(d2, t))];
}
function capsule(P, p) { let end = P[p.b]; if (p.extend) end = v.add(end, v.scale(v.norm(v.sub(P[p.b], P[p.a])), p.extend)); return [P[p.a], end]; }
// overlapping pairs: [{a, b, depth, normal (out of b, towards a)}]
function overlaps() {
  const ps = partsOf(), { positions: P } = fk(), out = [];
  for (let i = 0; i < ps.length; i++) for (let k = i + 1; k < ps.length; k++) {
    const A = ps[i], B = ps[k]; if (!checkPair(A, B)) continue;
    const [a0, a1] = capsule(P, A), [b0, b1] = capsule(P, B), [pa, pb] = segClosest(a0, a1, b0, b1);
    const d = v.len(v.sub(pa, pb)), depth = A.r + B.r - d;
    if (depth > 0) out.push({ key: A.name + '|' + B.name, A, B, depth, normal: d > 1e-6 ? v.scale(v.sub(pa, pb), 1 / d) : [0, 0, 1] });
  }
  return out;
}
function chainOfGroup(g) {   // 'arm-l' -> the Left hand chain
  const name = { 'arm-l': 'Left hand', 'arm-r': 'Right hand', 'leg-l': 'Left foot', 'leg-r': 'Right foot' }[g];
  return name && handles[name]?.chain ? { name, chain: handles[name].chain } : null;
}
function settleBody() {
  if (!edit || !bodyOn()) return;
  const base = edit.bodyBase || {};
  for (let it = 0; it < 5; it++) {
    const bad = overlaps().filter(o => o.depth > (base[o.key] || 0) + 0.005);
    if (!bad.length) return;
    for (const o of bad) {
      // the limb that moves: the one being edited if it is in the pair, else an arm before a leg, else either limb
      const ca = chainOfGroup(o.A.group), cb = chainOfGroup(o.B.group);
      let mover = null, sign = 1;
      if (ca && (selected === ca.name || !cb || (o.A.group.startsWith('arm') && !(cb && selected === cb.name)))) mover = ca;
      else if (cb) { mover = cb; sign = -1; }
      if (!mover) continue;
      const { positions } = fk(), push = v.scale(o.normal, sign * (o.depth - (base[o.key] || 0) + 0.004));
      solve(mover.chain, v.add(positions[mover.chain[2]], push), true);
    }
  }
}
function bodyBaseline() {
  if (!edit) return {};
  const keep = [edit.root, edit.rotations]; edit.root = edit.baseRoot; edit.rotations = edit.base.map(r => [...r]);
  const b = {}; for (const o of overlaps()) b[o.key] = o.depth; [edit.root, edit.rotations] = keep; return b;
}

// Auto-poser: while you pose, the closest real pose in the library (static/body/pose_index.*, built by
// tools/cleanup/build_pose_index.py: 57k poses from the clean clips) is shown as a ghost, snapped to the handles you
// moved (your hands, feet and hips stay where you put them; the rest of the body comes from the real pose) and run
// through the same rules (joint limits, solid body, hard floor). Apply suggestion takes it (undoable); Next shows
// the next-closest pose from another clip.
const suggestBox = document.querySelector('#suggestOn');
let poseIndex = null, poseIndexLoading = false, suggestTimer = null, suggestion = null, suggestRank = 0, savedGhost = null;
const streamsCache = new Map();
function loadPoseIndex() {
  if (poseIndex || poseIndexLoading) return;
  const names = viewer.skeleton.names; if (!(names.length === 30 && names.includes('LeftToeBase'))) return;
  poseIndexLoading = true;
  Promise.all([fetch('/static/body/pose_index.json').then(r => r.json()), fetch('/static/body/pose_index.f32').then(r => r.arrayBuffer())])
    .then(([meta, buf]) => { poseIndex = { ...meta, feats: new Float32Array(buf) }; poseIndexLoading = false; }).catch(() => { poseIndexLoading = false; });
}
const SUGGEST_JOINTS = ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot', 'Head'];
const handleJoint = { 'Left hand': 'LeftHand', 'Right hand': 'RightHand', 'Left foot': 'LeftFoot', 'Right foot': 'RightFoot', Look: 'Head' };
function yawOf(P) { const names = viewer.skeleton.names; const a = v.sub(P[names.indexOf('RightLeg')], P[names.indexOf('LeftLeg')]); a[1] = 0; const f = v.cross([0, 1, 0], v.norm(a)); return Math.atan2(f[0], f[2]); }
function poseFeatures(P) {
  const names = viewer.skeleton.names, yaw = yawOf(P), c = Math.cos(-yaw), sn = Math.sin(-yaw), out = [];
  for (const j of SUGGEST_JOINTS) { const r = v.sub(P[names.indexOf(j)], P[0]); out.push(r[0] * c + r[2] * sn, r[1], -r[0] * sn + r[2] * c); }
  out.push(P[0][1] - (viewer.state.floorY || 0)); return out;
}
// the closest index poses to the edited one: the moved handles count 4×, the rest 1×; the clip's own frame (±12) is out
function rankSuggestions(k = 3) {
  const { positions: P } = fk(), f = poseFeatures(P), w = [];
  const movedJ = new Set([...edit.moved].map(n => handleJoint[n]).filter(Boolean));
  for (const j of SUGGEST_JOINTS) { const wt = movedJ.has(j) ? 4 : 1; w.push(wt, wt, wt); }
  w.push(edit.moved.has('Hips') ? 4 : 2);
  const { feats, refs, clips, dims } = poseIndex, self = viewer.state.animation?.id, best = [];
  for (let i = 0; i < refs.length; i++) {
    const [ci, fr] = refs[i], cid = clips[ci];
    if (!library.find(cid) || (cid === self && Math.abs(fr - edit.frame) <= 12)) continue;
    let d = 0; const o = i * dims;
    for (let k2 = 0; k2 < dims; k2++) { const e = feats[o + k2] - f[k2]; d += w[k2] * e * e; if (best.length === k && d >= best[k - 1].d) break; }
    if (best.length < k || d < best[best.length - 1].d) {
      if (goneClips.has(clips[ci])) continue;
      const prev = best.findIndex(b => refs[b.i][0] === ci);           // one per clip
      if (prev >= 0) { if (best[prev].d <= d) continue; best.splice(prev, 1); }
      best.push({ i, d }); best.sort((a, b) => a.d - b.d); if (best.length > k) best.pop();
    }
  }
  const wsum = w.reduce((a, b) => a + b, 0);
  return best.map(b => ({ clip: clips[refs[b.i][0]], frame: refs[b.i][1], rmsCm: Math.sqrt(b.d / wsum) * 100 }));
}
// clips the pose index names that are gone (deleted since the index was built): never offered again
const goneClips = new Set();
async function streamsFor(id) {
  const get = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${r.status} ${url}`); return r.arrayBuffer(); }).then(b => new Float32Array(b));
  if (!streamsCache.has(id)) streamsCache.set(id, Promise.all([get(`/api/animations/${id}/root.f32`), get(`/api/animations/${id}/rotations.f32`)])
    .catch(e => { goneClips.add(id); streamsCache.delete(id); throw e; }));
  return streamsCache.get(id);
}
// the suggested pose: the library frame turned to the edited pose's heading, at its place, snapped to the moved handles
async function buildSuggestion(s1) {
  const [root, rots] = await streamsFor(s1.clip); const J = viewer.skeleton.parents.length, f = s1.frame;
  if (!edit) return null;
  const keep = { root: edit.root, rotations: edit.rotations };
  const targets = [...edit.moved].filter(n => handles[n]?.chain).map(n => ({ n, at: worldOf(n), turn: fk().global[handles[n].chain[2]] }));
  const { positions: Pcur } = fk(), yawCur = yawOf(Pcur);
  const rotations = []; for (let j = 0; j < J; j++) rotations.push([...rots.subarray((f * J + j) * 4, (f * J + j + 1) * 4)]);
  edit.root = [root[f * 3], root[f * 3 + 1], root[f * 3 + 2]]; edit.rotations = rotations;
  const turn = q.axisAngle([0, 1, 0], yawCur - yawOf(fk().positions));
  edit.rotations[0] = q.normalize(q.mul(turn, edit.rotations[0]));
  edit.root = edit.moved.has('Hips') ? [...keep.root] : [keep.root[0], root[f * 3 + 1] - (poseIndex.floor || 0.02) + (viewer.state.floorY || 0), keep.root[2]];
  for (const t of targets) { solve(handles[t.n].chain, t.at); const { global: G } = fk(), e = handles[t.n].chain[2], { parents } = viewer.skeleton; edit.rotations[e] = q.normalize(q.mul(q.conj(G[parents[e]]), t.turn)); }
  clampPose(); settleBody(); settleFloor(); clampPose();
  const out = { ...s1, root: [...edit.root], rotations: edit.rotations.map(r => [...r]) };
  edit.root = keep.root; edit.rotations = keep.rotations;
  return out;
}
function showSuggestion() {
  const hint = $('#suggestHint'), apply = $('#applySuggestion'), next = $('#nextSuggestion');
  const row = $('#suggestRow'); if (row) row.hidden = !suggestion || hidden;
  if (!suggestion || hidden) { if (hint) hint.textContent = ''; if (apply) apply.disabled = true; if (next) next.disabled = true; clearSuggestGhost(); return; }
  const J = viewer.skeleton.parents.length, g = viewer.ghost;
  if (!savedGhost && g.animation && g.animation.id !== 'suggestion') savedGhost = { ...g };
  Object.assign(g, { animation: { id: 'suggestion', frames: 1 }, root: new Float32Array(suggestion.root), rotations: new Float32Array(suggestion.rotations.flat()), parents: viewer.skeleton.parents, offsets: viewer.skeleton.offsets, align: 'none', offset: [0, 0, 0] });
  const clip = library.find(suggestion.clip);
  if (hint) hint.textContent = `Suggested: “${(clip?.name || 'a library clip').slice(0, 40)}” frame ${suggestion.frame + 1} — about ${Math.round(suggestion.rmsCm)} cm from your pose.`;
  if (apply) apply.disabled = false; if (next) next.disabled = false;
  viewer.draw();
}
function clearSuggestGhost() {
  const g = viewer.ghost;
  if (g.animation?.id === 'suggestion') { if (savedGhost) { Object.assign(g, savedGhost); savedGhost = null; } else g.animation = null; viewer.draw(); }
}
function scheduleSuggest() {
  clearTimeout(suggestTimer);
  if (!edit || !poseIndex || !(suggestBox?.checked ?? true) || !edit.moved.size) { suggestion = null; showSuggestion(); return; }
  suggestTimer = setTimeout(async () => {
    if (!edit) return;
    const ranked = rankSuggestions(3); if (!ranked.length) { suggestion = null; showSuggestion(); return; }
    suggestRank = 0; edit.suggestRanked = ranked;
    suggestion = null;
    for (const r of ranked) {   // the closest pose whose clip can still be read
      if (goneClips.has(r.clip)) continue;
      try { suggestion = await buildSuggestion(r); break; } catch { /* that clip is gone: the next one */ }
    }
    showSuggestion();
  }, 180);
}

// One turn of the dragged joint (or the whole spine): the bone's world turn from the start of the drag, put under its
// parent as the parent is now; with the hard floor on, the floor blocks it (the largest share of it that keeps every
// surface out of the floor). A deliberate turn of a foot, its toes or a hand is not flattened back by the floor rule.
// a share of a turn: the same axis, f times the angle
function qPow(r, f) {
  const w = Math.max(-1, Math.min(1, r[3])), a = 2 * Math.acos(w), sn = Math.sqrt(Math.max(0, 1 - w * w));
  if (sn < 1e-9) return [0, 0, 0, 1];
  return q.axisAngle([r[0] / sn, r[1] / sn, r[2] / sn], a * f);
}
function depthOfJoint(j) { let n = 0; for (let p = viewer.skeleton.parents[j]; p >= 0; p = viewer.skeleton.parents[p]) n++; return n; }
// the joints a turn moves: every selected ring (the whole spine counts as its three joints, a third each), parents first,
// each with its turn at the start of the drag
function turnItems(names) {
  const items = new Map();
  for (const n of names) for (const j of spineJoints(n) || [turnJoint(n)]) if (j >= 0) items.set(j, { j, frac: spineJoints(n) ? 1 / 3 : 1, L0: [...edit.rotations[j]] });
  return [...items.values()].sort((a, b) => depthOfJoint(a.j) - depthOfJoint(b.j));
}
function applyTurn(d, turn) {
  const { parents } = viewer.skeleton, items = d.items || (d.spine ? d.spine.map((j, i) => ({ j, frac: 1 / 3, L0: d.L0[i] })) : null), joints = items ? items.map(x => x.j) : [d.turn];
  const keep = joints.map(j => [...edit.rotations[j]]);
  const at = t => {
    const part = qPow(turn, t);
    if (items) {   // each joint turns about its own pivot, parents first, so a child carries its parent's turn and adds its own
      for (const x of items) edit.rotations[x.j] = [...x.L0];
      for (const x of items) { const G = fk().global; edit.rotations[x.j] = q.normalize(q.mul(q.conj(G[parents[x.j]] || [0, 0, 0, 1]), q.mul(qPow(part, x.frac), G[x.j]))); }
    } else edit.rotations[d.turn] = q.normalize(q.mul(q.conj(fk().global[parents[d.turn]] || [0, 0, 0, 1]), q.mul(part, d.G0)));
  };
  at(1);
  if (hardFloorOn()) {
    const allow = edit.allow || {}, under = () => Object.entries(sinkDepths()).some(([k, dd]) => dd > Math.max(FLOOR_TOL, allow[k] || 0));
    if (under()) { let lo = 0, hi = 1; for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; at(m); if (under()) hi = m; else lo = m; } at(lo); if (under()) joints.forEach((j, i) => { edit.rotations[j] = keep[i]; }); }
  }
  for (const j of joints) for (const h of Object.values(handles)) if (h.chain && limbEnds(h.chain).includes(j)) { edit.tilted = edit.tilted || new Set(); edit.tilted.add(h.chain[2]); }
  edit.moved.add(d.handle); for (const n of extra) edit.moved.add(n); push();
}

// Typed rotation of the selected joint: its turn under its parent as x, y, z degrees (applied x, then y, then z, in the
// joint's own axes). Joint limits and the floor apply as to any other change.
function toEuler(r) {
  const [x, y, z, w] = r, m00 = 1 - 2 * (y * y + z * z), m01 = 2 * (x * y - z * w), m02 = 2 * (x * z + y * w), m12 = 2 * (y * z - x * w), m22 = 1 - 2 * (x * x + y * y);
  const b = Math.asin(Math.max(-1, Math.min(1, m02)));
  return [Math.atan2(-m12, m22), b, Math.atan2(-m01, m00)].map(a => a * 180 / Math.PI);
}
const fromEuler = ([a, b, c]) => q.normalize(q.mul(q.mul(q.axisAngle([1, 0, 0], a * Math.PI / 180), q.axisAngle([0, 1, 0], b * Math.PI / 180)), q.axisAngle([0, 0, 1], c * Math.PI / 180)));
// Plain-word joint angle mapping: hinge joints (elbows & knees) expose one Bend angle; other joints expose Bend / Side / Twist.
function jointAngleSpec(name) {
  if (name === 'LeftForeArm') return [{ label: 'Bend', idx: 1, sign: -1 }];
  if (name === 'RightForeArm') return [{ label: 'Bend', idx: 1, sign: 1 }];
  if (name === 'LeftShin' || name === 'RightShin') return [{ label: 'Bend', idx: 0, sign: 1 }];
  if (/Shoulder|Arm|Hand/.test(name)) return [{ label: 'Bend', idx: 1, sign: 1 }, { label: 'Side', idx: 2, sign: 1 }, { label: 'Twist', idx: 0, sign: 1 }];
  if (/Foot|Toe/.test(name)) return [{ label: 'Bend', idx: 0, sign: 1 }, { label: 'Side', idx: 1, sign: 1 }, { label: 'Twist', idx: 2, sign: 1 }];
  return [{ label: 'Bend', idx: 0, sign: 1 }, { label: 'Side', idx: 2, sign: 1 }, { label: 'Twist', idx: 1, sign: 1 }];
}
for (const id of ['#jrx', '#jry', '#jrz']) document.querySelector(id)?.addEventListener('change', () => {
  const j = turnJoint(selected); if (j < 0 || !edit || spineJoints(selected)) return;
  const spec = jointAngleSpec(viewer.skeleton.names[j] || '');
  const e = toEuler(edit.rotations[j]);
  spec.forEach((s, idx) => {
    const inp = document.querySelector(['#jrx', '#jry', '#jrz'][idx]);
    if (inp) e[s.idx] = (+inp.value || 0) * s.sign;
  });
  snapshot(); edit.rotations[j] = fromEuler(e); edit.moved.add(selected); push();
});

// Axis rings (Turn mode): three rings round the selected joint, x red, y green, z blue, in the joint's own axes (Local)
// or the world's (World). Drag along a ring to rotate about its axis.
let ringSpace = (() => { try { return localStorage.getItem('understudy.ringSpace') || 'local'; } catch { return 'local'; } })();
let hotRing = -1;
function setRingSpace(sp) {
  ringSpace = sp; try { localStorage.setItem('understudy.ringSpace', sp); } catch {}
  document.querySelector('#ringLocal')?.classList.toggle('on', sp === 'local'); document.querySelector('#ringWorld')?.classList.toggle('on', sp === 'world'); viewer.draw();
}
document.querySelector('#ringLocal')?.addEventListener('click', () => setRingSpace('local'));
document.querySelector('#ringWorld')?.addEventListener('click', () => setRingSpace('world'));
const allSelected = () => [selected, ...extra].filter(n => turnJoint(n) >= 0);
function rings() {
  const j = turnJoint(selected); if (!edit || !turnMode || doll || hidden || j < 0) return [];
  const { positions: P, global: G } = fk(), c = P[j];
  // sized to the body and scaled smoothly with zoom so zoomed-out gimbals shrink and thin instead of swallowing the torso
  const spineAll = selected === 'turn:SpineAll', cs = viewer.project(c), dz = viewer.depthOf(c);
  const spanPx = viewer.figureSpanPx?.() ?? 260, zoomK = Math.max(0.36, Math.min(1, spanPx / 280));
  const px = n => { const e = viewer.unproject(cs[0] + n * viewer.scale(), cs[1], dz); return e ? v.len(v.sub(e, c)) : null; };
  const rMax = px((spineAll ? 72 : 48) * zoomK), rMin = px((spineAll ? 14 : 10) * zoomK), body = spineAll ? 0.19 : 0.105;
  const r = rMax == null ? 0.11 : Math.max(rMin ?? 0.025, Math.min(rMax, body));
  const axes = ringSpace === 'world' ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => v.norm(viewer.rotate(G[j], a)));
  return axes.map((a, i) => {
    const u = v.norm(v.cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), w = v.cross(a, u), points = [];
    for (let k = 0; k < 48; k++) { const t = k / 48 * Math.PI * 2; points.push(v.add(c, v.add(v.scale(u, Math.cos(t) * r), v.scale(w, Math.sin(t) * r)))); }
    return { axis: a, u, w, center: c, r, points, color: ['#ff5c5c', '#5cff8a', '#5cb8ff'][i], hot: hotRing === i, width: (hotRing === i ? 3.2 : 1.85) * Math.max(0.62, zoomK) };
  });
}
// Balance guide (on while posing; Rules ▾): where the body's weight is (its centre of mass, dropped to the floor) and
// what it stands on (the outline round every body surface touching the floor or a box). Green: the weight is over what it
// stands on, so the pose would hold. Red: it would tip. Nothing touching: no outline (in the air).
const MASS = [['Hips', 'Spine1', .14], ['Spine1', 'Spine2', .12], ['Spine2', 'Chest', .12], ['Chest', 'Neck1', .117], ['Neck1', 'Head', .03], ['Head', null, .051],
  ['LeftArm', 'LeftForeArm', .028], ['LeftForeArm', 'LeftHand', .016], ['LeftHand', 'LeftHandMiddleEnd', .006], ['RightArm', 'RightForeArm', .028], ['RightForeArm', 'RightHand', .016], ['RightHand', 'RightHandMiddleEnd', .006],
  ['LeftLeg', 'LeftShin', .1], ['LeftShin', 'LeftFoot', .0465], ['LeftFoot', 'LeftToeBase', .0145], ['RightLeg', 'RightShin', .1], ['RightShin', 'RightFoot', .0465], ['RightFoot', 'RightToeBase', .0145]];
const balanceBox = document.querySelector('#balanceOn');
try { if (balanceBox && localStorage.getItem('understudy.balance') === 'off') balanceBox.checked = false; } catch {}
balanceBox?.addEventListener('change', () => { try { localStorage.setItem('understudy.balance', balanceBox.checked ? 'on' : 'off'); } catch {} viewer.draw(); });
function hull(pts) {   // 2D convex hull (x, z), counter-clockwise
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
  for (const x of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], x) <= 0) lo.pop(); lo.push(x); }
  for (const x of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], x) <= 0) up.pop(); up.push(x); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
function outside(pt, poly) {   // how far a point is outside a polygon (0 inside); a point or a line counts as a 3 cm patch
  const segD = (p, a, b) => { const ab = [b[0] - a[0], b[1] - a[1]], L = ab[0] * ab[0] + ab[1] * ab[1] || 1e-12, t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L)); return Math.hypot(a[0] + ab[0] * t - p[0], a[1] + ab[1] * t - p[1]); };
  if (poly.length < 3) return Math.max(0, Math.min(...poly.map((a, i) => segD(pt, a, poly[(i + 1) % poly.length] || a))) - 0.03);
  let inside = true; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; if ((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]) < 0) { inside = false; break; } }
  return inside ? 0 : Math.min(...poly.map((a, i) => segD(pt, a, poly[(i + 1) % poly.length])));
}
export function balance() {
  if (!edit || !bodyProxy) return null;
  const { positions: P, global: G } = fk(), names = viewer.skeleton.names, J = n => names.indexOf(n);
  let m = 0; const c = [0, 0, 0];
  for (const [a, b, w] of MASS) { const ja = J(a); if (ja < 0) continue; const pb = b ? P[J(b)] : boneTip(ja, P, G); if (!pb) continue; for (let i = 0; i < 3; i++) c[i] += (P[ja][i] + pb[i]) / 2 * w; m += w; }
  for (let i = 0; i < 3; i++) c[i] /= m;
  const touch = [];
  names.forEach((n, j) => { const pts = bodyProxy[n]; if (!pts) return; for (const p of pts) { const w = v.add(P[j], viewer.rotate(G[j], p)), y = supportAt(w[0], w[2]); if (w[1] - y < 0.02) touch.push([w[0], w[2], y]); } });
  const poly = hull(touch.map(t => [t[0], t[1]])), off = poly.length ? outside([c[0], c[2]], poly) : null;
  const ys = poly.map(p => { const t = touch.find(t => t[0] === p[0] && t[1] === p[1]); return t ? t[2] : 0; });
  return { com: c, poly, ys, off };
}
function balanceGizmo() {
  if (!edit || !active || hidden || (balanceBox && !balanceBox.checked)) return [];
  const b = balance(); if (!b) return [];
  const color = b.off == null ? '#9aa0a6' : b.off < 0.005 ? '#7dffb0' : b.off < 0.05 ? '#ffd27f' : '#ff6b6b';
  const gy = supportAt(b.com[0], b.com[2]) + 0.004, out = [];
  if (b.poly.length >= 2) out.push({ color, points: b.poly.map((p, i) => [p[0], b.ys[i] + 0.004, p[1]]) });
  const dot = []; for (let k = 0; k < 20; k++) { const t = k / 20 * Math.PI * 2; dot.push([b.com[0] + Math.cos(t) * 0.035, gy, b.com[2] + Math.sin(t) * 0.035]); }
  out.push({ color, points: dot, hot: true }, { color, points: [b.com, [b.com[0], gy, b.com[2]]] });
  return out;
}
function turnBonePoints(name, P, G) {
  const names = viewer.skeleton.names;
  if (name === 'turn:SpineAll') {
    const js = [...SPINE, 'Neck1'].map(n => names.indexOf(n)).filter(k => k >= 0);
    return js.length >= 2 ? js.map(k => P[k]) : null;
  }
  const j = turnJoint(name);
  return j >= 0 ? [P[j], boneTip(j, P, G)] : null;
}
function turnBoneGizmo() {
  if (!turnMode || doll || !active || hidden || !edit) return [];
  const { positions: P, global: G } = fk(), out = [];
  for (const sName of allSelected()) {
    if (sName === hoverHandle && !drag) continue;
    const pts = turnBonePoints(sName, P, G);
    if (pts) out.push({ points: pts, color: '#ffd700', width: 2.8, alpha: .75, open: true, halo: true });
  }
  const hName = drag?.turn != null ? drag.handle : hoverHandle;
  if (hName && turnJoint(hName) >= 0) {
    const pts = turnBonePoints(hName, P, G);
    if (pts) out.push({ points: pts, color: '#ffffff', width: 4.2, alpha: 1, hot: true, open: true, halo: true });
  }
  return out;
}
viewer.setGizmoSource(() => [...balanceGizmo(), ...turnBoneGizmo(), ...rings(), ...dollGizmo()]);
// where the pointer is round a ring: the angle in the ring's plane (u, w), or null when the ring is seen nearly edge-on
function ringAngle(R, sx, sy) {
  const p1 = viewer.unproject(sx, sy, 1), p2 = viewer.unproject(sx, sy, 5); if (!p1 || !p2) return null;
  const dir = v.norm(v.sub(p2, p1)), dn = v.dot(dir, R.axis); if (Math.abs(dn) < 0.2) return null;
  const t = v.dot(v.sub(R.center, p1), R.axis) / dn, hit = v.sub(v.add(p1, v.scale(dir, t)), R.center);
  return Math.atan2(v.dot(hit, R.w), v.dot(hit, R.u));
}
// the ring under the pointer (within 7 px of its outline): { index, ring, point } or null
function ringHit(sx, sy) {
  let best = null, bestD = 7 * viewer.scale();
  rings().forEach((g, i) => {
    const pts = g.points.map(p => viewer.project(p));
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length], ab = [b[0] - a[0], b[1] - a[1]], L = ab[0] * ab[0] + ab[1] * ab[1] || 1;
      const t = Math.max(0, Math.min(1, ((sx - a[0]) * ab[0] + (sy - a[1]) * ab[1]) / L)), dd = Math.hypot(a[0] + ab[0] * t - sx, a[1] + ab[1] * t - sy);
      if (dd < bestD) { bestD = dd; best = { index: i, ring: g, point: g.points[k] }; }
    }
  });
  return best;
}

// Pins: a pinned hand or foot stays where it is in the world while anything else is moved or turned (the arm or leg
// bends to keep it); dragging the pinned handle itself moves the pin.
function pinOf(name) { return edit?.pins?.[name]; }
function togglePin(name) {
  if (!edit || !handles[name]?.chain) return;
  edit.pins = edit.pins || {};
  if (edit.pins[name]) delete edit.pins[name];
  else { const { positions: P, global: G } = fk(), e = handles[name].chain[2]; edit.pins[name] = { at: [...P[e]], turn: [...G[e]] }; }
  updateBar(); viewer.draw();
}
document.querySelector('#pinHandle')?.addEventListener('click', () => togglePin(selected));
function applyPins(except) {
  if (!edit?.pins) return;
  const { parents } = viewer.skeleton;
  for (const [name, pin] of Object.entries(edit.pins)) {
    const h = handles[name]; if (!h?.chain || name === except) continue;
    solve(h.chain, pin.at); const e = h.chain[2], G = fk().global; edit.rotations[e] = q.normalize(q.mul(q.conj(G[parents[e]]), pin.turn));
  }
}

// Foot roll: onto the ball (heel up, +) or back onto the heel (toes up, -), about the ball or the heel, the toes kept
// flat on a roll onto the ball; the leg bends to follow. Measured from the pose when the slider was first touched.
function heelPoint(foot, P, G) {
  const pts = bodyProxy?.[viewer.skeleton.names[foot]]; if (!pts) return v.add(P[foot], viewer.rotate(G[foot], [0, -0.07, -0.04]));
  let best = pts[0]; for (const p of pts) if (p[2] - p[1] * 0.5 < best[2] - best[1] * 0.5) best = p;   // back and low
  return v.add(P[foot], viewer.rotate(G[foot], best));
}
function rollFoot(name, deg) {
  const h = handles[name]; if (!edit || !h?.chain) return;
  const { names, parents } = viewer.skeleton, foot = h.chain[2];
  const toeJ = names.findIndex((n, k) => parents[k] === foot && /Toe/.test(n));
  edit.rollBase = edit.rollBase || {};
  if (!edit.rollBase[name]) { const { positions: P, global: G } = fk(); edit.rollBase[name] = { rotations: edit.rotations.map(r => [...r]), root: [...edit.root], footPos: [...P[foot]], footG: [...G[foot]], toePos: toeJ >= 0 ? [...P[toeJ]] : null, toeG: toeJ >= 0 ? [...G[toeJ]] : null, heel: heelPoint(foot, P, G) }; }
  const B = edit.rollBase[name];
  edit.rotations = B.rotations.map(r => [...r]); edit.root = [...B.root];
  const lateral = v.norm(viewer.rotate(B.footG, [1, 0, 0])), a = deg * Math.PI / 180;
  const pivot = a >= 0 ? (B.toePos || B.footPos) : B.heel;
  const R = q.axisAngle(lateral, a);   // + about the foot's x: heel up (on the ball); - : toes up (on the heel)
  const newPos = v.add(pivot, viewer.rotate(R, v.sub(B.footPos, pivot))), newG = q.normalize(q.mul(R, B.footG));
  solve(h.chain, newPos); let G = fk().global; edit.rotations[foot] = q.normalize(q.mul(q.conj(G[parents[foot]]), newG));
  if (toeJ >= 0 && a >= 0) { G = fk().global; edit.rotations[toeJ] = q.normalize(q.mul(q.conj(G[foot]), B.toeG)); }   // toes stay flat on the floor
  edit.tilted = edit.tilted || new Set(); edit.tilted.add(foot); edit.moved.add(name);
  if (edit.pins?.[name]) { const P2 = fk().positions, G2 = fk().global; edit.pins[name] = { at: [...P2[foot]], turn: [...G2[foot]] }; }
  push();
}
document.querySelector('#footRoll')?.addEventListener('input', e => { const d = +e.target.value; const out = document.querySelector('#footRollValue'); if (out) out.textContent = `${d}°`; rollFoot(selected, d); });
document.querySelector('#footRoll')?.addEventListener('pointerdown', () => { if (edit && selected && !edit.rollBase?.[selected]) snapshot(); });

// Pose tools: mirror the pose left <-> right (in the body's own frame, so it faces the same way), copy the pose,
// paste it (all of it, or one limb) onto this frame.
const LIMBS = { all: null, LeftArm: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'], RightArm: ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'],
  LeftLeg: ['LeftLeg', 'LeftShin', 'LeftFoot', 'LeftToeBase'], RightLeg: ['RightLeg', 'RightShin', 'RightFoot', 'RightToeBase'], Spine: ['Spine1', 'Spine2', 'Chest', 'Neck1', 'Neck2', 'Head'] };
const reflect = r => [r[0], -r[1], -r[2], r[3]];   // a turn seen in a mirror across the body's side-to-side plane (left = +x)
function headingQ(r0) { const f = viewer.rotate(r0, [0, 0, 1]); return q.axisAngle([0, 1, 0], Math.atan2(f[0], f[2])); }
function mirrorPose() {
  if (!edit) return; snapshot();
  const names = viewer.skeleton.names, src = edit.rotations.map(r => [...r]);
  edit.rotations = names.map((n, j) => { const m = n.startsWith('Left') ? 'Right' + n.slice(4) : n.startsWith('Right') ? 'Left' + n.slice(5) : n, k = names.indexOf(m); return reflect(src[k >= 0 ? k : j]); });
  const H = headingQ(src[0]); edit.rotations[0] = q.normalize(q.mul(H, reflect(q.mul(q.conj(H), src[0]))));
  for (const n of Object.keys(handles)) edit.moved.add(n);
  library.setStatus('Pose mirrored left ↔ right. Ctrl+Z undoes it.'); push();
}
let poseClip = null; try { poseClip = JSON.parse(localStorage.getItem('understudy.poseClipboard') || 'null'); } catch {}
function copyPose() {
  if (!edit) return;
  poseClip = { rotations: edit.rotations.map(r => [...r]), rootY: edit.root[1] - (viewer.state.floorY || 0), names: [...viewer.skeleton.names] };
  try { localStorage.setItem('understudy.poseClipboard', JSON.stringify(poseClip)); } catch {}
  library.setStatus(`Pose copied from frame ${edit.frame + 1}. Go to another frame (or clip), Handles on, Paste.`); updateBar();
}
function pastePose(part) {
  if (!edit || !poseClip) return; snapshot();
  const names = viewer.skeleton.names, idx = n => names.indexOf(n);
  if (part === 'all') {
    poseClip.names.forEach((n, i) => { const j = idx(n); if (j > 0) edit.rotations[j] = [...poseClip.rotations[i]]; });
    // the body turned to face the way it faces here, at this height
    const H = headingQ(edit.rotations[0]), Hc = headingQ(poseClip.rotations[0]);
    edit.rotations[0] = q.normalize(q.mul(H, q.mul(q.conj(Hc), poseClip.rotations[0])));
    edit.root = [edit.root[0], poseClip.rootY + (viewer.state.floorY || 0), edit.root[2]];
    for (const n of Object.keys(handles)) edit.moved.add(n);
  } else for (const n of LIMBS[part] || []) { const i = poseClip.names.indexOf(n), j = idx(n); if (i >= 0 && j >= 0) { edit.rotations[j] = [...poseClip.rotations[i]]; edit.moved.add('turn:' + n); } }
  library.setStatus(`Pasted ${part === 'all' ? 'the whole pose' : part.replace(/([a-z])([A-Z])/, '$1 $2').toLowerCase()}. Ctrl+Z undoes it.`); push();
}
document.querySelector('#mirrorPose')?.addEventListener('click', mirrorPose);
document.querySelector('#copyPose')?.addEventListener('click', copyPose);
for (const b of document.querySelectorAll('#pastePanel [data-paste]')) b.addEventListener('click', () => { document.querySelector('#pastePanel').hidden = true; pastePose(b.dataset.paste); });

function startEdit() {
  const st = viewer.state;
  if (!st.animation || !st.rotations) return false;
  const joints = viewer.skeleton.parents.length, f = st.frame;
  const rotations = [];
  for (let j = 0; j < joints; j++) rotations.push([...st.rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)]);
  edit = { frame: f, root: [...st.root.slice(f * 3, f * 3 + 3)], baseRoot: [...st.root.slice(f * 3, f * 3 + 3)], rotations, base: rotations.map(r => [...r]), moved: new Set(), history: [] };
  loadProxy(); edit.allow = baseAllow();    // what the clip already had through the floor stays allowed, no deeper
  loadLimits(); edit.limitBase = baseViolations();
  parts = null; edit.bodyBase = bodyBaseline();
  loadPoseIndex(); suggestion = null; showSuggestion();
  viewer.setOverride({ frame: f, root: edit.root, rotations: edit.rotations });
  return true;
}
function snapshot() { edit.history.push({ root: [...edit.root], rotations: edit.rotations.map(r => [...r]), moved: new Set(edit.moved) }); if (edit.history.length > 50) edit.history.shift(); }
function undo() { const h = edit?.history.pop(); if (!h) return; edit.root = h.root; edit.rotations = h.rotations; edit.moved = h.moved; push(); }
function push() { if (edit) { applyPins(drag?.handle); clampPose(); settleBody(); settleFloor(); clampPose(); if (drag && edit.pins?.[drag.handle] && handles[drag.handle]?.chain) { const e = handles[drag.handle].chain[2], { positions: P, global: G } = fk(); edit.pins[drag.handle] = { at: [...P[e]], turn: [...G[e]] }; } } viewer.setOverride({ frame: edit.frame, root: edit.root, rotations: edit.rotations }); updateBar(); viewer.draw(); scheduleSuggest(); if (!drag) scheduleAutoKey(); }
export function reset() { clearTimeout(autoTimer); autoPendingFrame = -1; edit = null; selected = null; hoverHandle = null; dollHover = null; extra.clear(); suggestion = null; showSuggestion(); viewer.setOverride(null); updateBar(); viewer.draw(); K.notifyPending?.(); }

function worldOf(name) {
  const h = handles[name]; if (!h || !edit) return null;
  const { positions, global } = fk();
  if (h.root) return [...edit.root];
  if (h.chain) return positions[h.chain[2]];
  if (h.pole) return positions[h.pole[1]];
  if (h.look != null) return v.add(positions[h.look], v.scale(v.norm(viewer.rotate(global[h.look], [0, 0, 1])), .25));
  return null;
}
// Turn mode (R): a ring on every joint; drag a ring to aim that bone at the mouse (its far end follows the pointer),
// Shift + drag twists it along its length, Alt is fine. Straighten sets the joint straight (its rest turn: a straight
// knee or elbow, a flat foot, straight toes and wrist, an upright back and neck: how it sits in a relaxed stand), Reset puts back the clip's own
// turn. Joint limits, the solid body and the hard floor apply as with every other move.
let turnMode = false;
let extra = new Set();   // more selected rings (Ctrl+click): ring turns, Straighten and Reset act on all of them
const TURN_JOINTS = [['SpineAll', 'Whole spine'], ['Spine1', 'Lower back'], ['Spine2', 'Mid back'], ['Chest', 'Chest'], ['Neck1', 'Neck'], ['Neck2', 'Upper neck'], ['Head', 'Head'],
  ['LeftShoulder', 'Left collar'], ['RightShoulder', 'Right collar'], ['LeftArm', 'Left shoulder'], ['RightArm', 'Right shoulder'],
  ['LeftForeArm', 'Left elbow'], ['RightForeArm', 'Right elbow'], ['LeftHand', 'Left wrist'], ['RightHand', 'Right wrist'],
  ['LeftLeg', 'Left hip'], ['RightLeg', 'Right hip'], ['LeftShin', 'Left knee'], ['RightShin', 'Right knee'],
  ['LeftFoot', 'Left ankle'], ['RightFoot', 'Right ankle'], ['LeftToeBase', 'Left toes'], ['RightToeBase', 'Right toes']];
const turnLabel = Object.fromEntries(TURN_JOINTS.map(([j, l]) => [j, l]));
const SPINE = ['Spine1', 'Spine2', 'Chest'];
// the joint a ring turns ('Whole spine' answers its middle joint; spineJoints lists the three it bends)
const turnJoint = name => !name?.startsWith('turn:') ? -1 : viewer.skeleton.names.indexOf(name.slice(5) === 'SpineAll' ? 'Spine2' : name.slice(5));
const spineJoints = name => name === 'turn:SpineAll' ? SPINE.map(n => viewer.skeleton.names.indexOf(n)).filter(j => j >= 0) : null;
// the point a bone's far end is at: its child joint (the middle finger for a wrist), or a little way along it
function boneTip(j, P, G) {
  const { names, parents, offsets } = viewer.skeleton, n = names[j];
  const pref = { LeftHand: 'LeftHandMiddleEnd', RightHand: 'RightHandMiddleEnd', Head: null, LeftToeBase: null, RightToeBase: null }[n];
  let c = pref !== undefined ? (pref ? names.indexOf(pref) : -1) : parents.findIndex((p, k) => p === j && !/Eye|Jaw|Thumb/.test(names[k]));
  if (c >= 0) return P[c];
  return v.add(P[j], viewer.rotate(G[j], n === 'Head' ? [0, 0.18, 0] : [0, -0.02, 0.07]));   // head: its top; toes: their tip
}
// Three ways to pose: Move (hand, foot and hips dots, IK), Turn (a ring on every joint), Doll (no dots or rings at all:
// the body part under the pointer is what you drag - a forearm turns the elbow, a thigh the hip, a hand or foot moves
// with its limb, the pelvis moves the body; click a part to select it, then type its angles or nudge it with the arrow
// keys for exact control). Doll is for editing with nothing in the way (owner, 2026-10-28).
let doll = false, dollHover = null, hoverHandle = null;
export function setPoseMode(mode) {
  doll = mode === 'doll'; turnMode = mode !== 'move'; extra.clear(); dollHover = null; hoverHandle = null;
  if (mode === 'move' && turnJoint(selected) >= 0) selected = null;
  for (const [id, m] of [['#moveMode', 'move'], ['#turnMode', 'turn'], ['#dollMode', 'doll']]) document.querySelector(id)?.classList.toggle('on', m === mode);
  try { localStorage.setItem('understudy.poseMode', mode); } catch {}
  updateBar(); viewer.draw();
}
export const poseMode = () => doll ? 'doll' : turnMode ? 'turn' : 'move';
export function setTurnMode(on) { setPoseMode(on ? 'turn' : 'move'); }
document.querySelector('#turnMode')?.addEventListener('click', () => setPoseMode('turn'));
document.querySelector('#moveMode')?.addEventListener('click', () => setPoseMode('move'));
document.querySelector('#dollMode')?.addEventListener('click', () => setPoseMode('doll'));
// the body parts Doll mode can grab: each bone from its joint to its far end; the hand and foot bones move their limb
// (IK), the pelvis moves the whole body
const DOLL_IK = { LeftHand: 'Left hand', RightHand: 'Right hand', LeftFoot: 'Left foot', RightFoot: 'Right foot', LeftToeBase: 'Left foot', RightToeBase: 'Right foot' };
function dollSegments() {
  if (!edit) return [];
  const { positions: P, global: G } = fk(), names = viewer.skeleton.names, out = [];
  for (const [j] of TURN_JOINTS) {
    if (j === 'SpineAll' || j === 'Neck2') continue;
    const k = names.indexOf(j); if (k < 0) continue;
    const ik = DOLL_IK[j]; if (ik && !handles[ik]) continue;
    out.push({ key: j, target: ik || 'turn:' + j, a: P[k], b: boneTip(k, P, G) });
  }
  const h = names.indexOf('Hips'), s1 = names.indexOf('Spine1');
  if (h >= 0 && handles.Hips) out.push({ key: 'Hips', target: 'Hips', a: P[h], b: s1 >= 0 ? v.scale(v.add(P[h], P[s1]), 0.5) : P[h] });
  return out;
}
function dollPick(sx, sy) {
  let best = null, bestD = 16 * viewer.scale();
  for (const sg of dollSegments()) {
    const a = viewer.project(sg.a), b = viewer.project(sg.b), ab = [b[0] - a[0], b[1] - a[1]], L = ab[0] * ab[0] + ab[1] * ab[1] || 1e-9;
    const t = Math.max(0, Math.min(1, ((sx - a[0]) * ab[0] + (sy - a[1]) * ab[1]) / L)), d = Math.hypot(a[0] + ab[0] * t - sx, a[1] + ab[1] * t - sy);
    if (d < bestD) { best = sg; bestD = d; }
  }
  return best;
}
// what each grabbable part is called (a shin, not a knee: the knee is where it turns)
const DOLL_NAME = { Spine1: 'Lower back', Spine2: 'Mid back', Chest: 'Chest', Neck1: 'Neck', Head: 'Head', LeftShoulder: 'Left collarbone', RightShoulder: 'Right collarbone',
  LeftArm: 'Left upper arm', RightArm: 'Right upper arm', LeftForeArm: 'Left forearm', RightForeArm: 'Right forearm', LeftHand: 'Left hand', RightHand: 'Right hand',
  LeftLeg: 'Left thigh', RightLeg: 'Right thigh', LeftShin: 'Left shin', RightShin: 'Right shin', LeftFoot: 'Left foot', RightFoot: 'Right foot', LeftToeBase: 'Left foot', RightToeBase: 'Right foot', Hips: 'Pelvis' };
const dollWhat = target => {
  const j = target?.startsWith('turn:') ? target.slice(5) : null;
  if (j) return `${DOLL_NAME[j] || j} (turns at the ${(turnLabel[j] || j).replace(/^(Left|Right) /, '').toLowerCase()})`;
  return { Hips: 'Pelvis (moves the whole body)' }[target] || `${target} (moves the ${/hand/i.test(target || '') ? 'arm' : 'leg'})`;
};
// the name of the part under the pointer or selected, on the stage beside its bone
function dollPoints() {
  if (!doll || !edit) return [];
  const segs = dollSegments(), out = [], seen = new Set();
  const pushSeg = (sg, hov, sel, drg) => {
    if (!sg || seen.has(sg.target)) return;
    seen.add(sg.target);
    out.push({ name: sg.target, label: DOLL_NAME[sg.key] || sg.key, world: v.scale(v.add(sg.a, sg.b), 0.5), segA: sg.a, segB: sg.b, kind: 'doll', hovered: hov, selected: sel, dragging: drg, moved: false });
  };
  if (drag) pushSeg(segs.find(x => x.target === drag.handle), false, drag.handle === selected, true);
  else if (dollHover) pushSeg(segs.find(x => x.key === dollHover), true, false, false);
  if (selected) pushSeg(segs.find(x => x.target === selected), false, true, drag?.handle === selected);
  return out;
}
// the part under the pointer (white) and the selected part (gold), drawn along the bone
function dollGizmo() {
  if (!doll || !active || hidden || !edit) return [];
  const out = [];
  for (const sg of dollSegments()) {
    const sel = sg.target === selected, hov = sg.key === dollHover && !drag;
    if (sel || hov) out.push({ points: [sg.a, sg.b], color: sel ? '#ffd700' : '#ffffff', hot: true });
  }
  return out;
}
// exact control: turn the selected joint a little about the camera's axes (arrow keys, the nudge buttons), or twist it
function nudgeJoint(kind, deg) {
  const j = turnJoint(selected); if (j < 0 || !edit) return false;
  const { positions: P, global: G } = fk(), c = P[j], s0 = viewer.project(c), dz = viewer.depthOf(c);
  const right = v.norm(v.sub(viewer.unproject(s0[0] + 20, s0[1], dz), c)), up = v.norm(v.sub(viewer.unproject(s0[0], s0[1] - 20, dz), c));
  const bone = v.norm(v.sub(boneTip(j, P, G), c));
  const axis = { left: up, right: up, up: right, down: right, twistL: bone, twistR: bone }[kind];
  const sign = { left: -1, right: 1, up: -1, down: 1, twistL: 1, twistR: -1 }[kind];
  snapshot();
  applyTurn({ handle: selected, turn: j, items: turnItems(allSelected()), G0: G[j] }, q.axisAngle(axis, sign * deg * Math.PI / 180));
  updateBar(); scheduleAutoKey(); return true;
}
for (const b of document.querySelectorAll('#jointNudge [data-nudge]')) b.addEventListener('click', e => nudgeJoint(b.dataset.nudge, e.shiftKey ? 5 : e.altKey ? 0.25 : 1));
try { const m = localStorage.getItem('understudy.poseMode'); if (m === 'doll' || m === 'turn') setTimeout(() => setPoseMode(m)); } catch {}
for (const [b, p] of [['#rulesButton', '#rulesPanel'], ['#poseMoreButton', '#poseMorePanel'], ['#pasteButton', '#pastePanel']]) {
  const button = document.querySelector(b), panel = document.querySelector(p); if (!button || !panel) continue;
  const syncOpen = () => button.classList.toggle('open', !panel.hidden);
  // a panel that opens inside the More menu scrolls into view (Guards sat below the fold)
  button.addEventListener('click', () => { panel.hidden = !panel.hidden; syncOpen(); if (!panel.hidden && panel.parentElement?.closest('#poseMorePanel')) requestAnimationFrame(() => panel.scrollIntoView({ block: 'nearest' })); });
  document.addEventListener('pointerdown', e => { if (!panel.hidden && !panel.contains(e.target) && !button.contains(e.target)) { panel.hidden = true; syncOpen(); } });
}
for (const d of document.querySelectorAll('#poseMorePanel details.pm-fold')) d.addEventListener('toggle', () => {
  if (d.open) for (const s of document.querySelectorAll('#poseMorePanel details.pm-fold')) if (s !== d) s.open = false;
});
document.querySelector('#straightenJoint')?.addEventListener('click', () => {
  const j = turnJoint(selected); if (j < 0 || !edit) return;
  // a relaxed stand's turn for this joint (static/body/soma30_limits.json 'neutral'); rest (the T-pose) only if it's missing
  snapshot();
  for (const x of turnItems(allSelected())) { const n = limits?.neutral?.rotations?.[viewer.skeleton.names[x.j]]; edit.rotations[x.j] = n ? [...n] : [0, 0, 0, 1]; }
  for (const n of allSelected()) edit.moved.add(n); push();
});
document.querySelector('#resetJoint')?.addEventListener('click', () => {
  const j = turnJoint(selected); if (j < 0 || !edit) return;
  snapshot(); for (const x of turnItems(allSelected())) edit.rotations[x.j] = [...edit.base[x.j]]; push();
});

function handlePoints() {
  if (!edit) return [];
  const isDrag = n => drag?.handle === n;
  if (turnMode) {
    const { positions: P } = fk(), names = viewer.skeleton.names;
    return TURN_JOINTS.filter(([j]) => j === 'SpineAll' || names.includes(j)).map(([j, label]) => {
      const name = 'turn:' + j, k = turnJoint(name), sel = name === selected || extra.has(name);
      const minor = /^(LeftShoulder|RightShoulder|Neck2|Spine1|Spine2|LeftToeBase|RightToeBase)$/.test(j);
      if (j === 'SpineAll') { const { global: G } = fk(); const at = v.add(P[k], viewer.rotate(G[k], [0, 0, 0.22])); const changed = spineJoints(name).some(i => edit.rotations[i].some((c, n) => Math.abs(c - edit.base[i][n]) > 1e-4)); return { name, label, world: at, moved: changed, selected: sel, hovered: name === hoverHandle, dragging: isDrag(name), kind: 'turn', minor: false }; }
      const changed = edit.rotations[k].some((c, i) => Math.abs(c - edit.base[k][i]) > 1e-4);
      return { name, label, world: P[k], moved: changed, selected: sel, hovered: name === hoverHandle, dragging: isDrag(name), kind: 'turn', minor };
    });
  }
  return Object.keys(handles).map(name => ({ name, world: worldOf(name), moved: edit.moved.has(name), selected: name === selected, hovered: name === hoverHandle, dragging: isDrag(name), pinned: !!edit.pins?.[name], kind: handles[name].pole ? 'pole' : handles[name].look != null ? 'look' : 'end' }));
}
// Hide handles (V): the dots, labels and the suggestion ghost go away so the pose can be seen; the edited pose stays
// exactly as it is (nothing is undone or applied) until they are shown again
let hidden = false;
export function setHandlesHidden(on) {
  hidden = !!on;
  const b = document.querySelector('#hideHandles'); if (b) { b.textContent = hidden ? 'Show handles' : 'Hide handles'; b.classList.toggle('on', hidden); }
  if (hidden) { drag = null; hoverHandle = null; dollHover = null; clearSuggestGhost(); } else if (suggestion) showSuggestion();
  canvas.style.cursor = ''; viewer.draw();
}
export const handlesHidden = () => hidden;
document.querySelector('#hideHandles')?.addEventListener('click', () => setHandlesHidden(!hidden));
viewer.setHandleSource(() => active && !hidden ? (doll ? dollPoints() : handlePoints()) : []);

// Move a handle to a world point.
function moveTo(name, target) {
  const h = handles[name];
  if (h.root) {
    const planted = plantedEnds();
    // pinned hands and feet hold: the hips go only as far as the pinned limbs still reach (past that a pin gave way and
    // the feet came off the floor 16 cm)
    const prev = [...edit.root], pinned = Object.entries(edit.pins || {}).filter(([n]) => handles[n]?.chain).map(([n, pin]) => {
      const c = handles[n].chain, P0 = fk().positions; return { c, at: pin.at, reach: (v.len(v.sub(P0[c[0]], P0[c[1]])) + v.len(v.sub(P0[c[1]], P0[c[2]]))) * 0.995 };
    });
    const excess = () => { const P1 = fk().positions; return Math.max(0, ...pinned.map(x => v.len(v.sub(P1[x.c[0]], x.at)) - x.reach)); };
    if (pinned.length) {
      const e0 = excess(), place = t => { edit.root = prev.map((p0, i) => p0 + (target[i] - p0) * t); };
      place(1);
      const ok = () => excess() <= e0 + 1e-4;
      if (!ok()) {
        // first: the whole move across the floor with the hips lowered just enough (the knees bend, as a body does)
        const at = y => { edit.root = [target[0], y, target[2]]; };
        at(target[1] - 0.6);
        if (ok()) { let lo = target[1] - 0.6, hi = target[1]; for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; at(m); if (ok()) lo = m; else hi = m; } at(lo); }
        else { let lo = 0, hi = 1; for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; place(m); if (ok()) lo = m; else hi = m; } place(lo); }   // else: as far as it reaches
      }
      target = [...edit.root];
    }
    edit.root = [...target];
    // a limb planted on the floor stays planted when the hips move down (the knee or elbow bends); lifted with the
    // hips it comes up with them
    for (const p of planted) { const { positions } = fk(); if (positions[p.chain[2]][1] < p.at[1]) solve(p.chain, p.at, true); }
  }
  else if (h.chain) {
    // a hand or foot already on the floor stays planted while it slides along it: its sole or palm keeps its world
    // turn (solving without it tipped the foot 8° and lifted it 2 cm after a 15 cm slide)
    const onFloor = hardFloorOn() && endTouching(h.chain) && target[1] <= worldOf(name)[1] + 0.005;
    solve(h.chain, target, onFloor);
  }
  else if (h.pole) swing(h.pole, target);
  else if (h.look != null) look(h.look, target);
  edit.moved.add(name);
}

let autoPendingFrame = -1;
let fineOpen = (() => { try { return localStorage.getItem('understudy.poseFine') === '1'; } catch { return false; } })();

function updateBar() {
  bar.hidden = !active;
  const n = edit?.moved.size ?? 0;
  $('#pinTargets').disabled = !n; $('#applyEdit').disabled = !n; $('#regenAround').disabled = !n;
  const hold = n && !!keep.bounds(); $('#holdApply').disabled = !hold; $('#holdPin').disabled = !hold;
  $('#pinTargets').textContent = n ? `Pin ${[...edit.moved].filter(m => effectorName[m]).join(' + ') || 'pose'}` : 'Pin targets';
  const a = viewer.state.animation;
  $('#undoApply').hidden = !(a && a.edits > 0); $('#undoApply').textContent = a?.edits > 1 ? `Undo edit (${a.edits})` : 'Undo edit';
  $('#redoApply').hidden = !(a && a.redos > 0); $('#redoApply').textContent = a?.redos > 1 ? `Redo edit (${a.redos})` : 'Redo edit';
  const lock = axisLock ? ` · locked to ${axisLock.toUpperCase()}` : '';
  const what = selected ? (doll ? dollWhat(selected) : turnJoint(selected) >= 0 ? turnLabel[selected.slice(5)] || selected.slice(5) : selected) : '';
  $('#handleHint').textContent = !edit ? 'Pause a clip on a frame to pose it.'
    : `Frame ${edit.frame + 1}${what ? ` · ${what}` : ''}${n ? ` · ${n} changed` : ''}${lock} — ` + (turnMode
      ? (viewer.figureTiny?.() && !doll ? 'zoomed far out: zoom in (wheel) to pick a joint; drag a ring to turn the selected one.' : doll ? 'Doll: drag any body part (Shift: twist, Alt: fine). Click a part to set exact angles, or open Fine ▸ for nudges.' : 'hover a joint to highlight its bone; click to pick it, then drag a ring to turn it (Shift: twist, Alt: fine).')
      : 'drag a hand, a foot or the hips (smaller dots aim elbows, knees or head). Shift keeps it on the ground, Ctrl moves depth, Alt is fine.');
  const ks = $('#poseKeyState');
  if (ks) {
    if (!active || !edit) { ks.hidden = true; }
    else {
      const f = edit.frame, atFrame = K.keys().filter(k => k.frame === f), auto = K.autoKey();
      const liveEdit = n > 0 || autoPendingFrame === f;
      if (atFrame.length || (auto && liveEdit)) {
        const keyingNow = auto && !!drag && n > 0 && !atFrame.length;
        const bl = K.blend();
        const partNames = atFrame.length ? (atFrame.length >= K.PARTS.length ? 'whole body' : atFrame.map(k => K.partLabel[k.part].toLowerCase()).join(', ')) : 'pose';
        ks.hidden = false;
        ks.className = 'pose-key-state on';
        ks.textContent = keyingNow ? `◆ Keying frame ${f + 1}…` : `◆ Keyed at frame ${f + 1}`;
        ks.title = `Saved on the Keys timeline row at frame ${f + 1} (${partNames}; blends ±${bl} frames). Ctrl+Z undoes it.`;
      } else {
        ks.hidden = true;
      }
    }
  }
  const mc = $('#moveControls'), isEnd = (!turnMode || doll) && !!handles[selected]?.chain;
  if (mc) { mc.hidden = !isEnd; if (isEnd) { $('#moveName').textContent = selected; $('#pinHandle').textContent = edit?.pins?.[selected] ? 'Unpin' : 'Pin'; $('#pinHandle').classList.toggle('on', !!edit?.pins?.[selected]);
    const foot = /foot/i.test(selected); $('#rollControls').hidden = !foot; if (foot && !edit?.rollBase?.[selected]) { $('#footRoll').value = 0; $('#footRollValue').textContent = '0°'; } } }
  const pb = $('#pasteButton'); if (pb) pb.disabled = !poseClip;
  const rf = $('#jointRot');
  if (rf) { const j = turnJoint(selected), show = turnMode && j >= 0 && !spineJoints(selected) && !!edit; rf.hidden = !show;
    if (show) {
      const spec = jointAngleSpec(viewer.skeleton.names[j] || '');
      const e = toEuler(edit.rotations[j]);
      [['#jrl0', '#jrx'], ['#jrl1', '#jry'], ['#jrl2', '#jrz']].forEach(([lid, iid], idx) => {
        const wrap = $(lid), inp = $(iid), s = spec[idx];
        if (wrap) wrap.hidden = !s;
        if (!s || !inp) return;
        const lbl = wrap?.querySelector('.jr-lbl'); if (lbl) lbl.textContent = s.label;
        if (document.activeElement !== inp) inp.value = Math.round(e[s.idx] * s.sign) || 0;
      });
    } }
  const ft = $('#poseFineToggle'); if (ft) { ft.textContent = fineOpen ? 'Fine ▾' : 'Fine ▸'; ft.classList.toggle('open', fineOpen); ft.setAttribute('aria-expanded', fineOpen); }
  const fr = $('#poseFineRow'); if (fr) fr.hidden = !fineOpen;
  const ra = $('#ringLocal')?.parentElement; if (ra) ra.hidden = doll;
  const tc = $('#turnControls'); if (tc) { tc.hidden = !(turnMode && turnJoint(selected) >= 0); if (!tc.hidden) $('#turnName').textContent = (doll ? dollWhat(selected) : (turnLabel[selected.slice(5)] || selected.slice(5))) + (extra.size ? ` + ${extra.size} more` : ''); }
  // numeric fields follow the selection
  const fields = $('#handleFields');
  if (selected && edit && turnJoint(selected) < 0) {
    fields.hidden = false;
    const w = worldOf(selected);
    for (const [i, id] of ['#hx', '#hy', '#hz'].entries()) if (document.activeElement !== $(id)) $(id).value = w[i].toFixed(3);
    const rot = $('#handleRot'); const h = handles[selected];
    rot.hidden = !h.chain;
    if (h.chain) { const d = edit.rotDeg?.[selected] || [0, 0, 0]; for (const [i, id] of ['#hrx', '#hry', '#hrz'].entries()) if (document.activeElement !== $(id)) $(id).value = d[i]; }
  } else fields.hidden = true;
}

export function setActive(on) {
  active = on; button.classList.toggle('on', on); if (hidden) setHandlesHidden(false);
  if (on) { viewer.setPlaying(false); findChains(); if (!startEdit()) active = false; }
  else reset();
  updateBar(); viewer.draw();
}
export function isActive() { return active; }
export function hasSelection() { return active && !!selected; }
export function movedCount() { return edit ? edit.moved.size : -1; }
button.onclick = async () => {
  if (active && edit && edit.moved.size) {
    const { choose } = await import('./dialogs.js');
    const pick = await choose('Your pose changes aren’t applied yet', 'Turning Handles off throws them away. To just see the pose without the handles, hide them (V).',
      [{ value: 'hide', label: 'Hide handles, keep my changes' }, { value: 'discard', label: 'Turn off and discard changes' }], 'hide');
    if (pick === 'hide') { setHandlesHidden(true); return; }
    if (pick !== 'discard') return;
  }
  setActive(!active);
};

// New frame while editing: start over on that frame (edits are per frame).
viewer.onFrameChange(() => { if (active && edit && viewer.state.frame !== edit.frame) { startEdit(); selected = null; updateBar(); } });

// Dragging.
const toCanvas = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
canvas.addEventListener('pointerdown', e => {
  if (!active || !edit || hidden || e.button !== 0) return;
  const pts = handlePoints(); if (!pts.length) return;
  const [sx, sy] = toCanvas(e);
  if (doll) {   // Doll mode: the body part under the pointer is the handle; empty space turns the camera
    const hit = dollPick(sx, sy); if (!hit) return;
    e.stopImmediatePropagation(); e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch {}
    extra.clear(); selected = hit.target; snapshot(); if (edit.rollBase) edit.rollBase = {};
    beginDrag(hit.target, sx, sy); return;
  }
  const rh = turnMode ? ringHit(sx, sy) : null;
  if (rh) {
    e.stopImmediatePropagation(); e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch {}
    snapshot(); const g = rh.ring, j = turnJoint(selected), { global: G } = fk();
    // screen direction a positive turn moves the grabbed point, and pixels per radian there
    const tan = v.norm(v.cross(g.axis, v.sub(rh.point, g.center))), a0 = viewer.project(rh.point), a1 = viewer.project(v.add(rh.point, v.scale(tan, 0.01)));
    const sd = [a1[0] - a0[0], a1[1] - a0[1]], sl = Math.hypot(...sd) || 1e-6;
    drag = { handle: selected, turn: j, items: turnItems(allSelected()), start: [sx, sy], G0: G[j],
      ring: { axis: g.axis, center: g.center, u: g.u, w: g.w, last: 0, tangent: [sd[0] / sl, sd[1] / sl], pxPerRad: Math.max(57, sl / 0.01 * g.r) } };
    drag.ring.a0 = ringAngle(drag.ring, sx, sy);
    hotRing = rh.index; canvas.classList.add('dragging'); viewer.draw(); return;
  }
  let best = null, bestD = (turnMode ? Math.max(10, 18 * Math.min(1, (viewer.figureSpanPx?.() ?? 260) / 260)) : 18) * viewer.scale();
  for (const p of pts) { const s = viewer.project(p.world), d = Math.hypot(s[0] - sx, s[1] - sy); if (d < bestD) { best = p; bestD = d; } }
  if (!best) {
    // a trail dot of a hand or foot: go to that frame and pick up that handle
    const hit = viewer.trailHit(sx, sy);
    if (!hit) return;
    const name = { lhand: 'Left hand', rhand: 'Right hand', lfoot: 'Left foot', rfoot: 'Right foot' }[hit.joint];
    if (!handles[name]) return;
    viewer.setFrame(hit.frame); startEdit();
    best = { name, world: worldOf(name) };
  }
  e.stopImmediatePropagation(); e.preventDefault();
  if (turnMode && turnJoint(best.name) >= 0 && (e.ctrlKey || e.metaKey) && turnJoint(selected) >= 0) {
    if (best.name === selected) { const next = [...extra][0]; if (next) { extra.delete(next); selected = next; } }
    else if (extra.has(best.name)) extra.delete(best.name);
    else extra.add(best.name);
    updateBar(); viewer.draw(); return;
  }
  if (best.name !== selected && !extra.has(best.name)) extra.clear();
  else if (extra.has(best.name)) { extra.delete(best.name); if (selected) extra.add(selected); }
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  selected = best.name; snapshot(); if (edit.rollBase) edit.rollBase = {};
  beginDrag(best.name, sx, sy);
}, true);
// A drag on a handle (or a body part in Doll mode): a turn joint aims its bone at the pointer; a hand, foot or the hips
// moves (IK)
function beginDrag(name, sx, sy) {
  const tj = turnJoint(name);
  if (tj >= 0) {
    const { positions: P, global: G } = fk(), spine = spineJoints(name), names = viewer.skeleton.names;
    const pivot = spine ? spine[0] : tj, tip = spine ? P[names.indexOf('Neck1')] : boneTip(tj, P, G);
    drag = { handle: name, turn: tj, spine, L0: spine ? spine.map(j => [...edit.rotations[j]]) : null, start: [sx, sy], G0: G[tj], Gp: G[viewer.skeleton.parents[tj]] || [0, 0, 0, 1], joint: [...P[pivot]], tip: [...tip], tipDz: viewer.depthOf(tip), tipScreen: viewer.project(tip) };
    canvas.classList.add('dragging'); updateBar(); return;
  }
  const world = worldOf(name);
  drag = { handle: name, dz: viewer.depthOf(world), y: world[1], start: [sx, sy], startWorld: [...world], last: [sx, sy] };
  canvas.classList.add('dragging'); updateBar();
}
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  e.stopImmediatePropagation();
  let [sx, sy] = toCanvas(e);
  if (e.altKey) { sx = drag.start[0] + (sx - drag.start[0]) * .25; sy = drag.start[1] + (sy - drag.start[1]) * .25; } // fine
  if (drag.turn != null && !drag.ring) {
    const j = drag.turn, { parents } = viewer.skeleton;
    let turn;
    if (e.shiftKey) {   // twist along the bone: sideways mouse travel, 0.6° a pixel
      const axis = v.norm(v.sub(drag.tip, drag.joint)); turn = q.axisAngle(axis, (sx - drag.start[0]) * 0.6 * Math.PI / 180);
    } else {            // aim: the bone's far end follows the pointer (at its own depth from the camera)
      // the tip where the camera shows it now (the stage camera can still be gliding after a frame change)
      const ts = viewer.project(drag.tip), want = viewer.unproject(ts[0] + (sx - drag.start[0]), ts[1] + (sy - drag.start[1]), viewer.depthOf(drag.tip));
      if (!want) return;
      const joint = fk().positions[drag.spine ? drag.spine[0] : j];
      const a = v.norm(v.sub(drag.tip, drag.joint)), b = v.norm(v.sub(want, joint)), ang = Math.acos(Math.max(-1, Math.min(1, v.dot(a, b))));
      const ax = v.cross(a, b); turn = v.len(ax) > 1e-9 ? q.axisAngle(ax, ang) : [0, 0, 0, 1];
    }
    // a turn never moves anything else: the bone turns under its parent as the parent is now, and with the hard floor on
    // the floor blocks the turn (the largest share of it that keeps every surface out of the floor) instead of lifting
    // the limb (lifting fed back into the drag: the foot climbed 15 cm and stayed up)
    applyTurn(drag, turn); return;
  }
  if (drag.ring) {   // an axis ring: rotate about its axis by the angle the pointer has gone round the ring
    const R = drag.ring, a = ringAngle(R, sx, sy);
    let turn;
    if (a != null && R.a0 != null) { let d = a - R.a0; d -= Math.round((d - R.last) / (2 * Math.PI)) * 2 * Math.PI; R.last = d; turn = d; }
    else { const d = [sx - drag.start[0], sy - drag.start[1]]; turn = (d[0] * R.tangent[0] + d[1] * R.tangent[1]) / R.pxPerRad; }   // seen edge-on: along the ring, about 1° a pixel at most
    applyTurn(drag, q.axisAngle(R.axis, turn)); return;
  }
  let target;
  if (e.ctrlKey) { // depth: vertical mouse travel moves along the view direction
    const dz = drag.dz + (sy - drag.start[1]) * .004 * drag.dz;
    const s0 = viewer.project(drag.startWorld);
    target = viewer.unproject(s0[0], s0[1], dz);
  } else if (e.shiftKey) target = viewer.unprojectOnGround(sx, sy, drag.y);
  else target = viewer.unproject(sx, sy, drag.dz);
  if (!target) return;
  if (axisLock) { const i = { x: 0, y: 1, z: 2 }[axisLock]; const t = [...drag.startWorld]; t[i] = target[i]; target = t; }
  moveTo(drag.handle, target);
  push();
}, true);
const endDrag = e => { if (!drag) return; e.stopImmediatePropagation(); drag = null; hotRing = -1; canvas.classList.remove('dragging'); if (K.autoKey() && edit?.moved.size) autoPendingFrame = edit.frame; updateBar(); viewer.draw(); K.notifyPending?.(); scheduleAutoKey(80); };
// Hover: the cursor and stage label say when a handle (or a trail dot) is under the pointer.
canvas.addEventListener('pointermove', e => {
  if (!active || !edit || drag || hidden) { if (!drag) canvas.style.cursor = ''; return; }
  const [sx, sy] = toCanvas(e);
  if (doll) {
    const hit = dollPick(sx, sy), key = hit ? hit.key : null;
    if (key !== dollHover) { dollHover = key; viewer.draw(); }
    canvas.style.cursor = hit ? 'grab' : ''; return;
  }
  let best = null, bestD = (turnMode ? Math.max(10, 18 * Math.min(1, (viewer.figureSpanPx?.() ?? 260) / 260)) : 18) * viewer.scale();
  for (const p of handlePoints()) {
    const s = viewer.project(p.world), d = Math.hypot(s[0] - sx, s[1] - sy);
    if (d < bestD) { best = p; bestD = d; }
  }
  const nextHover = best ? best.name : null;
  if (nextHover !== hoverHandle) { hoverHandle = nextHover; viewer.draw(); }
  const over = !!best || !!viewer.trailHit(sx, sy);
  canvas.style.cursor = over ? 'pointer' : '';
});
canvas.addEventListener('pointerleave', () => {
  if (hoverHandle || dollHover) { hoverHandle = null; dollHover = null; viewer.draw(); }
  if (!drag) canvas.style.cursor = '';
});
canvas.addEventListener('pointerup', endDrag, true);
canvas.addEventListener('pointercancel', endDrag, true);

// Keys: axis locks, nudges, undo (only while the handles are active and nothing is being typed).
window.addEventListener('keydown', e => {
  if (!active || !edit) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  const k = e.key.toLowerCase();
  if (k === 'v' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setHandlesHidden(!hidden); return; }
  if (k === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && !hidden) { e.preventDefault(); setTurnMode(!turnMode); return; }
  if (hidden && !((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y'))) return;
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (edit.history.length) undo(); else undoEdit(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redoEdit(); return; }
  if (k === 'x' || k === 'y' || k === 'z') { if (e.ctrlKey || e.metaKey) return; axisLock = axisLock === k ? null : k; updateBar(); e.preventDefault(); return; }
  if (!selected) return;
  if (turnJoint(selected) >= 0) {
    const kind = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'twistL', PageDown: 'twistR' }[e.key];
    if (kind && nudgeJoint(kind, e.shiftKey ? 5 : e.altKey ? 0.25 : 1)) { e.preventDefault(); e.stopImmediatePropagation(); }
    return;
  }
  const step = e.shiftKey ? .05 : .01;
  let d = null;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { // along the camera's right
    const w = worldOf(selected), s = viewer.project(w), dz = viewer.depthOf(w);
    const right = v.norm(v.sub(viewer.unproject(s[0] + 20, s[1], dz), w));
    d = v.scale(right, (e.key === 'ArrowRight' ? 1 : -1) * step);
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const w = worldOf(selected), s = viewer.project(w), dz = viewer.depthOf(w);
    const up = v.norm(v.sub(viewer.unproject(s[0], s[1] - 20, dz), w));
    d = v.scale(up, (e.key === 'ArrowUp' ? 1 : -1) * step);
  } else if (e.key === 'PageUp' || e.key === 'PageDown') d = [0, (e.key === 'PageUp' ? 1 : -1) * step, 0];
  if (!d || turnJoint(selected) >= 0) return;
  e.preventDefault(); e.stopImmediatePropagation();
  snapshot(); moveTo(selected, v.add(worldOf(selected), d)); push();
}, true);

// Numeric fields.
for (const id of ['#hx', '#hy', '#hz']) $(id).addEventListener('change', () => {
  if (!selected || !edit) return;
  const t = [Number($('#hx').value), Number($('#hy').value), Number($('#hz').value)];
  if (t.some(x => !Number.isFinite(x))) return;
  snapshot(); moveTo(selected, t); push();
});
// Hand/foot orientation: Bend / Side / Twist degrees added to the joint's own rotation at this frame.
for (const id of ['#hrx', '#hry', '#hrz']) $(id).addEventListener('change', () => {
  if (!selected || !edit || !handles[selected].chain) return;
  const d = [Number($('#hrx').value) || 0, Number($('#hry').value) || 0, Number($('#hrz').value) || 0];
  edit.rotDeg = edit.rotDeg || {}; edit.rotDeg[selected] = d;
  const e = handles[selected].chain[2], jn = viewer.skeleton.names[e] || '';
  const eu = /Hand/.test(jn) ? [d[2], d[0], d[1]] : [d[0], d[1], d[2]];
  edit.tilted = edit.tilted || new Set(); edit.tilted.add(e);     // tilted on purpose: the floor does not flatten it back
  snapshot(); edit.rotations[e] = q.normalize(q.mul(edit.base[e], q.fromEuler(eu[0], eu[1], eu[2]))); edit.moved.add(selected); push();
});

$('#applySuggestion')?.addEventListener('click', () => {
  if (!edit || !suggestion) return;
  snapshot(); edit.root = [...suggestion.root]; edit.rotations = suggestion.rotations.map(r => [...r]);
  const used = suggestion; suggestion = null; showSuggestion();
  viewer.setOverride({ frame: edit.frame, root: edit.root, rotations: edit.rotations }); updateBar(); viewer.draw();
  library.setStatus(`Applied the suggested pose (from frame ${used.frame + 1} of “${library.find(used.clip)?.name || used.clip}”). Ctrl+Z undoes it.`);
});
$('#nextSuggestion')?.addEventListener('click', async () => {
  const r = edit?.suggestRanked; if (!r?.length) return;
  for (let k = 0; k < r.length; k++) {   // the next one whose clip can still be read
    suggestRank = (suggestRank + 1) % r.length; if (goneClips.has(r[suggestRank].clip)) continue;
    try { suggestion = await buildSuggestion(r[suggestRank]); break; } catch { /* gone: the next */ }
  }
  showSuggestion();
});
// on or off is remembered in this browser; off means no searching at all and no ghost
try { const saved = localStorage.getItem('understudy.poseSuggestions'); if (suggestBox && saved !== null) suggestBox.checked = saved === 'on'; } catch {}
suggestBox?.addEventListener('change', () => {
  try { localStorage.setItem('understudy.poseSuggestions', suggestBox.checked ? 'on' : 'off'); } catch {}
  if (!suggestBox.checked) { clearTimeout(suggestTimer); suggestion = null; showSuggestion(); } else scheduleSuggest();
});
export const suggestState = () => ({ suggestion, ranked: edit?.suggestRanked, indexLoaded: !!poseIndex });

// Pin what was moved as an end-effector constraint, or the whole edited pose.
$('#pinTargets').onclick = () => {
  if (!edit || !edit.moved.size) return;
  const joints = [...edit.moved].map(n => effectorName[n]).filter(Boolean);
  if (joints.length) addKeyframe({ type: 'end-effector', frame_indices: [edit.frame], joint_names: joints, root_positions: [[...edit.root]], local_joints_rot_xyzw: [edit.rotations.map(r => [...r])] });
  else addKeyframe({ type: 'fullbody', frame_indices: [edit.frame], root_positions: [[...edit.root]], local_joints_rot_xyzw: [edit.rotations.map(r => [...r])] });
  compose.flash();
  reset(); if (active) { startEdit(); updateBar(); }
};
$('#pinEditedPose').onclick = () => {
  if (!edit) return;
  addKeyframe({ type: 'fullbody', frame_indices: [edit.frame], root_positions: [[...edit.root]], local_joints_rot_xyzw: [edit.rotations.map(r => [...r])] });
  compose.flash();
  reset(); if (active) { startEdit(); updateBar(); }
};
$('#resetHandles').onclick = () => { reset(); if (active) { startEdit(); updateBar(); } };

// Pin a handle to a world point at the current frame (contact with another actor), as an end-effector target.
export function pinTo(name, world, label = '') {
  if (!active) setActive(true);
  if (!edit) return false;
  if (!handles[name]) return false;
  snapshot(); moveTo(name, world); push();
  const joints = [effectorName[name]].filter(Boolean);
  const k = { type: joints.length ? 'end-effector' : 'fullbody', frame_indices: [edit.frame], root_positions: [[...edit.root]], local_joints_rot_xyzw: [edit.rotations.map(r => [...r])] };
  if (joints.length) k.joint_names = joints;
  addKeyframe(k); compose.flash();
  library.setStatus(`${name} pinned${label ? ' to ' + label : ''} at frame ${edit.frame + 1}.`);
  return true;
}
// Point (point.js): a reaching pose that puts a hand or foot on a world point at a frame, pinned as an end-effector
// target. The model's hand and foot constraints also hold the root's position and heading on that frame, so the
// stance is chosen here, as a person would take it: the body faces the point and stands within reach of it with
// the point in front of the reaching shoulder; for a low point the hips come down and the back bends forward as far
// as the shoulder needs. Built from the clip's frame 0 pose (normally standing), not from whatever the clip is doing
// at the contact frame. The model only leans toward a hand pin, so the pin is marked reach and the server lands the
// hand on it after generation (reach.go). Returns { ok, residual (m), why }.
export function pinReach(limb, world, frame, label = '') { return pinReachMany([{ limb, world }], frame, label); }

// Several limbs on several points at one frame, one pose: two hands on a box's sides. The body faces the points'
// middle with it centred before the chest, bends until every hand reaches, and the palms turn to face each other.
export function pinReachMany(targets, frame, label = '') {
  const st = viewer.state;
  if (!st.animation || !st.rotations) return { ok: false, why: 'Put a clip on the stage first: its body is the one that reaches.' };
  findChains();
  for (const t of targets) if (!handles[t.limb]?.chain) return { ok: false, why: `This skeleton has no ${t.limb.toLowerCase()} to reach with.` };
  const limb = targets[0].limb, h = handles[limb], pair = targets.length > 1;
  const mid = [0, 1, 2].map(i => targets.reduce((a, t) => a + t.world[i], 0) / targets.length);
  const world = pair ? mid : targets[0].world;
  const { parents, names } = viewer.skeleton, joints = parents.length, rootIdx = parents.indexOf(-1);
  const base = []; for (let j = 0; j < joints; j++) base.push([...st.rotations.subarray(j * 4, j * 4 + 4)]);
  // the next clip starts at the X/Z origin (the model's canonical start), so the walk to the point is planned from there
  const standRoot = [0, st.root[1], 0];
  const saved = edit;
  edit = { frame, root: [...standRoot], baseRoot: [...standRoot], rotations: base.map(r => [...r]), base: base.map(r => [...r]), moved: new Set(), history: [] };
  loadProxy(); edit.allow = baseAllow(); loadLimits(); edit.limitBase = baseViolations(); parts = null; edit.bodyBase = bodyBaseline();

  const isHand = /hand/i.test(limb), side = /right/i.test(limb) ? 1 : -1;
  // Face the point from where the body stands at the start.
  const flat = a => { const l = Math.hypot(a[0], a[2]) || 1; return [a[0] / l, 0, a[2] / l]; };
  let dir = [world[0] - standRoot[0], 0, world[2] - standRoot[2]];
  const facing = flat(viewer.rotate(edit.rotations[rootIdx], [0, 0, 1]));
  dir = Math.hypot(dir[0], dir[2]) < 0.05 ? facing : flat(dir);
  const yaw = Math.atan2(dir[0], dir[2]) - Math.atan2(facing[0], facing[2]);
  edit.rotations[rootIdx] = q.normalize(q.mul(q.axisAngle([0, 1, 0], yaw), edit.rotations[rootIdx]));
  const rightAxis = [-dir[2], 0, dir[0]];   // the model faces +Z with its left on +X

  // Where to stand: within reach, the point before the reaching shoulder (a foot's point under that foot).
  const low = isHand ? Math.max(0, Math.min(1, (0.95 - Math.min(...targets.map(t => t.world[1]))) / 0.85)) : 0;
  const ahead = isHand ? 0.38 - 0.08 * low : 0.12, aside = pair ? 0 : isHand ? 0.17 : 0.1;
  // The hand's target is the wrist, set back from the point by the palm so the palm, not the wrist, lands on it.
  const PALM = isHand ? 0.07 : 0;
  const legs = ['Left foot', 'Right foot'].map(n => handles[n]?.chain).filter(Boolean);
  const spine = []; for (let j = parents[h.chain[0]]; j >= 0 && j !== rootIdx; j = parents[j]) if (/spine|chest/i.test(names[j])) spine.unshift(j);
  const upright = edit.rotations.map(r => [...r]);   // standing, turned to the point
  const armLength = c => { const P = fk().positions; return (v.len(v.sub(P[c[0]], P[c[1]])) + v.len(v.sub(P[c[1]], P[c[2]]))) * 0.97; };
  // how far the furthest hand is still short of its point
  const gap = () => Math.max(...targets.map(t => { const c = handles[t.limb].chain; return v.len(v.sub(fk().positions[c[0]], t.world)) - PALM - armLength(c); }));
  // A stance: standing `extra` m closer than `ahead`, the hips down `drop` m and the body leaned forward `lean` rad --
  // two thirds of it at the hips (the pelvis tips over the thighs, the hip hinge of a real pickup), a third in the
  // back -- with the hips pushed back to balance the lean and the feet kept flat where they stood. If the legs cannot
  // reach the floor from there the hips come down until they do (the knees bend).
  let sign = 1;
  const stance = (extra, drop, lean) => {
    const c = [world[0] - dir[0] * (ahead - extra) - rightAxis[0] * side * aside, 0, world[2] - dir[2] * (ahead - extra) - rightAxis[2] * side * aside];
    for (let more = 0; more < 40; more++) {
      edit.rotations = upright.map(r => [...r]); edit.root = [c[0], standRoot[1], c[2]];
      const P0 = fk(), feet = legs.map(ch => ({ ch, at: [...P0.positions[ch[2]]], turn: P0.global[ch[2]] }));
      edit.rotations[rootIdx] = q.normalize(q.mul(q.axisAngle(rightAxis, sign * lean * 0.65), upright[rootIdx]));
      for (const j of spine) { const G = fk().global; edit.rotations[j] = q.normalize(q.mul(q.conj(G[parents[j]]), q.mul(q.axisAngle(rightAxis, sign * lean * 0.35 / spine.length), G[j]))); }
      const back = 0.22 * Math.min(1, lean / (Math.PI / 2)), d = drop + more * 0.01;
      edit.root = [c[0] - dir[0] * back, standRoot[1] - d, c[2] - dir[2] * back];
      let worst = 0;
      for (const f of feet) {
        solve(f.ch, f.at);
        const G = fk().global; edit.rotations[f.ch[2]] = q.normalize(q.mul(q.conj(G[parents[f.ch[2]]]), f.turn));
        worst = Math.max(worst, v.len(v.sub(fk().positions[f.ch[2]], f.at)));
      }
      if (worst < 0.01) return d;
    }
    return drop + 0.4;
  };
  // Which way round "forward" is for a lean about the right axis.
  stance(0, 0, 0); const sh0 = fk().positions[h.chain[0]]; stance(0, 0, 0.3);
  if (v.dot(v.sub(fk().positions[h.chain[0]], sh0), dir) < 0) sign = -1;

  // Bend as a person does: first at the hips, knees soft -- the stoop the model makes on its own for "picks up from
  // the floor", trunk folded past level with the hips still high -- and only when the hinge runs out do the knees take
  // over; if even that cannot reach, step closer. (A pin crouched with the hips at 0.53 m made the model crawl the
  // whole clip to agree with it.)
  // Two hands lifting one thing (a box) bend the knees and keep the back flatter: a lifter's squat-hinge, not the
  // straight-legged stoop that reaches a mop.
  const MAX_LEAN = (pair ? 95 : 135) * Math.PI / 180, MAX_DROP = Math.max(0, standRoot[1] - 0.45);
  const soft = (pair ? 0.22 : 0.06) * low;
  let pick = { extra: 0, drop: soft, lean: 0 };
  stance(0, soft, 0);
  if (isHand && gap() > 0) {
    let found = false;
    for (let drop = soft; drop <= MAX_DROP + 1e-6 && !found; drop += 0.05) {
      stance(0, drop, MAX_LEAN);
      if (gap() > 0) continue;
      let lo = 0, hi = MAX_LEAN; for (let i = 0; i < 16; i++) { const m = (lo + hi) / 2; stance(0, drop, m); if (gap() > 0) lo = m; else hi = m; }
      pick = { extra: 0, drop, lean: hi }; found = true;
    }
    if (!found) {
      pick = { extra: 0, drop: MAX_DROP, lean: MAX_LEAN };
      for (let tries = 0; tries < 8; tries++) { stance(pick.extra, pick.drop, pick.lean); const g = gap(); if (g <= 0.005) break; pick.extra = Math.min(ahead + 0.25, pick.extra + g + 0.01); }
    }
  }
  pick.drop = stance(pick.extra, pick.drop, pick.lean);

  // The hand: its palm (40% of the way to the middle fingertip) on the point. Low down it turns palm-down with the
  // fingers reaching forward and a little down -- a hand left in line with the forearm put the fingers through the
  // floor -- and a point on the floor is taken from just above it; higher up the hand points along the reach. Two
  // hands on one thing (a box's sides) turn their palms to face each other instead of the floor.
  const offs = viewer.skeleton.offsets;
  const fromTo = (a, b) => { const c = v.cross(a, b), d = Math.max(-1, Math.min(1, v.dot(a, b))); return v.len(c) < 1e-6 ? [0, 0, 0, 1] : q.axisAngle(c, Math.acos(d)); };
  const perp = (a, axis) => v.norm(v.sub(a, v.scale(axis, v.dot(a, axis))));
  const placers = targets.map((t, ti) => {
    const ch = handles[t.limb].chain, wristJ = ch[2], tw = t.world, hand = /hand/i.test(t.limb);
    const kids = hand ? names.map((n, j) => [n, j]).filter(([, j]) => parents[j] === wristJ) : [];
    const tipJ = kids.find(([n]) => /middle/i.test(n))?.[1], thumbJ = kids.find(([n]) => /thumb/i.test(n))?.[1];
    const ground = Math.max(0, Math.min(1, (0.35 - tw[1]) / 0.25));
    let palmAt = hand && tw[1] < 0.06 ? [tw[0], 0.06, tw[2]] : tw;
    if (!hand && tw[1] < 0.15) {   // a foot on a floor point stands on it: the ankle at its standing height above it
      const keep = [edit.rotations, edit.root]; edit.rotations = upright.map(r => [...r]); edit.root = [...standRoot];
      const ankleY = fk().positions[wristJ][1]; edit.rotations = keep[0]; edit.root = keep[1];
      palmAt = [tw[0], ankleY, tw[2]];
    }
    // which way the palm faces, in the hand's own frame: toward the thigh on the standing frame
    let palmLocal = null;
    if (tipJ != null && thumbJ != null) {
      const keep = [edit.rotations, edit.root]; edit.rotations = upright.map(r => [...r]); edit.root = [...standRoot];
      const { positions: P0, global: G0 } = fk(); edit.rotations = keep[0]; edit.root = keep[1];
      palmLocal = v.norm(v.cross(offs[tipJ], offs[thumbJ]));
      const n0 = viewer.rotate(G0[wristJ], palmLocal), inward = v.sub(P0[rootIdx], P0[wristJ]);
      if (n0[0] * inward[0] + n0[2] * inward[2] < 0) palmLocal = v.scale(palmLocal, -1);
    }
    // a pair's palms face across to the other point, level
    let across = null;
    if (pair) { const o = targets[(ti + 1) % targets.length].world, d = [o[0] - tw[0], 0, o[2] - tw[2]], l = Math.hypot(d[0], d[2]) || 1; across = [d[0] / l, 0, d[2] / l]; }
    let handTurn = null;
    const wristTarget = () => {
      const sh = fk().positions[ch[0]], along = v.norm(v.sub(palmAt, sh));
      if (tipJ == null) return PALM && hand ? v.sub(palmAt, v.scale(along, PALM)) : palmAt;
      const forward = v.norm([dir[0], pair ? -0.6 : -0.35, dir[2]]);
      const reach = pair ? Math.max(ground, 0.5) : ground;
      const fingers = v.norm(v.add(v.scale(along, 1 - reach), v.scale(forward, reach)));
      const G = fk().global[wristJ];
      let turn = q.normalize(q.mul(fromTo(v.norm(viewer.rotate(G, offs[tipJ])), fingers), G));
      const wantPalm = across || (ground > 0 ? [0, -1, 0] : null), weight = across ? 1 : ground;
      if (palmLocal && wantPalm) {   // roll about the fingers until the palm faces the floor (or the other hand)
        const now = perp(viewer.rotate(turn, palmLocal), fingers), want = perp(wantPalm, fingers);
        const ang = Math.atan2(v.dot(v.cross(now, want), fingers), v.dot(now, want));
        turn = q.normalize(q.mul(q.axisAngle(fingers, ang * weight), turn));
      }
      handTurn = turn;
      return v.sub(palmAt, v.scale(viewer.rotate(turn, offs[tipJ]), 0.4));
    };
    return () => {
      const at = wristTarget(); solve(ch, at, !hand);   // a foot keeps its sole flat
      if (handTurn) { const G = fk().global; edit.rotations[wristJ] = q.normalize(q.mul(q.conj(G[parents[wristJ]]), handTurn)); }
      return { ch, at };
    };
  });
  const placeHand = () => placers.map(p => p());
  let aim = placeHand();
  clampPose(); settleBody(); settleFloor(); clampPose();
  aim = placeHand();   // the limits and the floor may have nudged it: back onto the point
  // The free hand hangs: posed against the torso it was carried out behind by the lean.
  const free = isHand && !pair ? handles[side > 0 ? 'Left hand' : 'Right hand'] : null;
  if (free?.chain && pick.lean > 0.2) {
    const P = fk().positions, sh = P[free.chain[0]], len = v.len(v.sub(sh, P[free.chain[1]])) + v.len(v.sub(P[free.chain[1]], P[free.chain[2]]));
    solve(free.chain, [sh[0] + dir[0] * 0.1, Math.max(0.12, sh[1] - len * 0.9), sh[2] + dir[2] * 0.1]);
  }
  // The eyes are on the point: the neck, then the head, each turn the face toward it by up to 25 degrees.
  const headJ = handles.Look?.look, neckJ = headJ != null ? parents[headJ] : -1;
  if (headJ != null) for (const j of [neckJ, headJ]) {
    if (j < 0 || j === rootIdx) continue;
    const { positions: P, global: G } = fk(), from = v.norm(viewer.rotate(G[headJ], [0, 0, 1])), to = v.norm(v.sub(world, P[headJ]));
    const ang = Math.min(Math.acos(Math.max(-1, Math.min(1, v.dot(from, to)))), 25 * Math.PI / 180);
    if (ang < 1e-4) continue;
    edit.rotations[j] = q.normalize(q.mul(q.conj(G[parents[j]]), q.mul(q.axisAngle(v.norm(v.cross(from, to)), ang), G[j])));
  }
  const residual = Math.max(...aim.map(a => v.len(v.sub(fk().positions[a.ch[2]], a.at))));

  const k = { type: 'end-effector', frame_indices: [frame], joint_names: targets.map(t => effectorName[t.limb]), root_positions: [[...edit.root]],
    local_joints_rot_xyzw: [edit.rotations.map(r => [...r])], label: label || `Point · ${targets.map(t => t.limb.toLowerCase()).join(' + ')} @${frame + 1}`, reach: true };   // reach: the server lands the hand, or plants the foot, exactly (reach.go)
  addKeyframe(k); compose.flash();
  // show the reach on its frame until the frame changes
  const shown = Math.min(frame, st.animation.frames - 1);
  viewer.setPlaying(false); viewer.setFrame(shown); viewer.setOverride({ frame: shown, root: [...edit.root], rotations: edit.rotations.map(r => [...r]) });
  edit = saved;
  return { ok: true, residual };
}

// Hold: the moved handles stay where they were put across the keep range. Every frame of
// the range is solved from the clip's own pose of that frame toward the same world targets,
// so the rest of the body keeps moving while the held hand/foot/hips stay.
function solveRange(from, to) {
  const st = viewer.state, joints = viewer.skeleton.parents.length;
  const targets = [...edit.moved].map(name => ({ name, world: worldOf(name) }));
  const saved = edit;
  const keys = []; let residual = 0, short = 0;
  for (let f = from; f <= to; f++) {
    const rotations = [];
    for (let j = 0; j < joints; j++) rotations.push([...st.rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)]);
    edit = { frame: f, root: [...st.root.slice(f * 3, f * 3 + 3)], baseRoot: [...st.root.slice(f * 3, f * 3 + 3)], rotations, base: rotations.map(r => [...r]), moved: new Set(), history: [] };
    edit.allow = baseAllow(); edit.limitBase = baseViolations(); edit.bodyBase = bodyBaseline();
    for (const t of targets) if (t.world) moveTo(t.name, t.world);
    // the same rules as posing one frame: joint limits, solid body, hard floor, on every frame of the hold
    clampPose(); settleBody(); settleFloor(); clampPose();
    for (const t of targets) if (t.world) { const w = worldOf(t.name); const d = Math.hypot(w[0] - t.world[0], w[1] - t.world[1], w[2] - t.world[2]); residual = Math.max(residual, d); if (d > .03) short++; }
    keys.push({ frame: f, root: [...edit.root], rotations: edit.rotations.map(r => [...r]) });
  }
  edit = saved;
  return { keys, joints: targets.map(t => effectorName[t.name]).filter(Boolean), residual, short };
}
$('#holdApply').onclick = async () => {
  const a = viewer.state.animation, b = keep.bounds(); if (!edit || !edit.moved.size || !b) return;
  const { keys, residual, short } = solveRange(b[0], b[1]);
  const falloff = Number($('#applyFalloff').value) || 12, frame = viewer.state.frame;
  const reach = short ? ` ${short} frame${short === 1 ? '' : 's'} could not reach (up to ${Math.round(residual * 100)} cm short — the body moves away; hold the hips too, or shorten the range).` : '';
  try {
    library.setStatus(`Holding ${[...edit.moved].join(' + ')} over frames ${b[0] + 1}–${b[1] + 1}…`);
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'pose', keys, falloff, in_place: true }) });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json();
    await library.refresh();
    await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
    library.setStatus(`Hold baked over frames ${b[0] + 1}–${b[1] + 1}, eased ±${falloff}.${reach} Undo in the Handles bar.`);
    if (active) { startEdit(); selected = null; updateBar(); }
  } catch (e) { library.setStatus(e.message, 'error'); }
};
$('#holdPin').onclick = () => {
  const b = keep.bounds(); if (!edit || !edit.moved.size || !b) return;
  const { keys, joints } = solveRange(b[0], b[1]);
  const step = Math.max(1, Math.ceil(keys.length / 20)); // upstream's guidance: about 20 keys per constraint
  const picked = keys.filter((k, i) => i % step === 0 || i === keys.length - 1);
  const c = { type: joints.length ? 'end-effector' : 'fullbody', frame_indices: picked.map(k => k.frame), root_positions: picked.map(k => k.root), local_joints_rot_xyzw: picked.map(k => k.rotations) };
  if (joints.length) c.joint_names = joints;
  c.keep = { from: viewer.state.animation.id, name: `hold ${[...edit.moved].join(' + ')}`, frames: [b[0], b[1]], part: 'hold', step };
  addKeyframe(c); compose.flash();
  library.setStatus(`Pinned a hold of ${[...edit.moved].join(' + ')} over frames ${b[0] + 1}–${b[1] + 1} (${picked.length} keys).`);
};

// Fix hand-in-head: on every frame where a hand sinks into the head, move the wrist just
// outside the skull (two-bone IK on that frame's own pose) and bake it all with a short ease.
$('#fixClipping').onclick = async () => {
  const a = viewer.state.animation; if (!a) return;
  const clipview = await import('./clipview.js');
  const bad = clipview.handHeadFrames();
  if (!bad.length) { library.setStatus('No hand sinks into the head on any frame.'); return; }
  if (!active) setActive(true);
  const frame = viewer.state.frame;
  try {
    library.setStatus(`Fixing ${bad.length} frame${bad.length === 1 ? '' : 's'} where a hand sinks into the head…`);
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'hands', in_place: true }) });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json();
    await library.refresh();
    await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
    const left = clipview.handHeadFrames().length;
    library.setStatus(`Hands pushed out of the head on ${bad.length} frames${left ? `; ${left} still touch (run it again)` : ''}. Undo in the Handles bar.`);
    if (active) { startEdit(); selected = null; updateBar(); }
  } catch (e) { library.setStatus(e.message, 'error'); }
};

// Fix hands through another actor (a scene): push my hands out of their head/torso on every
// frame they sink in, except around intended contacts, and bake with a short ease.
export async function fixCrossClipping(extra, keepFrames = []) {
  const a = viewer.state.animation; if (!a || !extra) return 0;
  const clipview = await import('./clipview.js');
  const skip = new Set(); for (const f of keepFrames) for (let d = -6; d <= 6; d++) skip.add(f + d);
  const bad = clipview.crossHandFrames(extra, skip);
  if (!bad.length) return 0;
  if (!active) setActive(true);
  const st = viewer.state, joints = viewer.skeleton.parents.length, saved = edit, keys = [];
  const byFrame = new Map(); for (const b of bad) { if (!byFrame.has(b.frame)) byFrame.set(b.frame, []); byFrame.get(b.frame).push(b); }
  for (const [f, list] of byFrame) {
    const rotations = []; for (let j = 0; j < joints; j++) rotations.push([...st.rotations.subarray((f * joints + j) * 4, (f * joints + j + 1) * 4)]);
    edit = { frame: f, root: [...st.root.slice(f * 3, f * 3 + 3)], baseRoot: [...st.root.slice(f * 3, f * 3 + 3)], rotations, base: rotations.map(r => [...r]), moved: new Set(), history: [] };
    edit.allow = baseAllow(); edit.limitBase = baseViolations(); edit.bodyBase = bodyBaseline();
    for (const b of list) if (handles[b.hand]) moveTo(b.hand, b.target);
    clampPose(); settleBody(); settleFloor(); clampPose();   // the posing rules hold here too
    keys.push({ frame: f, root: [...edit.root], rotations: edit.rotations.map(r => [...r]) });
  }
  edit = saved;
  const frame = viewer.state.frame;
  const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'pose', keys, falloff: 4, in_place: true }) });
  if (!r.ok) throw new Error(await r.text());
  const updated = await r.json();
  await library.refresh();
  await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
  if (active) { startEdit(); selected = null; updateBar(); }
  return byFrame.size;
}

// Hand track: shapes from the current frame on, saved on the clip (character.js reads it).
async function saveHandTrack(keys) {
  const a = viewer.state.animation; if (!a) return;
  try { await library.patch(a.id, { hand_track: keys }); await library.refresh(); const fresh = library.find(a.id); if (fresh) viewer.state.animation.hand_track = fresh.hand_track; viewer.draw(); }
  catch (e) { library.setStatus(e.message, 'error'); }
}
function syncHandSelects() {
  const a = viewer.state.animation, f = viewer.state.frame; if (!a) return;
  let cur = null; for (const k of a.hand_track || []) { if (k.frame <= f) cur = k; else break; }
  $('#handL').value = cur?.left || 'auto'; $('#handR').value = cur?.right || 'auto';
}
$('#handKeySet').onclick = () => {
  const a = viewer.state.animation; if (!a) return;
  const f = viewer.state.frame, keys = (a.hand_track || []).filter(k => k.frame !== f);
  keys.push({ frame: f, left: $('#handL').value, right: $('#handR').value });
  keys.sort((p, q) => p.frame - q.frame);
  saveHandTrack(keys); library.setStatus(`Hands from frame ${f + 1}: ${$('#handL').value} / ${$('#handR').value}.`);
};
$('#handKeyClear').onclick = () => {
  const a = viewer.state.animation; if (!a) return;
  saveHandTrack((a.hand_track || []).filter(k => k.frame !== viewer.state.frame));
};
viewer.onFrameChange(syncHandSelects);

// Apply: bake the edited frame into the clip itself, easing in over the falloff on both sides.
$('#applyEdit').onclick = async () => {
  if (!edit || !edit.moved.size) return;
  const a = viewer.state.animation, frame = edit.frame, falloff = Number($('#applyFalloff').value) || 12;
  try {
    library.setStatus('Applying the edit…');
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'pose', frame, root: edit.root, rotations: edit.rotations, falloff, in_place: true }) });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json();
    await library.refresh();
    await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
    library.setStatus(`Edit applied at frame ${frame + 1}, eased over ±${falloff} frames. Undo in the Handles bar.`);
    if (active) { startEdit(); selected = null; updateBar(); }
  } catch (e) { library.setStatus(e.message, 'error'); }
};
async function stepHistory(op) {
  const a = viewer.state.animation; if (!a) return;
  try {
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op }) });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json(); const frame = viewer.state.frame;
    await library.refresh();
    await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
    library.setStatus(op === 'undo_pose' ? `Edit undone (${updated.edits || 0} left to undo).` : `Edit redone (${updated.redos || 0} left to redo).`);
    if (active) { startEdit(); selected = null; }
    updateBar();
  } catch (e) { library.setStatus(e.message, 'error'); }
}
export const undoEdit = () => stepHistory('undo_pose');
export const redoEdit = () => stepHistory('redo_pose');
$('#undoApply').onclick = undoEdit;
$('#redoApply').onclick = redoEdit;
// Regenerate around: keep the clip outside a window around this frame, pin the edited pose, generate.
// Regenerate around the edited pose. Options (the scene director uses them): keepBefore /
// keepAfter decide whether the frames outside the window are kept as they are; `extra` adds
// constraints of its own (a root path the regenerated part must follow).
export function regenerateAround({ keepBefore = true, keepAfter = true, extra = [] } = {}) {
  if (!edit || !edit.moved.size) return false;
  const a = viewer.state.animation, st = viewer.state, f = edit.frame, W = Number($('#applyFalloff').value) || 12;
  if (compose.skeletonOf(a.model)?.skeleton_key !== compose.selectedSkeletonKey()) { library.setStatus('This clip is on a different skeleton than the selected motion model.', 'error'); return false; }
  const pose = { type: 'fullbody', frame_indices: [f], root_positions: [[...edit.root]], local_joints_rot_xyzw: [edit.rotations.map(r => [...r])] };
  compose.restore(a);
  const keeps = [];
  if (keepBefore && f - W - 1 >= 0) keeps.push(keep.buildKeep(a, st.root, st.rotations, 0, f - W - 1, 'body', 6));
  if (keepAfter && f + W + 1 <= a.frames - 1) keeps.push(keep.buildKeep(a, st.root, st.rotations, f + W + 1, a.frames - 1, 'body', 6));
  compose.replaceKeyframes([...keeps, pose, ...extra]);
  compose.setFirstHeading(typeof a.first_heading === 'number' ? a.first_heading : null);
  compose.setLineage({ free: [Math.max(0, f - W), Math.min(a.frames - 1, f + W)], edited_frame: f });
  compose.newSeed();
  library.setStatus(`Regenerating ±${W} frames around frame ${f + 1} through the edited pose…`);
  (window.generateNow || (() => $('#generate').click()))();
  return true;
}
$('#regenAround').onclick = () => regenerateAround();

// --- A pose measured from a photo or a video frame (js/mocap.js) ---
// T holds world points in the stage's space (metres, Y up): hips, lhip/rhip, lsh/rsh, lel/rel, lwr/rwr,
// lknee/rknee, lank/rank, ltoe/rtoe, nose, lear/rear, and optional lhandDir/lhandAcross (and r…) for the hands.
// The hips and chest turn to the hip and shoulder lines, the spine and neck share the turn between them,
// arms and legs are solved by two-bone IK toward the measured wrist/ankle with the elbow/knee as pole
// (the skeleton keeps its own bone lengths; the measured bend is kept by scaling the reach), hands and
// feet are aimed, the head turns to the ears/nose. Returns { root, rotations } with the root at T.hips.
const basis = (a, b) => { // rotation whose X axis is a and whose XY plane holds b
  const X = v.norm(a), Z = v.norm(v.cross(X, b)), Y = v.cross(Z, X);
  const [m00, m10, m20] = X, [m01, m11, m21] = Y, [m02, m12, m22] = Z, tr = m00 + m11 + m22;
  let r;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; r = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; r = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; r = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; r = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return q.normalize(r);
};
const slerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; const c = d < 0 ? b.map(x => -x) : b; d = Math.abs(d);
  if (d > 0.9995) return q.normalize(a.map((x, i) => x + (c[i] - x) * t));
  const th = Math.acos(d), s = Math.sin(th);
  return q.normalize(a.map((x, i) => (x * Math.sin((1 - t) * th) + c[i] * Math.sin(t * th)) / s));
};
// The skeleton's rest with elbows and knees slightly bent the way they bend, so IK keeps them anatomical.
function bentRest(ix) {
  const J = viewer.skeleton.parents.length, rot = Array.from({ length: J }, () => [0, 0, 0, 1]);
  const at = (n, axis, deg) => { const j = ix(n); if (j >= 0) rot[j] = q.axisAngle(axis, deg * Math.PI / 180); };
  at('LeftForeArm', [0, 1, 0], -20); at('RightForeArm', [0, 1, 0], 20);
  at('LeftShin', [1, 0, 0], 15); at('RightShin', [1, 0, 0], 15);
  return rot;
}
export function fitPose(T) {
  findChains();
  const { parents, offsets, names } = viewer.skeleton, ix = n => names.indexOf(n);
  const saved = edit;
  edit = { frame: 0, root: [...T.hips], rotations: bentRest(ix), base: [], moved: new Set(), history: [] };
  try {
    const setGlobal = (name, G) => { const j = ix(name); if (j < 0) return; const p = parents[j]; edit.rotations[j] = q.normalize(p < 0 ? G : q.mul(q.conj(fk().global[p]), G)); };
    const mid = (a, b) => v.scale(v.add(a, b), .5);
    const shC = mid(T.lsh, T.rsh), hipC = mid(T.lhip, T.rhip);
    const Gh = basis(v.sub(T.lhip, T.rhip), v.sub(shC, hipC));
    const Gc = basis(v.sub(T.lsh, T.rsh), v.sub(shC, hipC));
    setGlobal('Hips', Gh); setGlobal('Spine1', slerp(Gh, Gc, 1 / 3)); setGlobal('Spine2', slerp(Gh, Gc, 2 / 3)); setGlobal('Chest', Gc);
    // head: X along the ears (left), forward toward the nose; the neck shares the turn
    const fwd = v.sub(T.nose, mid(T.lear, T.rear));
    const earX = v.sub(T.lear, T.rear), Ghead = basis(earX, v.cross(fwd, earX)); // Y = forward × left = up
    setGlobal('Neck1', slerp(Gc, Ghead, 1 / 3)); setGlobal('Neck2', slerp(Gc, Ghead, 2 / 3)); setGlobal('Head', Ghead);
    // limbs: the measured reach as a share of the measured limb length, on the skeleton's own lengths
    const limb = (handle, a, b, c) => {
      const h = handles[handle]; if (!h) return;
      const P = fk().positions, [u, l, e] = h.chain;
      const len = v.len(offsets[l]) + v.len(offsets[e]), mlen = v.len(v.sub(T[b], T[a])) + v.len(v.sub(T[c], T[b]));
      if (!(mlen > 1e-4)) return;
      const k = len / mlen;
      solve(h.chain, v.add(P[u], v.scale(v.sub(T[c], T[a]), k)));
      swing(h.chain, v.add(P[u], v.scale(v.sub(T[b], T[a]), k)));
    };
    limb('Left hand', 'lsh', 'lel', 'lwr');
    limb('Right hand', 'rsh', 'rel', 'rwr');
    limb('Left foot', 'lhip', 'lknee', 'lank');
    limb('Right foot', 'rhip', 'rknee', 'rank');
    // hands: the rest hand points along its middle finger with the index side forward (+Z)
    for (const [side, key] of [['Left', 'l'], ['Right', 'r']]) {
      const dir = T[key + 'handDir'], across = T[key + 'handAcross'], hj = ix(side + 'Hand'), mj = ix(side + 'HandMiddleEnd');
      if (dir && across && hj >= 0 && mj >= 0) setGlobal(side + 'Hand', q.mul(basis(dir, across), q.conj(basis(offsets[mj], [0, 0, 1]))));
      // feet: the rest foot points at its toe joint; the shin's sideways axis keeps the roll
      const fj = ix(side + 'Foot'), tj = ix(side + 'ToeBase'), sj = ix(side + 'Shin');
      if (T[key + 'toe'] && fj >= 0 && tj >= 0 && sj >= 0) {
        const side3 = viewer.rotate(fk().global[sj], [1, 0, 0]);
        setGlobal(side + 'Foot', q.mul(basis(v.sub(T[key + 'toe'], T[key + 'ank']), side3), q.conj(basis(offsets[tj], [1, 0, 0]))));
      }
    }
    return { root: [...edit.root], rotations: edit.rotations.map(r => [...r]) };
  } finally { edit = saved; }
}
// World positions of every joint for a pose (for floor contact and checks).
export function positionsOf(root, rotations) {
  const saved = edit; edit = { root, rotations }; try { return fk().positions; } finally { edit = saved; }
}
// Show a fitted pose at the current frame as a handle edit: Pin pose, Apply and Regenerate around work on it.
export function loadExternalPose(pose, label = 'Pose from reference') {
  if (!active) setActive(true);
  if (!edit) return false;
  snapshot();
  edit.root = [...pose.root]; edit.rotations = pose.rotations.map(r => [...r]);
  edit.moved = new Set([label]); selected = null;
  push();
  return true;
}
updateBar();
// for tests: the axis rings on the stage and the pins
export const rigState = () => ({ rings: rings().map(g => ({ axis: g.axis, center: g.center, r: g.r, u: g.u, w: g.w, hot: g.hot })), drag: drag ? { ring: !!drag.ring, turn: drag.turn } : null, pins: edit?.pins ? Object.keys(edit.pins) : [], selected, turnMode, ringSpace });
// the Handles bar folds to its main row (mode, Hide, Rules, Apply) and the selected joint's controls; remembered
{
  const fold = document.querySelector('#poseFold'), poseBar = document.querySelector('#handleBar');
  const set = on => { poseBar?.classList.toggle('folded', on); if (fold) { fold.textContent = on ? 'More controls' : 'Fewer'; fold.title = on ? 'All the posing controls' : 'Fewer controls (the mode, Rules and Apply stay)'; } };
  let on = false; try { on = localStorage.getItem('understudy.poseFolded') === '1'; } catch {}
  set(on);
  fold?.addEventListener('click', () => { on = !on; set(on); try { localStorage.setItem('understudy.poseFolded', on ? '1' : '0'); } catch {} });
}

// Timeline keys (keys.js): the Key button keys the parts changed in this pose; after a key the pose starts again from
// the clip (which now passes through the key).
K.setPoseSource(() => edit ? { frame: edit.frame, pose: { root: edit.root, rotations: edit.rotations }, base: { root: edit.baseRoot, rotations: edit.base } } : null);
K.setPendingKeySource(() => active && edit && K.autoKey() && (edit.moved.size > 0 || autoPendingFrame === edit.frame) ? edit.frame : null);
let autoTimer = 0, autoKeying = false;
K.onChange(() => {
  // after a key the clip passes through the pose: start again from it, keeping what is selected and pinned (not while a
  // drag is going on: the pose being dragged is newer than the key)
  if (!active || !viewer.state.animation || drag || autoKeying) { updateBar(); return; }
  const keepSel = selected, keepPins = edit?.pins;
  if (startEdit()) { if (keepPins) edit.pins = keepPins; selected = keepSel; }
  updateBar(); viewer.draw();
});
// Auto key: a change is keyed once it is let go (a drag ends, a button or typed value applies), a moment later so a run
// of nudges is one key.
function scheduleAutoKey(delay = 280) {
  if (!K.autoKey() || !edit) return;
  if (edit.moved.size) { autoPendingFrame = edit.frame; updateBar(); K.notifyPending?.(); }
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    try {
      if (!drag && edit && edit.frame === viewer.state.frame && K.changedParts({ root: edit.root, rotations: edit.rotations }, { root: edit.baseRoot, rotations: edit.base }).length) {
        autoKeying = true;
        await K.keyHere();
      }
    } finally {
      autoKeying = false;
      autoPendingFrame = -1;
      if (active && viewer.state.animation && !drag) {
        const keepSel = selected, keepPins = edit?.pins;
        if (startEdit()) { if (keepPins) edit.pins = keepPins; selected = keepSel; }
      }
      updateBar();
      viewer.draw();
      K.notifyPending?.();
    }
  }, delay);
}
// a manual key cancels a pending auto key: both committing raced and the later, stale one dropped a key
document.querySelector('#keyPose')?.addEventListener('click', e => { clearTimeout(autoTimer); autoPendingFrame = -1; K.keyHere({ all: e.shiftKey }); });

// Fine posing tools (Joint/World axes + Swing/Tilt/Twist nudge buttons): folded under Fine ▸ by default, remembered
document.querySelector('#poseFineToggle')?.addEventListener('click', () => {
  fineOpen = !fineOpen;
  try { localStorage.setItem('understudy.poseFine', fineOpen ? '1' : '0'); } catch {}
  updateBar();
});
