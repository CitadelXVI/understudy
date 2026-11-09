// Clip capsules: the body parts the self-clip check tests, drawn on the stage
// for the current frame. Faint where clear, red where two parts overlap deeper
// than the check's limit — so "are the hands going into the legs?" can be
// answered by looking instead of guessing. Same parts, radii and pairs as
// metrics.go, kept in step by hand.
import * as viewer from './viewer.js';

const box = document.querySelector('#clipCapsules'), hint = document.querySelector('#clipHint');
let on = localStorage.getItem('understudy.clipCapsules') === 'on';
box.checked = on;
box.onchange = () => { on = box.checked; localStorage.setItem('understudy.clipCapsules', on ? 'on' : 'off'); if (!on) hint.textContent = ''; viewer.draw(); };

const CLIP_DEPTH = 0.04;
let parts = null, pairs = null, key = '';
function build() {
  const names = viewer.skeleton.names, lower = names.map(n => n.toLowerCase());
  const find = (...c) => { for (const n of c) { const i = lower.indexOf(n.toLowerCase()); if (i >= 0) return i; } return -1; };
  parts = []; const add = (name, group, a, b, r, extend = 0) => { if (a >= 0 && b >= 0 && a !== b) parts.push({ name, group, a, b, r, extend }); };
  for (const s of [['l', 'Left', 'left_'], ['r', 'Right', 'right_']]) {
    const [tag, pre, post] = s, arm = 'arm-' + tag, leg = 'leg-' + tag;
    add(pre + ' upper arm', arm, find(pre + 'Arm', post + 'shoulder'), find(pre + 'ForeArm', post + 'elbow'), .05);
    add(pre + ' forearm', arm, find(pre + 'ForeArm', post + 'elbow'), find(pre + 'Hand', post + 'wrist'), .04);
    add(pre + ' hand', arm, find(pre + 'Hand', post + 'wrist'), find(pre + 'HandMiddleEnd', pre + 'HandThumbEnd', post + 'wrist'), .03);
    add(pre + ' thigh', leg, find(pre + 'Leg', post + 'hip'), find(pre + 'Shin', post + 'knee'), .07);
    add(pre + ' shin', leg, find(pre + 'Shin', post + 'knee'), find(pre + 'Foot', post + 'ankle'), .055);
    add(pre + ' foot', leg, find(pre + 'Foot', post + 'ankle'), find(pre + 'ToeBase', post + 'foot'), .04);
  }
  add('torso', 'torso', find('Hips', 'pelvis'), find('Chest', 'spine3'), .13);
  add('neck', 'head', find('Neck1', 'neck'), find('Head', 'head'), .06);
  add('head', 'head', find('Neck1', 'neck'), find('Head', 'head'), .10, .2);
  const isArm = g => g.startsWith('arm'), isLeg = g => g.startsWith('leg');
  const check = (a, b) => {
    if (a.group === b.group) return false;
    if (isArm(a.group) && isArm(b.group)) return !(a.name.endsWith(' hand') && b.name.endsWith(' hand'));
    if ((isArm(a.group) && isLeg(b.group)) || (isLeg(a.group) && isArm(b.group))) return true;
    if (isLeg(a.group) && isLeg(b.group)) return !a.name.includes('thigh') && !b.name.includes('thigh');
    if ((isArm(a.group) && b.group === 'torso') || (a.group === 'torso' && isArm(b.group))) { const arm = a.group === 'torso' ? b : a; return !arm.name.includes('upper'); }
    if ((isArm(a.group) && b.group === 'head') || (a.group === 'head' && isArm(b.group))) return true;
    return false;
  };
  pairs = []; for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) if (check(parts[i], parts[j])) pairs.push([i, j]);
  key = names.join('|');
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
function segDist(p1, q1, p2, q2) { // closest distance between two segments
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) return Math.hypot(...r);
  if (a <= 1e-9) t = Math.max(0, Math.min(1, f / e));
  else { const c = dot(d1, r); if (e <= 1e-9) s = Math.max(0, Math.min(1, -c / a)); else { const b = dot(d1, d2), den = a * e - b * b; s = den ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0; t = (b * s + f) / e; if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); } } }
  return Math.hypot(...sub(add(p1, mul(d1, s)), add(p2, mul(d2, t))));
}
function endOf(pose, p) { const a = pose[p.a], b = pose[p.b]; if (!p.extend) return b; const d = sub(b, a), n = Math.hypot(...d) || 1; return add(b, mul(d, p.extend / n)); }

// Hands (and forearms) of this clip against another actor's head and torso, on a given pose pair.
function crossClips(mine, theirs, label) {
  if (key !== viewer.skeleton.names.join('|')) build();
  const out = [];
  const myParts = parts.filter(p => / hand$| forearm$/.test(p.name)), theirParts = parts.filter(p => p.name === 'head' || p.name === 'torso' || / hand$| forearm$/.test(p.name));
  for (const A of myParts) for (const B of theirParts) {
    const d = segDist(mine[A.a], endOf(mine, A), theirs[B.a], endOf(theirs, B));
    if (A.r + B.r - d > CLIP_DEPTH) out.push({ a: A, b: B, depth: A.r + B.r - d, label: `${A.name} × ${label}'s ${B.name} ${Math.round((A.r + B.r - d) * 100)} cm` });
  }
  return out;
}
// Every frame where a hand sinks into the head (own body), with where the hand should be pushed to.
export function handHeadFrames() {
  const a = viewer.state.animation; if (!a) return [];
  if (key !== viewer.skeleton.names.join('|')) build();
  const head = parts.find(p => p.name === 'head'); if (!head) return [];
  const out = [];
  for (let f = 0; f < a.frames; f++) {
    const pose = viewer.positionsAt(f); if (!pose) continue;
    const h0 = pose[head.a], h1 = endOf(pose, head);
    for (const hand of parts.filter(p => / hand$/.test(p.name))) {
      const d = segDist(pose[hand.a], endOf(pose, hand), h0, h1), depth = hand.r + head.r - d;
      if (depth <= CLIP_DEPTH) continue;
      // push the wrist straight away from the head axis by the overlap (+1 cm)
      const w = pose[hand.a], ax = sub(h1, h0), t = Math.max(0, Math.min(1, dot(sub(w, h0), ax) / (dot(ax, ax) || 1))), c = add(h0, mul(ax, t));
      const away = sub(w, c), n = Math.hypot(...away) || 1, target = add(w, mul(away, (depth + .01) / n));
      out.push({ frame: f, hand: hand.name.startsWith('Left') ? 'Left hand' : 'Right hand', depth, target });
    }
  }
  return out;
}

// Every frame where one of my hands sinks into another actor's head or torso, with the push-out target.
export function crossHandFrames(extra, skipFrames = new Set()) {
  const a = viewer.state.animation; if (!a) return [];
  if (key !== viewer.skeleton.names.join('|')) build();
  const hands = parts.filter(p => / hand$/.test(p.name)), theirs = parts.filter(p => p.name === 'head' || p.name === 'torso');
  const out = [];
  for (let f = 0; f < a.frames; f++) {
    if (skipFrames.has(f)) continue;
    const mine = viewer.positionsAt(f); if (!mine) continue;
    const fo = Math.max(0, Math.min(extra.animation.frames - 1, f - (extra.frameOffset || 0)));
    const other = viewer.extraSourceAt(extra, fo).pose;
    for (const hand of hands) for (const part of theirs) {
      const h0 = other[part.a], h1 = endOf(other, part);
      const d = segDist(mine[hand.a], endOf(mine, hand), h0, h1), depth = hand.r + part.r - d;
      if (depth <= CLIP_DEPTH) continue;
      const w = mine[hand.a], ax = sub(h1, h0), t = Math.max(0, Math.min(1, dot(sub(w, h0), ax) / (dot(ax, ax) || 1))), c = add(h0, mul(ax, t));
      const away = sub(w, c), n = Math.hypot(...away) || 1, target = add(w, mul(away, (depth + .01) / n));
      out.push({ frame: f, hand: hand.name.startsWith('Left') ? 'Left hand' : 'Right hand', depth, target, part: part.name });
    }
  }
  return out;
}

// Draw after the stage (registered with onDraw); uses the viewer's projection.
viewer.onDraw(() => {
  if (!on || !viewer.state.animation) return;
  const pose = viewer.pose(); if (!pose?.length) return;
  if (key !== viewer.skeleton.names.join('|')) build();
  const ctx = document.querySelector('#view').getContext('2d'), s = viewer.scale(), view = viewer.getView();
  const hot = new Set(), labels = [];
  for (const [i, j] of pairs) {
    const A = parts[i], B = parts[j];
    const d = segDist(pose[A.a], endOf(pose, A), pose[B.a], endOf(pose, B));
    if (A.r + B.r - d > CLIP_DEPTH) { hot.add(i); hot.add(j); labels.push(`${A.name} × ${B.name} ${Math.round((A.r + B.r - d) * 100)} cm`); }
  }
  // other actors on the stage: my hands into their head/torso, their hands into mine
  for (const e of viewer.extras) {
    const theirs = viewer.extraSource(e).pose;
    for (const c of crossClips(pose, theirs, e.label)) { hot.add(parts.indexOf(c.a)); labels.push(c.label); }
    for (const c of crossClips(theirs, pose, 'me')) labels.push(`${e.label}'s ${c.a.name} × my ${c.b.name} ${Math.round(c.depth * 100)} cm`);
  }
  ctx.save(); ctx.lineWidth = 1.2 * s;
  for (const [i, p] of parts.entries()) {
    const a = pose[p.a], b = endOf(pose, p), isHot = hot.has(i);
    ctx.strokeStyle = isHot ? 'rgba(255,70,70,.9)' : 'rgba(255,255,255,.22)'; ctx.fillStyle = isHot ? 'rgba(255,70,70,.18)' : 'rgba(255,255,255,.03)';
    const n = 5;
    for (let k = 0; k <= n; k++) {
      const w = add(a, mul(sub(b, a), k / n)), sc = viewer.project(w), dz = viewer.depthOf(w);
      const r = p.r * view.cameraZoom * s / Math.max(.2, dz);
      ctx.beginPath(); ctx.arc(sc[0], sc[1], r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  ctx.restore();
  hint.textContent = labels.length ? `· ${labels.join(', ')}` : '· clear on this frame';
});
