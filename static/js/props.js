// Stage props: the boxes on the clip. Drag a box by its top on the stage to move it; click one and the Box bar sets
// its name, size (m), turn (°), or removes it. Every change is PATCHed to the clip (props), which recomputes the
// checks; Clean up and sequences read the same list, so what is on the stage is what the body is checked against.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as handles from './handles.js';

const canvas = document.querySelector('#view');
const bar = document.querySelector('#propBar');
const $ = s => document.querySelector(s);
let drag = null;   // { i, top, down: [clientX, clientY], pos0, moved }
export const dragState = () => drag;   // for the headless tests

const props = () => viewer.state.animation?.props || [];
const toCanvas = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
function inPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// the box under the pointer (last drawn wins), or -1: any of its six faces counts, not only the top (a tall box seen
// from low down shows almost no top)
function corners(b) {
  const [cx, cy, cz] = b.pos, [w, h, d] = b.size, c = Math.cos(b.yaw || 0), sn = Math.sin(b.yaw || 0), out = [];
  for (const [lx, lz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    const x = cx + lx * c - lz * sn, z = cz + lx * sn + lz * c;
    out.push(viewer.project([x, cy, z]), viewer.project([x, cy + h, z]));
  }
  return out; // bottom/top pairs for 4 corners
}
function hit(sx, sy) {
  const ps = props();
  for (let i = ps.length - 1; i >= 0; i--) {
    if (ps[i].kind && ps[i].kind !== 'box') continue;
    const c = corners(ps[i]); if (c.some(p => !p)) continue;
    const faces = [[1, 3, 5, 7], [0, 2, 4, 6]];
    for (let k = 0; k < 4; k++) { const j = (k + 1) % 4; faces.push([k * 2, j * 2, j * 2 + 1, k * 2 + 1]); }
    if (faces.some(f => inPoly([sx, sy], f.map(n => c[n])))) return i;
  }
  return -1;
}
const fmt = v => (Math.round(v * 100) / 100).toString();
const deg = r => Math.round((r || 0) * 180 / Math.PI);

export function select(i) {
  viewer.state.selectedProp = i;
  fill(); viewer.draw();
}
function fill() {
  const i = viewer.state.selectedProp, b = props()[i];
  if (!b) { bar.hidden = true; return; }
  bar.hidden = false;
  $('#propName').value = b.name || ''; $('#propW').value = fmt(b.size[0]); $('#propH').value = fmt(b.size[1]); $('#propD').value = fmt(b.size[2]); $('#propYaw').value = deg(b.yaw);
  $('#propHint').textContent = `Box at ${fmt(b.pos[0])}, ${fmt(b.pos[2])} m · top ${fmt(b.pos[1] + b.size[1])} m up. Drag it on the stage to move it; Delete removes it.`;
}
async function save(msg) {
  const a = viewer.state.animation; if (!a) return;
  const r = await fetch(`/api/animations/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ props: a.props || [] }) });
  if (!r.ok) { library.setStatus(await r.text(), 'error'); return; }
  const u = await r.json(); a.props = u.props; a.metrics = u.metrics; await library.refresh(); fill(); viewer.draw();
  if (msg) library.setStatus(msg);
}

// Dragging a box's top moves it (height kept). Window capture: these run before the stage's own orbit/handle
// listeners on the canvas, whatever their order, and stop the event when a box is under the pointer.
window.addEventListener('pointerdown', e => {
  // while the Handles are on, the stage is for posing (a hand resting on a box must stay draggable); boxes wait
  if (e.target !== canvas || e.button !== 0 || !viewer.state.animation || handles.isActive()) return;
  const [sx, sy] = toCanvas(e); const i = hit(sx, sy);
  if (i < 0) { if (viewer.state.selectedProp >= 0) select(-1); return; }
  e.stopImmediatePropagation(); e.preventDefault();
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  // the drag lives in the screen-parallel plane through the box top (always well conditioned, unlike the ground
  // plane seen edge-on): sideways mouse travel slides the box along the view's right, up/down travel pushes it
  // away/towards along the view's forward on the ground
  // Both ends of the drag are unprojected at move time: showing the Box bar reflows the page and resizes the stage
  // canvas right after the click, and a start point unprojected before that resize sent the box a metre away.
  const b = props()[i], top = [b.pos[0], b.pos[1] + b.size[1], b.pos[2]];
  drag = { i, top, down: [e.clientX, e.clientY], pos0: [...b.pos], moved: false };
  canvas.classList.add('dragging'); select(i);
}, true);
window.addEventListener('pointermove', e => {
  if (!drag) return;
  e.stopImmediatePropagation();
  const b = props()[drag.i]; if (!b) return;
  const { top } = drag, dz = viewer.depthOf(top); if (!(dz > .05)) return;
  const [sx0, sy0] = toCanvas({ clientX: drag.down[0], clientY: drag.down[1] }), [sx, sy] = toCanvas(e);
  const p0 = viewer.unproject(sx0, sy0, dz), p1 = viewer.unproject(sx, sy, dz), pr = viewer.unproject(sx0 + 10, sy0, dz); if (!p0 || !p1 || !pr) return;
  let right = [pr[0] - p0[0], 0, pr[2] - p0[2]]; const rl = Math.hypot(right[0], right[2]) || 1; right = [right[0] / rl, 0, right[2] / rl];
  let fwd = [-right[2], 0, right[0]]; if (viewer.depthOf([top[0] + fwd[0], top[1], top[2] + fwd[2]]) < dz) fwd = [-fwd[0], 0, -fwd[2]];
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]; const side = d[0] * right[0] + d[2] * right[2], away = d[1];
  b.pos[0] = Math.round((drag.pos0[0] + right[0] * side + fwd[0] * away) * 1000) / 1000;
  b.pos[2] = Math.round((drag.pos0[2] + right[2] * side + fwd[2] * away) * 1000) / 1000; drag.moved = true;
  fill(); viewer.draw();
}, true);
const endDrag = e => {
  if (!drag) return;
  e.stopImmediatePropagation(); const { i, moved } = drag; drag = null; canvas.classList.remove('dragging');
  const b = props()[i]; if (moved && b) save(`${b.name || 'Box'} moved to ${fmt(b.pos[0])}, ${fmt(b.pos[2])} m. The checks are updated; Clean up and sequences see it there.`);
};
window.addEventListener('pointerup', endDrag, true);
window.addEventListener('pointercancel', endDrag, true);
canvas.addEventListener('pointermove', e => { if (drag || handles.isActive()) return; const [sx, sy] = toCanvas(e); if (hit(sx, sy) >= 0) canvas.style.cursor = 'move'; });

// The Box bar.
for (const [id, apply] of [
  ['#propName', (b, v) => { b.name = v.trim().slice(0, 40); }],
  ['#propW', (b, v) => { b.size[0] = Math.min(10, Math.max(.05, +v || .05)); }],
  ['#propH', (b, v) => { b.size[1] = Math.min(5, Math.max(.05, +v || .05)); }],
  ['#propD', (b, v) => { b.size[2] = Math.min(10, Math.max(.05, +v || .05)); }],
  ['#propYaw', (b, v) => { b.yaw = (+v || 0) * Math.PI / 180; }],
]) {
  $(id)?.addEventListener('change', e => { const b = props()[viewer.state.selectedProp]; if (!b) return; apply(b, e.target.value); save(`${b.name || 'Box'}: ${fmt(b.size[0])} × ${fmt(b.size[1])} × ${fmt(b.size[2])} m, turned ${deg(b.yaw)}°.`); });
}
$('#propUnderHips')?.addEventListener('click', () => {
  // the box slides under the hips at this frame, its top at the lowest hip surface (a seat for a seated pose)
  const b = props()[viewer.state.selectedProp]; if (!b) return;
  const h = viewer.pose()[0];
  b.pos[0] = Math.round(h[0] * 1000) / 1000; b.pos[2] = Math.round(h[2] * 1000) / 1000;
  save(`${b.name || 'Box'} moved under the hips at this frame (height unchanged: set H to the seat height).`);
});
$('#propRemove')?.addEventListener('click', () => {
  const a = viewer.state.animation, i = viewer.state.selectedProp; if (!a || !(a.props || [])[i]) return;
  const name = a.props[i].name || 'Box'; a.props.splice(i, 1); viewer.state.selectedProp = -1;
  save(`${name} removed from the stage.`);
});
$('#propDone')?.addEventListener('click', () => select(-1));
// Delete / Backspace removes the selected box (unless something is being typed); Escape deselects.
window.addEventListener('keydown', e => {
  if (viewer.state.selectedProp < 0) return;
  const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (typing) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); $('#propRemove').click(); }
  else if (e.key === 'Escape') select(-1);
});
// another clip on the stage: nothing selected
let shown = null;
viewer.onDraw(() => { const a = viewer.state.animation; if (a !== shown) { shown = a; viewer.state.selectedProp = -1; fill(); } });
