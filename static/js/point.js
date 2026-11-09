// Points: a spot in space the next clip has to touch -- a tennis ball on the stage, on the ground or floating.
// Each point names what touches it (a hand or a foot) and when (a frame). "Use point" builds a reaching pose for
// it (handles.pinReach: the body faces it, stands in reach, bends for a low one) and adds that as an end-effector
// keyframe, so the clip is generated with that hand on that spot at that frame -- a doorknob, a switch, an item on a
// shelf -- the way Path makes it follow a route.
//
// Click the stage to drop a point (at the height in the bar); drag a point to move it across the ground at its
// height; Shift + drag raises or lowers it.
import * as viewer from './viewer.js';
import * as handles from './handles.js';
import * as path from './path.js';
import { segmentsTotalFrames } from './compose.js';

const canvas = document.querySelector('#view');
const button = document.querySelector('#pointTool');
const bar = document.querySelector('#pointBar');
const $ = s => document.querySelector(s);
const SHORT = { 'Right hand': 'R hand', 'Left hand': 'L hand', 'Right foot': 'R foot', 'Left foot': 'L foot' };

let active = false;
let points = [];      // [{ pos: [x, y, z], limb, frame (0-based), used }]
let selected = -1;
let drag = null;      // { index, height: bool, sy, y0 }

const toCanvas = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
// frames count in the clip being generated next (the prompt segments), not the clip on the stage
const lastFrame = () => Math.max(1, segmentsTotalFrames() || 90) - 1;
const label = p => `${SHORT[p.limb] || p.limb} @${p.frame + 1}${p.used ? ' ✓' : ''}`;

function refresh() {
  viewer.setPointOverlay(points.map((p, i) => ({ pos: p.pos, label: label(p), selected: active && i === selected })));
  viewer.draw(); updateBar();
}

export function setActive(on) {
  active = on; button.classList.toggle('on', on); bar.hidden = !on;
  if (on) { viewer.setPlaying(false); handles.setActive(false); path.setActive(false); }
  refresh();
}
button.onclick = () => setActive(!active);
// one tool on the stage at a time: Path and Handles take the pointer too
for (const id of ['#pathTool', '#handles']) document.querySelector(id)?.addEventListener('click', () => { if (active) setActive(false); });

function updateBar() {
  const p = points[selected];
  for (const id of ['#pointLimb', '#pointFrame', '#pointHeight', '#usePoint', '#deletePoint']) $(id).disabled = !p;
  $('#clearPoints').disabled = !points.length;
  if (p) {
    $('#pointLimb').value = p.limb;
    if (document.activeElement !== $('#pointFrame')) $('#pointFrame').value = p.frame + 1;
    if (document.activeElement !== $('#pointHeight')) $('#pointHeight').value = p.pos[1].toFixed(2);
  }
  $('#pointHint').textContent = !viewer.state.animation ? 'Put a clip on the stage first: its body is the one that reaches the point.'
    : !points.length ? 'Click the stage to place a point. Drag it to move it; Shift + drag raises or lowers it.'
    : p ? `${p.limb} touches this point at frame ${p.frame + 1}${p.pos[1] > 0.06 ? `, ${p.pos[1].toFixed(2)} m up` : ', on the ground'}.${p.used ? ' In the next clip.' : ' “Use point” adds it to the next clip.'}`
    : `${points.length} point${points.length === 1 ? '' : 's'}. Click one to change it.`;
}

function hitTest(sx, sy) {
  let best = -1, bd = 18 * (window.devicePixelRatio || 1);
  points.forEach((p, i) => { const c = viewer.project(p.pos), d = Math.hypot(c[0] - sx, c[1] - sy); if (d < bd) { bd = d; best = i; } });
  return best;
}

// Window capture, like the Box tool's, and registered before it (app.js imports this first): a click on a box while
// Point is on places a point there rather than picking the box up.
window.addEventListener('pointerdown', e => {
  if (!active || e.target !== canvas || e.button !== 0) return;
  const [sx, sy] = toCanvas(e);
  e.stopImmediatePropagation(); e.preventDefault();
  let i = hitTest(sx, sy);
  if (i < 0) {   // a new point where the click meets the ground, at the bar's height
    const g = viewer.unprojectOnGround(sx, sy, 0); if (!g) return;
    const height = Math.max(0, Number($('#pointHeight').value) || 0);
    const limb = $('#pointLimb').value || 'Right hand';
    // the stage's frame when it is paused somewhere in the next clip's span, else two thirds in (a walk-up, then the touch)
    const f = viewer.state.frame, frame = f > 0 && f <= lastFrame() ? f : Math.round(lastFrame() * 2 / 3);
    points.push({ pos: [g[0], height, g[2]], limb, frame, used: false }); i = points.length - 1;
  }
  selected = i;
  drag = { index: i, height: e.shiftKey, sy, y0: points[i].pos[1] };
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  refresh();
}, true);
window.addEventListener('pointermove', e => {
  if (!drag) return;
  e.stopImmediatePropagation();
  const [sx, sy] = toCanvas(e), p = points[drag.index];
  if (drag.height) {   // Shift: up and down, about a body height per figure height on screen
    const perPx = 1.7 / Math.max(60, viewer.figureSpanPx());
    p.pos[1] = Math.max(0, Math.min(2.5, drag.y0 + (drag.sy - sy) * perPx));
  } else {             // across the ground at its own height
    const g = viewer.unprojectOnGround(sx, sy, p.pos[1]); if (g) { p.pos[0] = g[0]; p.pos[2] = g[2]; }
  }
  p.used = false; refresh();
}, true);
const end = e => { if (!drag) return; e.stopImmediatePropagation(); drag = null; refresh(); };
window.addEventListener('pointerup', end, true);
window.addEventListener('pointercancel', end, true);

$('#pointLimb').onchange = () => { const p = points[selected]; if (p) { p.limb = $('#pointLimb').value; p.used = false; refresh(); } };
$('#pointFrame').onchange = () => { const p = points[selected]; if (p) { p.frame = Math.min(lastFrame(), Math.max(0, Math.round(Number($('#pointFrame').value) || 1) - 1)); p.used = false; refresh(); } };
$('#pointHeight').onchange = () => { const p = points[selected]; if (p) { p.pos[1] = Math.max(0, Math.min(2.5, Number($('#pointHeight').value) || 0)); p.used = false; refresh(); } };
$('#usePoint').onclick = () => {
  const p = points[selected]; if (!p) return;
  // the other hand on a point at the same frame: one pose with both (a box taken by its sides)
  const otherHand = { 'Right hand': 'Left hand', 'Left hand': 'Right hand' }[p.limb];
  const mate = otherHand ? points.find(o => o !== p && o.limb === otherHand && o.frame === p.frame) : null;
  const group = mate ? [p, mate] : [p];
  const r = handles.pinReachMany(group.map(g => ({ limb: g.limb, world: [...g.pos] })), p.frame);
  if (!r.ok) { $('#pointHint').textContent = r.why; return; }
  for (const g of group) g.used = true;
  refresh();
  $('#pointHint').textContent = `Added: ${mate ? 'both hands reach their points' : `the ${p.limb.toLowerCase()} reaches this point`} at frame ${p.frame + 1}${r.residual > 0.03 ? ` (the pose reaches within ${Math.round(r.residual * 100)} cm)` : ''}. Generate to make the clip; the reach is shown on its frame.`;
};
$('#deletePoint').onclick = () => { if (selected < 0) return; points.splice(selected, 1); selected = points.length ? Math.min(selected, points.length - 1) : -1; refresh(); };
$('#clearPoints').onclick = () => { points = []; selected = -1; refresh(); };
export function reset() { points = []; selected = -1; drag = null; refresh(); }
export function isActive() { return active; }
refresh();
