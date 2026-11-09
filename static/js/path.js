// Paths as the timeline on the ground. One stroke per prompt segment: draw
// where the character goes during segment 1, then segment 2 continues from
// where that stroke ended, and so on. Poses can be pinned at points along
// the path (Shift+click), which pins them at the matching frame. Everything
// becomes one root2d constraint over the whole clip plus full-body keyframes,
// so one generation turns, pivots and continues instead of stopping.
import * as viewer from './viewer.js';
import { setPath, segmentFrames, addPoseAtFrame, savedPoses, poseOnScreenRaw } from './compose.js';
import { choose } from './dialogs.js';

const canvas = document.querySelector('#view');
const button = document.querySelector('#pathTool');
const bar = document.querySelector('#pathBar');
const $ = s => document.querySelector(s);

let active = false;
let strokes = [];     // [{ points: [[x,0,z]...] }], one per segment, in order
let pins = [];        // [{ frame, xz: [x,z], name }]
let drawing = false;
const STEP = 15;      // a waypoint every half second

const length = pts => { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]); return l; };
const origin = () => strokes[0]?.points[0] || [0, 0, 0];

function screenToGround(e) {
  const r = canvas.getBoundingClientRect();
  return viewer.unprojectOnGround((e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height, 0);
}
function overlay() { return { strokes, pins: pins.map(p => ({ x: p.xz[0] + origin()[0], z: p.xz[1] + origin()[2], label: `${p.name} @${p.frame + 1}` })) }; }
function refreshOverlay() { viewer.setPathOverlay(active || strokes.length ? overlay() : null); viewer.draw(); }

export function setActive(on) {
  active = on; button.classList.toggle('on', on); bar.hidden = !on;
  if (on) viewer.setPlaying(false);
  refreshOverlay(); updateBar();
}
button.onclick = () => setActive(!active);

function updateBar() {
  const segs = segmentFrames();
  const n = strokes.length, total = segs.reduce((a, s) => a + s.frames, 0);
  const drawn = strokes.reduce((a, s) => a + length(s.points), 0);
  const next = n < segs.length ? `Draw segment ${n + 1} of ${segs.length}${n ? ' (it starts where the last stroke ended)' : ''}.` : `${segs.length} segment${segs.length === 1 ? '' : 's'} drawn.`;
  $('#pathHint').textContent = !n ? `Drag on the ground to draw where the character goes in segment 1${segs.length > 1 ? ` of ${segs.length}` : ''}. Shift+click the path to pin a pose there.` : `${next} ${drawn.toFixed(1)} m over ${(total / 30).toFixed(1)} s · ${pins.length} pose${pins.length === 1 ? '' : 's'} pinned.`;
  $('#usePath').disabled = !n;
}

// Frame at a point along the whole path: strokes map to their segment's frame range by arc length.
function frameAt(strokeIndex, distanceAlong) {
  const segs = segmentFrames();
  const seg = segs[Math.min(strokeIndex, segs.length - 1)];
  const stroke = strokes[strokeIndex], l = length(stroke.points) || 1;
  return Math.max(0, Math.min(seg.start + seg.frames - 1, Math.round(seg.start + (distanceAlong / l) * (seg.frames - 1))));
}
function nearestOnPath(p) {
  let best = null;
  strokes.forEach((stroke, si) => {
    let acc = 0;
    for (let i = 1; i < stroke.points.length; i++) {
      const a = stroke.points[i - 1], b = stroke.points[i];
      const ab = [b[0] - a[0], b[2] - a[2]], ap = [p[0] - a[0], p[2] - a[2]], len2 = ab[0] * ab[0] + ab[1] * ab[1] || 1e-9;
      const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / len2));
      const q = [a[0] + ab[0] * t, 0, a[2] + ab[1] * t], d = Math.hypot(p[0] - q[0], p[2] - q[2]);
      if (!best || d < best.d) best = { d, point: q, stroke: si, along: acc + Math.sqrt(len2) * t };
      acc += Math.sqrt(len2);
    }
  });
  return best;
}

canvas.addEventListener('pointerdown', async e => {
  if (!active || e.button !== 0) return;
  const p = screenToGround(e); if (!p) return;
  e.stopImmediatePropagation(); e.preventDefault();
  if (e.shiftKey) { // pin a pose on the path
    const hit = nearestOnPath(p);
    if (!hit || hit.d > .35) { $('#pathHint').textContent = 'Shift+click closer to the path to pin a pose on it.'; return; }
    const frame = frameAt(hit.stroke, hit.along);
    const options = [{ value: '__screen', label: 'Pose on screen (current frame)' }, ...savedPoses().map(sp => ({ value: sp.id, label: sp.name }))];
    const pick = await choose('Pin a pose on the path', `Frame ${frame + 1}, ${hit.along.toFixed(1)} m into segment ${hit.stroke + 1}.`, options, options[1]?.value || '__screen');
    if (pick === null) return;
    const o = origin(), xz = [hit.point[0] - o[0], hit.point[2] - o[2]];
    const name = addPoseAtFrame(pick, frame, xz);
    if (name) { pins.push({ frame, xz, name }); refreshOverlay(); updateBar(); }
    return;
  }
  const segs = segmentFrames();
  if (strokes.length >= segs.length) { $('#pathHint').textContent = `All ${segs.length} segments are drawn. Add a prompt segment to continue the path, or Clear to start over.`; return; }
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const start = strokes.length ? strokes[strokes.length - 1].points.slice(-1)[0] : p; // continue from the last stroke
  strokes.push({ points: [start] });
  drawing = true; refreshOverlay();
}, true);
canvas.addEventListener('pointermove', e => {
  if (!drawing) return;
  e.stopImmediatePropagation();
  const p = screenToGround(e); if (!p) return;
  const stroke = strokes[strokes.length - 1], last = stroke.points[stroke.points.length - 1];
  if (Math.hypot(p[0] - last[0], p[2] - last[2]) > 0.05) { stroke.points.push(p); viewer.draw(); updateBar(); }
}, true);
const end = e => { if (!drawing) return; e.stopImmediatePropagation(); drawing = false; const last = strokes[strokes.length - 1]; if (last.points.length < 2) strokes.pop(); refreshOverlay(); updateBar(); };
canvas.addEventListener('pointerup', end, true);
canvas.addEventListener('pointercancel', end, true);

// The whole path as one root2d constraint: each stroke resampled by arc length over its segment's frames.
export function toConstraint() {
  if (!strokes.length) return null;
  const segs = segmentFrames(), o = origin();
  const frameIndices = [], smooth = [], heading = [];
  let lastHeading = 0;
  strokes.forEach((stroke, si) => {
    const seg = segs[Math.min(si, segs.length - 1)], pts = stroke.points, total = length(pts);
    const sample = d => {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const segLen = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
        if (acc + segLen >= d || i === pts.length - 1) {
          const t = segLen ? Math.min(1, Math.max(0, (d - acc) / segLen)) : 0;
          return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t - o[0], pts[i - 1][2] + (pts[i][2] - pts[i - 1][2]) * t - o[2], segLen > 1e-6 ? Math.atan2(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]) : lastHeading];
        }
        acc += segLen;
      }
      return [pts[pts.length - 1][0] - o[0], pts[pts.length - 1][2] - o[2], lastHeading];
    };
    for (let f = seg.start; f < seg.start + seg.frames; f += STEP) {
      if (frameIndices.includes(f)) continue;
      const [x, z, yaw] = sample(total * (f - seg.start) / Math.max(1, seg.frames - 1));
      lastHeading = yaw; frameIndices.push(f); smooth.push([x, z]); heading.push([Math.cos(yaw), Math.sin(yaw)]);
    }
    const lastF = seg.start + seg.frames - 1;
    if (!frameIndices.includes(lastF)) { const [x, z, yaw] = sample(total); lastHeading = yaw; frameIndices.push(lastF); smooth.push([x, z]); heading.push([Math.cos(yaw), Math.sin(yaw)]); }
  });
  const first = strokes[0].points;
  return { type: 'root2d', frame_indices: frameIndices, smooth_root_2d: smooth, global_root_heading: heading, heading: first.length > 1 ? Math.atan2(first[1][0] - first[0][0], first[1][2] - first[0][2]) : 0 };
}

$('#usePath').onclick = () => { const c = toConstraint(); if (!c) return; setPath(c); setActive(false); };
$('#clearPath').onclick = () => { strokes = []; pins = []; refreshOverlay(); updateBar(); setPath(null); };
export function reset() { strokes = []; pins = []; refreshOverlay(); }
updateBar();
