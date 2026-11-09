// Wrist clean-up, live: the same clamp-and-smooth as wrist.go, applied to the
// hand joints as the stage reads the clip, so it can be judged before it is
// baked. Toggle in the handle bar; "Bake wrists" writes it into the clip.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as compose from './compose.js';

const TWIST_MAX = 80 * Math.PI / 180, SWING_MAX = 70 * Math.PI / 180, SMOOTH = 3;
const $ = s => document.querySelector(s);
let on = localStorage.getItem('understudy.cleanWrists') === 'on';
let cache = { key: '', hands: new Map() }; // joint -> Float32Array[frames*4] of cleaned locals

const norm = q => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
const mul = viewer.multiply;
function clamp(q, axis) {
  q = norm(q); if (q[3] < 0) q = q.map(v => -v);
  const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  let twist = norm([axis[0] * d, axis[1] * d, axis[2] * d, q[3]]);
  let swing = norm(mul(q, [-twist[0], -twist[1], -twist[2], twist[3]]));
  const ta = 2 * Math.atan2(d, q[3]);
  if (Math.abs(ta) > TWIST_MAX) { const a = Math.sign(ta) * TWIST_MAX, s = Math.sin(a / 2), c = Math.cos(a / 2); twist = [axis[0] * s, axis[1] * s, axis[2] * s, c]; }
  const sv = Math.hypot(swing[0], swing[1], swing[2]), sa = 2 * Math.atan2(sv, swing[3]);
  if (sa > SWING_MAX && sv > 1e-6) { const s = Math.sin(SWING_MAX / 2), k = s / sv; swing = [swing[0] * k, swing[1] * k, swing[2] * k, Math.cos(SWING_MAX / 2)]; }
  return norm(mul(swing, twist));
}
function build() {
  const a = viewer.state.animation, rot = viewer.state.rotations, { names, parents, offsets } = viewer.skeleton;
  const key = `${a.id}:${a.edits || 0}`; if (cache.key === key) return;
  cache = { key, hands: new Map() };
  const joints = parents.length, frames = a.frames;
  for (const name of ['LeftHand', 'RightHand']) {
    const j = names.indexOf(name); if (j < 0 || parents[j] < 0) continue;
    const o = offsets[j], n = Math.hypot(o[0], o[1], o[2]) || 1, axis = [o[0] / n, o[1] / n, o[2] / n];
    const clamped = [];
    for (let f = 0; f < frames; f++) { const at = (f * joints + j) * 4; clamped.push(clamp([rot[at], rot[at + 1], rot[at + 2], rot[at + 3]], axis)); }
    const out = new Float32Array(frames * 4);
    for (let f = 0; f < frames; f++) {
      const acc = [0, 0, 0, 0];
      for (let d = -SMOOTH; d <= SMOOTH; d++) { const t = f + d; if (t < 0 || t >= frames) continue; const w = SMOOTH + 1 - Math.abs(d); let q = clamped[t]; if (q[0] * clamped[f][0] + q[1] * clamped[f][1] + q[2] * clamped[f][2] + q[3] * clamped[f][3] < 0) q = q.map(v => -v); for (let k = 0; k < 4; k++) acc[k] += w * q[k]; }
      out.set(norm(acc), f * 4);
    }
    cache.hands.set(j, out);
  }
}
// The viewer asks this for every joint it reads; hands get the cleaned rotation when the toggle is on.
viewer.setLocalFilter((frame, joint, q) => {
  if (!on || !viewer.state.animation) return q;
  build();
  const h = cache.hands.get(joint); if (!h) return q;
  return [h[frame * 4], h[frame * 4 + 1], h[frame * 4 + 2], h[frame * 4 + 3]];
});

export function isOn() { return on; }
export function set(v) { on = !!v; localStorage.setItem('understudy.cleanWrists', on ? 'on' : 'off'); const b = $('#cleanWrists'); if (b && b.checked !== on) b.checked = on; viewer.draw(); }
$('#cleanWrists').checked = on;
$('#cleanWrists').onchange = e => set(e.target.checked);
$('#bakeWrists').onclick = async () => {
  const a = viewer.state.animation; if (!a) return;
  try {
    const frame = viewer.state.frame;
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'wrists', in_place: true }) });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json();
    set(false);
    await library.refresh();
    await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
    library.setStatus('Wrists cleaned and baked into the clip. Undo in the Handles bar.');
  } catch (e) { library.setStatus(e.message, 'error'); }
};
