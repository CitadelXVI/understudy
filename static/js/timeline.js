// The timeline: a drawn strip under the stage. A frame ruler on top, then the track rows (Prompt segments; Keys, the
// keyframes set on the timeline, with a row per body part when opened; Guide, the poses the clip was generated to pass
// through; Marks; Hands) whose names sit in the DOM column to the left (#trackLabels).
// Keys: click to select (Shift/Ctrl adds), drag to move (Alt + drag spreads or squeezes them), drag on an empty stretch of a key row to box-select, right-click
// for smooth / linear / hold, copy, delete; Delete, Ctrl+C, Ctrl+V, S keys the pose, ',' and '.' jump between keys. The playhead carries the frame number in a
// flag on the ruler; the keep range is the only other accent. Click or drag to
// scrub, Shift-drag to set a keep range, drag a marker flag to move it,
// double-click a marker or keyframe to jump, wheel steps frames.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as compose from './compose.js';
import * as keep from './keep.js';
import * as K from './keys.js';
import { issueSpans } from './assistant.js';

const canvas = document.querySelector('#timeline');
const ctx = canvas.getContext('2d');
const timeText = document.querySelector('#timeText');
const RULER = 26, TOP = 28, ROW = 22, PAD = 10, FPS = 30;
// Rows: Prompt, Keys (+ a row per keyed body part when opened), Guide, Marks, Hands (with the body).
let handsRow = true, expanded = (() => { try { return localStorage.getItem('understudy.keysOpen') !== '0'; } catch { return true; } })();
let rows = [], R = {}, H = 0;
const labelsEl = document.querySelector('#trackLabels');
const LABEL = {
  prompt: ['Prompt', 'What you asked for: each prompt segment of the clip'],
  keys: ['Keys', 'Your keyframes. Pose with Handles (Auto key saves on release, or press S); click to show or fold a row per keyed body part'],
  guide: ['Guide', 'Poses the clip was generated to pass through (filled) and the ones queued for the next generation (hollow)'],
  marks: ['Marks', 'Markers: named moments (M adds one at the current frame; drag a flag to move it)'],
  hands: ['Hands', 'Hand shapes set from a frame on (Handles bar)'],
};
function keyedParts() {
  const ks = K.keys(), set = new Set(ks.map(k => k.part));
  return K.PARTS.filter(([p]) => set.has(p));
}
function layoutRows() {
  const parts = expanded ? keyedParts() : [], kfCount = K.keyFrames().length;
  rows = [{ id: 'prompt' }, { id: 'keys' }, ...parts.map(([p]) => ({ id: 'part:' + p, part: p })), ...(guideCount() ? [{ id: 'guide' }] : []), ...(markCount() ? [{ id: 'marks' }] : []), ...(handsRow && handsSet() ? [{ id: 'hands' }] : [])];
  R = Object.fromEntries(rows.map((r, i) => [r.id, i]));
  H = TOP + ROW * rows.length + 2;
  if (labelsEl) {
    const span = (text, title, cls = '') => Object.assign(document.createElement('span'), { textContent: text, title, className: cls });
    const items = [span('frames', 'Frames', 'ruler-gap')];
    for (const r of rows) {
      if (r.part) { items.push(span(K.partLabel[r.part], `${K.partLabel[r.part]}: its keys`, 'part')); continue; }
      if (r.id === 'keys') {
        const arrow = kfCount ? (expanded ? '▾ ' : '▸ ') : '▸ ';
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'track-toggle' + (kfCount ? ' has-keys' : ''), textContent: arrow + 'Keys' + (kfCount ? ` · ${kfCount}` : ''), title: LABEL.keys[1] });
        b.onclick = () => { expanded = !expanded; try { localStorage.setItem('understudy.keysOpen', expanded ? '1' : '0'); } catch {} layoutRows(); canvas.width = 0; draw(); };
        items.push(b); continue;
      }
      items.push(span(LABEL[r.id][0], LABEL[r.id][1]));
    }
    labelsEl.replaceChildren(...items);
    labelsEl.style.height = H + 'px';
  }
  canvas.style.height = H + 'px';
}
export function setHandsRow(on) { handsRow = on; layoutRows(); canvas.width = 0; draw(); }
const rowY = i => TOP + i * ROW;
const rowAt = y => { const i = Math.floor((y - TOP) / ROW); return y >= TOP && i >= 0 && i < rows.length ? rows[i] : null; };
const isKeyRow = r => !!r && (r.id === 'keys' || !!r.part);
let hover = null, drag = null;
let extraMarkers = () => [];
export function setExtraMarkers(fn) { extraMarkers = fn; draw(); }

const accent = '#ffd700';
const ink = a => `rgba(255,255,255,${a})`;
const mono = (w = 500, s = 11) => `${w} ${s}px "JetBrains Mono", ui-monospace, monospace`;
const sans = (w = 500, s = 11.5) => `${w} ${s}px Inter, system-ui, sans-serif`;
const EMPTY = { get keys() { return K.autoKey() ? 'no keys yet — pose with Handles: Auto key keys it when you let go' : 'no keys yet — pose with Handles, then press ◆ Key this pose (or S)'; }, guide: 'no guide poses — Pin this pose (Make › Guide the next clip) adds one', marks: 'no markers — M names this frame', hands: 'hands: auto (set hand shapes under More ▾ in the posing bar)' };
let emptyRows = [];
function emptyHint(row, has) { if (has || R[row] == null) return; ctx.font = sans(400, 11.5); ctx.fillStyle = ink(.42); ctx.fillText(EMPTY[row], PAD + 4, rowY(R[row]) + 15); emptyRows.push(row); }

function frames() { return viewer.state.animation?.frames || 0; }
function px() { return canvas.width / window.devicePixelRatio; }
// The frames in view: the whole clip, or a zoomed stretch of it (Ctrl + wheel). v0..v1 in frames.
let v0 = 0, v1 = null;
const span = () => { const n = Math.max(1, frames() - 1); if (v1 == null || v1 > n) { v0 = 0; v1 = n; } return [v0, v1]; };
function xOf(f) { const [a, b] = span(); return PAD + (px() - 2 * PAD) * ((f - a) / Math.max(1e-6, b - a)); }
function frameAt(x) { const [a, b] = span(), n = Math.max(1, frames() - 1); return Math.max(0, Math.min(n, Math.round(a + (x - PAD) / (px() - 2 * PAD) * (b - a)))); }
const zoomed = () => { const [a, b] = span(); return b - a < Math.max(1, frames() - 1) - 0.5; };
function setView(a, b) {
  const n = Math.max(1, frames() - 1), w = Math.max(Math.min(n, 12), Math.min(n, b - a));   // at least 12 frames across
  a = Math.max(0, Math.min(n - w, a)); v0 = a; v1 = a + w; draw();
}
// while zoomed, keep the playhead in view (playing or stepping past an edge slides the view)
function follow() {
  if (!zoomed()) return; const f = viewer.state.frame, [a, b] = span(), w = b - a;
  if (f < a) setView(f - w * 0.1, f - w * 0.1 + w); else if (f > b) setView(f - w * 0.9, f - w * 0.9 + w);
}

function fit() {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 600;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// Ruler spacing: the widest step whose labels sit at least 44 px apart.
const STEPS = [[1, 1], [2, 1], [5, 1], [10, 5], [15, 5], [30, 10], [60, 30], [90, 30], [150, 30], [300, 60], [600, 150]];
function rulerStep() {
  const [a, b] = span(), perFrame = (px() - 2 * PAD) / Math.max(1e-6, b - a);
  for (const [major, minor] of STEPS) if (major * perFrame >= 52) return [major, minor];
  return STEPS[STEPS.length - 1];
}

// What sits on the clip: segments, markers, its generation constraints (single
// keys and kept runs), the pending ones, hand keys, the keep range.
// rows shown only when they hold something (an empty Guide / Marks / Hands row was four lines of "no ... yet")
function guideCount() { const it = items(); return it ? it.own.keys.length + it.own.runs.length + it.pending.keys.length + it.pending.runs.length + (it.lineage?.free ? 1 : 0) : 0; }
function markCount() { const it = items(); return it ? it.markers.length + it.extra.length : 0; }
function handsSet() { const it = items(); return !!(it && it.handKeys.length); }
function items() {
  const va = viewer.state.animation; if (!va) return null;
  const a = library.selected?.id === va.id ? library.selected : va;
  const segs = []; let start = 0;
  for (const s of (a.segments?.length ? a.segments : [{ prompt: a.prompt, frames: a.frames }])) { segs.push({ start, end: Math.min(a.frames - 1, start + s.frames - 1), prompt: s.prompt || '' }); start += s.frames; }
  const own = { keys: [], runs: [] }, pending = { keys: [], runs: [] };
  const sort = (into, list, isPending) => {
    for (const c of list) {
      const fr = [...new Set(c.frame_indices || [])].sort((p, q) => p - q); if (!fr.length) continue;
      const keep = isPending ? !!c.keep : fr.length > 1;
      if (keep) into.runs.push({ from: fr[0], to: fr[fr.length - 1], frames: fr, type: c.type });
      else for (const f of fr) into.keys.push({ frame: f, type: c.type });
    }
  };
  sort(own, a.constraints || [], false); sort(pending, compose.currentKeyframes(), true);
  const handKeys = (a.hand_track || []).map(k => ({ frame: k.frame, left: k.left, right: k.right, text: `hands ${k.left}/${k.right}` }));
  return { a, segs, handKeys, issues: issueSpans(a), markers: a.markers || [], own, pending, keepRange: keep.bounds(), lineage: a.lineage, extra: extraMarkers().filter(m => m.frame >= 0 && m.frame < a.frames) };
}

const typeName = t => t === 'root2d' ? 'hips path' : t === 'end-effector' ? 'hands/feet' : 'full pose';
// Key glyphs by type: full pose = diamond, hands/feet = circle, hips path = square. Hollow when pending.
function keyGlyph(x, y, type, hollow) {
  ctx.lineWidth = hollow ? 1.5 : 1; ctx.strokeStyle = '#fff'; ctx.fillStyle = hollow ? 'rgba(0,0,0,.6)' : '#fff';
  ctx.beginPath();
  if (type === 'end-effector') ctx.arc(x, y, 4, 0, Math.PI * 2);
  else if (type === 'root2d') ctx.rect(x - 4, y - 4, 8, 8);
  else { const r = 5.5; ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
  ctx.fill(); ctx.stroke();
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
const clipText = (text, maxW) => { if (ctx.measureText(text).width <= maxW) return text; let t = text; while (t.length && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t ? t + '…' : ''; };

// Key glyphs: smooth ◆, linear ▲, hold ■; gold when selected.
function keyMark(x, y, kind, on, r, halo = false) {
  if (halo) {
    ctx.strokeStyle = 'rgba(0,0,0,.92)'; ctx.lineWidth = 3.2;
    ctx.beginPath();
    if (kind === 'hold') ctx.rect(x - r * .8, y - r * .8, r * 1.6, r * 1.6);
    else if (kind === 'linear') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * .8); ctx.lineTo(x - r, y + r * .8); ctx.closePath(); }
    else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
    ctx.stroke();
  }
  ctx.fillStyle = on ? accent : '#fff'; ctx.strokeStyle = halo ? '#fff' : (on ? 'rgba(0,0,0,.8)' : 'rgba(0,0,0,.55)'); ctx.lineWidth = halo ? 1.25 : 1;
  ctx.beginPath();
  if (kind === 'hold') ctx.rect(x - r * .8, y - r * .8, r * 1.6, r * 1.6);
  else if (kind === 'linear') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r * .8); ctx.lineTo(x - r, y + r * .8); ctx.closePath(); }
  else { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
  ctx.fill(); ctx.stroke();
}
function drawBlendRamps(framesList, yMid) {
  const bl = K.blend();
  if (!(bl > 0) || !framesList.length) return;
  const fMin = Math.min(...framesList), fMax = Math.max(...framesList), n = Math.max(1, frames() - 1);
  const xStart = xOf(Math.max(0, fMin - bl)), xFirst = xOf(fMin), xLast = xOf(fMax), xEnd = xOf(Math.min(n, fMax + bl));
  ctx.fillStyle = 'rgba(255,215,0,.11)';
  if (xFirst > xStart + 1) { ctx.beginPath(); ctx.moveTo(xStart, yMid); ctx.lineTo(xFirst, yMid - 5.5); ctx.lineTo(xFirst, yMid + 5.5); ctx.closePath(); ctx.fill(); }
  if (xLast > xFirst + 1) { ctx.fillRect(xFirst, yMid - 3.5, xLast - xFirst, 7); }
  if (xEnd > xLast + 1) { ctx.beginPath(); ctx.moveTo(xEnd, yMid); ctx.lineTo(xLast, yMid - 5.5); ctx.lineTo(xLast, yMid + 5.5); ctx.closePath(); ctx.fill(); }
}
function drawLayerKeys() {
  const w = px(), ks = K.keys(), sel = K.selection, df = drag?.kind === 'keys' ? drag.df : 0, pend = K.pendingFrame?.();
  for (const r of rows) if (isKeyRow(r)) { ctx.fillStyle = 'rgba(255,215,0,.04)'; ctx.fillRect(0, rowY(R[r.id]), w, ROW); }
  if (!ks.length && pend == null) { emptyHint('keys', false); return null; }
  const at = k => !sel.has(K.id(k)) ? k.frame : drag?.kind === 'keys' && drag.scale ? drag.lo + Math.round((k.frame - drag.lo) * drag.factor) : k.frame + df;
  // Keys row: one mark per keyed frame (every part keyed there), plus any live Auto key edit
  const sy = rowY(R.keys) + ROW / 2, byFrame = new Map();
  for (const k of ks) { const f = at(k), e = byFrame.get(f) || { on: false }; e.on = e.on || sel.has(K.id(k)); byFrame.set(f, e); }
  if (pend != null && !byFrame.has(pend)) byFrame.set(pend, { on: true });
  drawBlendRamps([...byFrame.keys()], sy);
  for (const [f, e] of byFrame) keyMark(xOf(f), sy, 'smooth', e.on, 6.8);
  if (expanded && ks.length) {
    for (const [p] of K.PARTS) {
      const ri = R['part:' + p]; if (ri == null) continue;
      const y = rowY(ri) + ROW / 2, list = ks.filter(k => k.part === p).sort((a, b) => at(a) - at(b));
      for (let i = 0; i + 1 < list.length; i++) {   // the stretch between two keys: thick when held
        const hold = list[i].interp === 'hold';
        ctx.strokeStyle = ink(hold ? .45 : .2); ctx.lineWidth = hold ? 4 : 1.5; ctx.beginPath(); ctx.moveTo(xOf(at(list[i])), y + .5); ctx.lineTo(xOf(at(list[i + 1])), y + .5); ctx.stroke();
      }
      ctx.lineWidth = 1;
      for (const k of list) keyMark(xOf(at(k)), y, k.interp || 'smooth', sel.has(K.id(k)), 5.8);
    }
  }
  return byFrame;
}
// the keys under x on a key row: every key at that frame on the Keys row, the one key on a part row
function keyHit(x, row) {
  const ks = K.keys(); let best = null, bd = 8;
  if (row.id === 'keys') { for (const f of K.keyFrames()) { const d = Math.abs(xOf(f) - x); if (d < bd) { bd = d; best = f; } } return best == null ? null : { frame: best, ids: ks.filter(k => k.frame === best).map(K.id) }; }
  for (const k of ks) if (k.part === row.part) { const d = Math.abs(xOf(k.frame) - x); if (d < bd) { bd = d; best = k; } }
  return best ? { frame: best.frame, ids: [K.id(best)] } : null;
}
function boxSelect(d) {
  const xa = Math.min(d.x0, d.x1), xb = Math.max(d.x0, d.x1), ya = Math.min(d.y0, d.y1), yb = Math.max(d.y0, d.y1);
  if (!d.add) K.selection.clear();
  for (const r of rows) {
    if (!isKeyRow(r)) continue; const top = rowY(R[r.id]); if (top + ROW < ya || top > yb) continue;
    for (const k of K.keys()) if ((r.id === 'keys' || k.part === r.part) && xOf(k.frame) >= xa - 4 && xOf(k.frame) <= xb + 4) K.selection.add(K.id(k));
  }
}

export function draw() {
  fit();
  const w = px(), n = frames();
  ctx.clearRect(0, 0, w, H);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'start'; ctx.lineWidth = 1;
  if (timeText) timeText.textContent = n ? `${(viewer.state.frame / FPS).toFixed(2)} s` : '';
  if (!n) { ctx.fillStyle = ink(.4); ctx.font = sans(500, 12); ctx.fillText('No clip on the stage. Pick one in the Library, or describe a motion and press Generate.', PAD, 46); return; }
  const it = items();

  // Row bands and the ruler ground.
  ctx.fillStyle = ink(.035); ctx.fillRect(0, 0, w, RULER);
  for (let i = 0; i < rows.length; i++) { if (i % 2) { ctx.fillStyle = ink(.02); ctx.fillRect(0, rowY(i), w, ROW); } }
  ctx.strokeStyle = ink(.07); ctx.beginPath();
  for (let i = 0; i <= rows.length; i++) { const y = rowY(i) + .5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  ctx.strokeStyle = ink(.14); ctx.beginPath(); ctx.moveTo(0, RULER - .5); ctx.lineTo(w, RULER - .5); ctx.stroke();

  // Prompt segments: a band per segment with the prompt's words; boundaries run through every row.
  ctx.font = sans(500, 12);
  it.segs.forEach((s, i) => {
    const x0 = xOf(s.start), x1 = i === it.segs.length - 1 ? xOf(s.end) : xOf(s.end + 1), y = rowY(0);
    ctx.fillStyle = ink(.07); roundRect(x0 + (i ? 1.5 : 0), y + 2, Math.max(2, x1 - x0 - (i ? 1.5 : 0)), ROW - 4, 3); ctx.fill();
    if (i) { ctx.strokeStyle = ink(.3); ctx.beginPath(); ctx.moveTo(x0 + .5, RULER - 4); ctx.lineTo(x0 + .5, H - 2); ctx.stroke(); }
    const text = clipText(s.prompt.replace(/^(A|An) person /i, '').replace(/\.$/, ''), x1 - x0 - 10);
    if (text) { ctx.fillStyle = ink(.82); ctx.fillText(text, Math.max(x0, PAD) + 5 + (i ? 2 : 0), y + 15); }
  });
  // The region a regenerate-range freed, from lineage: a hatched stretch of the Keys row.
  if (it.lineage?.free) {
    const [a, b] = it.lineage.free, x0 = xOf(a), x1 = xOf(b), y = rowY(R.guide);
    ctx.save(); ctx.beginPath(); ctx.rect(x0, y + 1, x1 - x0, ROW - 2); ctx.clip();
    ctx.strokeStyle = ink(.16); ctx.beginPath(); for (let x = x0 - ROW; x < x1 + ROW; x += 5) { ctx.moveTo(x, y + ROW); ctx.lineTo(x + ROW, y); } ctx.stroke(); ctx.restore();
  }
  // Keep range: the accent band across every row, with brackets on the ruler.
  if (it.keepRange) {
    const [a, b] = it.keepRange, x0 = xOf(a), x1 = Math.max(x0 + 2, xOf(b));
    ctx.fillStyle = 'rgba(255,215,0,.12)'; ctx.fillRect(x0, TOP, x1 - x0, H - 2 - TOP);
    ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0 + .5, RULER - 5); ctx.lineTo(x0 + .5, H - 2); ctx.moveTo(x1 - .5, RULER - 5); ctx.lineTo(x1 - .5, H - 2); ctx.stroke();
    ctx.fillStyle = accent; ctx.fillRect(x0, RULER - 5, Math.min(5, x1 - x0), 2); ctx.fillRect(x1 - Math.min(5, x1 - x0), RULER - 5, Math.min(5, x1 - x0), 2);
  }
  // Checks issue frame spans: thin warning band along the bottom of the FRAMES ruler so flagged stretches read at a glance.
  for (const s of it.issues) {
    const x0 = xOf(s.from), x1 = xOf(s.to);
    if (s.to > s.from) {
      const bw = Math.max(4, x1 - x0);
      ctx.fillStyle = 'rgba(255,138,128,.14)'; ctx.fillRect(x0, 1, bw, RULER - 2);
      ctx.fillStyle = '#ff8a80'; ctx.fillRect(x0, RULER - 3.5, bw, 3);
      ctx.fillRect(Math.round(x0) - .5, RULER - 6.5, 1.5, 6);
      ctx.fillRect(Math.round(x0 + bw) - 1, RULER - 6.5, 1.5, 6);
    } else {
      ctx.fillStyle = 'rgba(255,138,128,.22)'; ctx.fillRect(x0 - 3, 1, 6, RULER - 2);
      ctx.fillStyle = '#ff8a80'; ctx.fillRect(x0 - 3, RULER - 3.5, 6, 3);
    }
  }
  // Ruler: minor ticks, major ticks with 1-based frame numbers, the first and last frame always named.
  const [major, minor] = rulerStep();
  ctx.font = mono(500, 11.5); ctx.textAlign = 'center';
  const [vf0, vf1] = span(), f0 = Math.ceil(vf0), f1 = Math.floor(vf1);
  ctx.strokeStyle = ink(.22); ctx.beginPath();
  for (let f = f0; f <= f1; f++) if ((f + 1) % minor === 0 && (f + 1) % major !== 0) { const x = Math.round(xOf(f)) + .5; ctx.moveTo(x, RULER - 4); ctx.lineTo(x, RULER); }
  ctx.stroke();
  const labelled = [];
  // the first and last numbers sit inside the strip (left- / right-aligned); the others are centred on their tick
  const phx = xOf(viewer.state.frame), phw = ctx.measureText(String(viewer.state.frame + 1)).width / 2 + 16;   // ruler numbers give way to the playhead's tag
  const label = (f, strong, align = 'center') => { const x = xOf(f); if (Math.abs(x - phx) < phw + (align === 'center' ? ctx.measureText(String(f + 1)).width / 2 : ctx.measureText(String(f + 1)).width)) { labelled.push(x); return; } ctx.strokeStyle = ink(strong ? .5 : .35); ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, RULER - 7); ctx.lineTo(Math.round(x) + .5, RULER); ctx.stroke(); ctx.fillStyle = ink(strong ? .92 : .7); ctx.textAlign = align; ctx.fillText(String(f + 1), align === 'left' ? x + 2 : align === 'right' ? x - 2 : x, 14); ctx.textAlign = 'center'; labelled.push(x); };
  label(f0, true, 'left');
  for (let f = Math.ceil((f0 + 1) / major) * major - 1; f < f1; f += major) if (f > f0 && xOf(f) - labelled[labelled.length - 1] >= 30 && xOf(f1) - xOf(f) >= 30) label(f, false);
  // each prompt part's first frame is named on the ruler too, when it has room
  for (const s0 of it.segs.slice(1)) { if (s0.start <= f0 || s0.start >= f1) continue; const x = xOf(s0.start); if (labelled.every(lx => Math.abs(lx - x) >= 26) && xOf(f1) - x >= 26) label(s0.start, true); }
  label(f1, true, 'right');
  ctx.textAlign = 'start';
  // Empty rows say so, quietly.
  emptyRows = [];
  emptyHint('guide', it.own.keys.length || it.own.runs.length || it.pending.keys.length || it.pending.runs.length || it.lineage?.free);
  emptyHint('marks', it.markers.length || it.extra.length);
  emptyHint('hands', it.handKeys.length);
  const layerFrames = drawLayerKeys();
  // Keys row: the clip's own keys (filled) and the next generation's (hollow); kept runs as a rail with small pins.
  const ky = rowY(R.guide) + ROW / 2;
  const rail = (r, hollow) => {
    const x0 = xOf(r.from), x1 = xOf(r.to);
    ctx.strokeStyle = ink(hollow ? .9 : .7); ctx.lineWidth = hollow ? 1.5 : 1.2;
    if (hollow) ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x0, ky + .5); ctx.lineTo(x1, ky + .5); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = ink(hollow ? .9 : .75);
    for (const f of r.frames) { const x = Math.round(xOf(f)); ctx.fillRect(x - .5, ky - 3, 1.5, 6); }
    ctx.fillRect(Math.round(x0) - 1, ky - 4, 2, 8); ctx.fillRect(Math.round(x1) - 1, ky - 4, 2, 8);
  };
  for (const r of it.own.runs) rail(r, false);
  for (const r of it.pending.runs) rail(r, true);
  for (const k of it.own.keys) keyGlyph(xOf(k.frame), ky, k.type, false);
  for (const k of it.pending.keys) keyGlyph(xOf(k.frame), ky, k.type, true);
  // Planted feet (while the Keep bar is open): two thin rails at the bottom of the Keys row.
  if (keep.isActive()) for (const [i, side] of ['Left', 'Right'].entries()) for (const [f0, f1] of keep.contactRuns(side)) { ctx.fillStyle = ink(.3); ctx.fillRect(xOf(f0), rowY(R.guide) + 1.5 + i * 2, Math.max(2, xOf(f1) - xOf(f0)), 1); }
  // Marks row: named flags, left to right; the stage clip's in white, other actors' lighter (their name carries the actor).
  // A name is written only where it does not run into the previous one.
  const my = rowY(R.marks);
  ctx.font = mono(500, 11.5);
  let labelEnd = -Infinity;
  const flag = (m, strong) => {
    const x = Math.round(xOf(m.frame)), text = clipText(m.name, Math.min(120, w - x - 14));
    ctx.fillStyle = strong ? '#fff' : ink(.6);
    ctx.fillRect(x - 1, my + 2, 2, ROW - 4);
    ctx.beginPath(); ctx.moveTo(x + 1, my + 3); ctx.lineTo(x + 10, my + 8); ctx.lineTo(x + 1, my + 13); ctx.closePath(); ctx.fill();
    if (text && x + 11 >= labelEnd + 6) {
      const tw = ctx.measureText(text).width;
      if (strong) { ctx.fillStyle = 'rgba(0,0,0,.72)'; ctx.fillRect(x + 9, my + 2, tw + 4, ROW - 4); ctx.fillStyle = '#fff'; }
      ctx.fillText(text, x + 11, my + 15); labelEnd = x + 11 + tw;
    }
  };
  for (const m of [...it.markers.map(m => ({ m, strong: true })), ...it.extra.map(m => ({ m, strong: false }))].sort((p, q) => p.m.frame - q.m.frame || (q.strong - p.strong))) flag(m.m, m.strong);
  if (R.hands != null) {
  // Hands row: a hand key is a small plate at its frame with the two shapes after it.
  const hy = rowY(R.hands);
  ctx.font = mono(500, 11);
  it.handKeys.forEach((k, i) => {
    const x = Math.round(xOf(k.frame)), next = it.handKeys[i + 1] ? xOf(it.handKeys[i + 1].frame) : w - PAD;
    ctx.fillStyle = ink(.12); ctx.fillRect(x, hy + 3, Math.max(1, next - x), ROW - 6);
    ctx.fillStyle = '#fff'; roundRect(x - 3, hy + 3, 7, ROW - 6, 1.5); ctx.fill();
    ctx.fillStyle = ink(.75); ctx.fillText(clipText(`${k.left} / ${k.right}`, next - x - 10), x + 8, hy + 15);
  });
  }
  // Hover: a hairline with the frame it is over, unless it is the playhead's frame.
  if (hover != null && !drag) {
    const x = Math.round(xOf(hover)) + .5;
    ctx.strokeStyle = ink(.28); ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H - 2); ctx.stroke();
    if (Math.abs(xOf(hover) - xOf(viewer.state.frame)) > 28) {
      const t = String(hover + 1); ctx.font = mono(500, 11.5); const tw = ctx.measureText(t).width;
      const lx = Math.min(w - tw - 6, Math.max(2, x - tw / 2 - 3));
      ctx.fillStyle = 'rgba(0,0,0,.8)'; roundRect(lx, 2, tw + 8, 18, 4); ctx.fill(); ctx.strokeStyle = ink(.25); ctx.stroke();
      ctx.fillStyle = ink(.85); ctx.fillText(t, lx + 4, 15.5);
    }
  }
  if (zoomed()) {
    const [a, b] = span(), all = Math.max(1, n - 1), bx0 = PAD + (w - 2 * PAD) * a / all, bx1 = PAD + (w - 2 * PAD) * b / all;
    ctx.fillStyle = ink(.08); ctx.fillRect(PAD, H - 3, w - 2 * PAD, 3); ctx.fillStyle = ink(.5); ctx.fillRect(bx0, H - 3, Math.max(4, bx1 - bx0), 3);
  }
  if (drag?.kind === 'box' && drag.moved) {
    const x0 = Math.min(drag.x0, drag.x1), y0 = Math.min(drag.y0, drag.y1);
    ctx.fillStyle = 'rgba(255,215,0,.08)'; ctx.fillRect(x0, y0, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    ctx.strokeStyle = 'rgba(255,215,0,.7)'; ctx.strokeRect(x0 + .5, y0 + .5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
  }
  // Playhead: the accent line through every row and a flag on the ruler with the frame number.
  const x = Math.round(xOf(viewer.state.frame)) + .5;
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, RULER - 2); ctx.lineTo(x, H - 2); ctx.stroke();
  const t = String(viewer.state.frame + 1); ctx.font = mono(700, 13); const tw = ctx.measureText(t).width;
  const fw = tw + 10, fx = Math.min(w - fw - 1, Math.max(1, x - fw / 2));
  ctx.fillStyle = accent; roundRect(fx, 1, fw, 19, 4); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 5, 20); ctx.lineTo(x + 5, 20); ctx.lineTo(x, RULER); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.fillText(t, fx + fw / 2, 15); ctx.textAlign = 'start';
  ctx.lineWidth = 1;
  // Re-draw any key diamond sitting right under the playhead stem so a newly keyed frame stands out immediately.
  if (layerFrames?.has(viewer.state.frame) && R.keys != null) {
    const phKey = layerFrames.get(viewer.state.frame);
    keyMark(xOf(viewer.state.frame), rowY(R.keys) + ROW / 2, 'smooth', true, 7.6, true);
    if (expanded) {
      for (const k of K.keys()) {
        const ri = R['part:' + k.part];
        if (k.frame === viewer.state.frame && ri != null) keyMark(xOf(k.frame), rowY(ri) + ROW / 2, k.interp || 'smooth', phKey.on || K.selection.has(K.id(k)), 6.4, true);
      }
    }
  }
  ctx.font = sans(400, 11.5);
  for (const row of emptyRows) {
    const hw = ctx.measureText(EMPTY[row]).width, i = R[row], y = rowY(i);
    if (x >= PAD + 1 && x <= PAD + 4 + hw + 3) {
      ctx.fillStyle = row === 'keys' ? (i % 2 ? '#1d1c16' : '#181711') : (i % 2 ? '#151517' : '#101012');
      roundRect(PAD + 1, y + 3, hw + 6, ROW - 5, 3); ctx.fill();
      ctx.fillStyle = ink(.42); ctx.fillText(EMPTY[row], PAD + 4, y + 15);
    }
  }
}

// Input.
const localX = e => { const r = canvas.getBoundingClientRect(); return e.clientX - r.left; };
canvas.addEventListener('pointerdown', e => {
  if (!frames()) return;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const f = frameAt(localX(e));
  const r = canvas.getBoundingClientRect(), y = e.clientY - r.top, row = rowAt(y);
  if (isKeyRow(row)) {   // keys: select / drag them; an empty stretch: box-select (a click there goes to the frame)
    if (e.button !== 0) return;
    const hit = keyHit(localX(e), row), add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit) {
      if (add) { const on = hit.ids.every(i => K.selection.has(i)); for (const i of hit.ids) on ? K.selection.delete(i) : K.selection.add(i); }
      else if (!hit.ids.every(i => K.selection.has(i))) { K.selection.clear(); for (const i of hit.ids) K.selection.add(i); }
      const fs = K.selectedKeys().map(k => k.frame);
      // Alt + drag spreads or squeezes the selected keys from the earliest one (a move made slower or faster)
      drag = { kind: 'keys', startF: frameAt(localX(e)), df: 0, keyFrame: hit.frame, lo: Math.min(...fs), hi: Math.max(...fs), scale: e.altKey && hit.frame > Math.min(...fs), factor: 1 };
    } else drag = { kind: 'box', x0: localX(e), y0: y, x1: localX(e), y1: y, add };
    draw(); return;
  }
  // a marker's flag (the Marks row) can be dragged to another frame
  const it = items(); const hitMarker = row?.id === 'marks' && it ? it.markers.findIndex(m => Math.abs(xOf(m.frame) - localX(e)) < 7) : -1;
  if (hitMarker >= 0 && library.selected?.id === it.a.id) { drag = { kind: 'marker', index: hitMarker, frame: it.markers[hitMarker].frame }; canvas.classList.add('marker-drag'); return; }
  if (e.shiftKey) { drag = { kind: 'range', from: f }; keep.setRange(f, f); }
  else { drag = { kind: 'scrub' }; viewer.setPlaying(false); viewer.setFrame(f); }
  draw();
});
canvas.addEventListener('pointermove', e => {
  if (!frames()) return;
  const f = frameAt(localX(e)); hover = f;
  if (drag?.kind === 'keys' && drag.scale) drag.factor = Math.max(0, Math.min((frames() - 1 - drag.lo) / Math.max(1, drag.hi - drag.lo), (f - drag.lo) / (drag.keyFrame - drag.lo)));
  else if (drag?.kind === 'keys') drag.df = Math.max(-drag.lo, Math.min(frames() - 1 - drag.hi, f - drag.startF));
  else if (drag?.kind === 'box') { const r = canvas.getBoundingClientRect(); drag.x1 = localX(e); drag.y1 = e.clientY - r.top; drag.moved = drag.moved || Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 4; }
  else if (drag?.kind === 'scrub') viewer.setFrame(f);
  else if (drag?.kind === 'range') keep.setRange(drag.from, f);
  else if (drag?.kind === 'marker') { const a = library.selected; if (a?.markers?.[drag.index]) { a.markers[drag.index].frame = f; drag.moved = true; } }
  draw();
  // hover title: nearest marker / keyframe
  const it = items(); let tip = `frame ${f + 1} · ${(f / FPS).toFixed(2)} s`;
  const near = [...K.keys().map(k => ({ frame: k.frame, text: `key: ${K.partLabel[k.part].toLowerCase()} (${k.interp || 'smooth'})` })), ...it.markers.map(m => ({ frame: m.frame, text: 'marker ' + m.name })), ...it.extra.map(m => ({ frame: m.frame, text: m.name })), ...it.handKeys,
    ...it.own.keys.map(k => ({ frame: k.frame, text: 'keyframe: ' + typeName(k.type) })), ...it.own.runs.flatMap(r => r.frames.map(fr => ({ frame: fr, text: `kept ${typeName(r.type)} ${r.from + 1}–${r.to + 1}` }))),
    ...it.pending.keys.map(k => ({ frame: k.frame, text: 'next generation: ' + typeName(k.type) })), ...it.pending.runs.flatMap(r => r.frames.map(fr => ({ frame: fr, text: `next generation keeps ${typeName(r.type)} ${r.from + 1}–${r.to + 1}` })))]
    .filter(m => Math.abs(xOf(m.frame) - localX(e)) < 5);
  if (near.length) tip += ' · ' + [...new Set(near.map(m => m.text))].join(', ');
  const hitIssues = (it.issues || []).filter(s => (f >= s.from && f <= s.to) || (s.from === s.to && Math.abs(xOf(s.from) - localX(e)) < 5));
  if (hitIssues.length) tip += ' · check: ' + [...new Set(hitIssues.map(s => s.text))].join('; ');
  canvas.title = tip;
});
canvas.addEventListener('pointerleave', () => { hover = null; draw(); });
const end = async () => {
  if (drag?.kind === 'keys') {
    const d = drag;
    if (d.scale) { if (Math.abs(d.factor - 1) > 1e-3) await K.scaleSelected(d.lo, d.factor); }
    else if (d.df) await K.moveSelected(d.df);
    else { viewer.setPlaying(false); viewer.setFrame(d.keyFrame); }   // a click on a key goes to its frame
  } else if (drag?.kind === 'box') {
    const d = drag;
    if (d.moved) boxSelect(d);
    else { if (!d.add) K.selection.clear(); viewer.setPlaying(false); viewer.setFrame(frameAt(d.x0)); }
  }
  if (drag?.kind === 'marker') {
    canvas.classList.remove('marker-drag');
    const a = library.selected;
    if (drag.moved && a) { try { await library.patch(a.id, { markers: a.markers }); await library.refresh(); window.renderMarkers?.(); library.setStatus(`Marker moved to frame ${a.markers[drag.index]?.frame + 1}.`); } catch (e) { library.setStatus(e.message, 'error'); } }
  }
  drag = null; draw();
};
canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
canvas.addEventListener('dblclick', e => {
  const it = items(); if (!it) return;
  const x = localX(e);
  const near = [...K.keyFrames(), ...it.markers.map(m => m.frame), ...it.own.keys.map(k => k.frame), ...it.pending.keys.map(k => k.frame), ...it.own.runs.flatMap(r => [r.from, r.to]), ...it.pending.runs.flatMap(r => [r.from, r.to])].find(f => Math.abs(xOf(f) - x) < 6);
  if (near != null) { viewer.setPlaying(false); viewer.setFrame(near); }
});
canvas.addEventListener('wheel', e => {
  if (!frames()) return; e.preventDefault();
  if (e.ctrlKey || e.metaKey) {   // zoom round the frame under the pointer
    const [a, b] = span(), at = a + (localX(e) - PAD) / (px() - 2 * PAD) * (b - a), k = Math.exp(Math.sign(e.deltaY) * 0.18);
    setView(at - (at - a) * k, at + (b - at) * k); return;
  }
  if (e.altKey && zoomed()) { const [a, b] = span(), d = (b - a) * 0.1 * Math.sign(e.deltaY || e.deltaX); setView(a + d, b + d); return; }   // Alt + wheel slides the view
  viewer.setPlaying(false); viewer.setFrame(viewer.state.frame + Math.sign(e.deltaY) * (e.shiftKey ? 10 : 1));
}, { passive: false });
canvas.addEventListener('dblclick', e => { const r = canvas.getBoundingClientRect(); if (e.clientY - r.top < RULER) { v0 = 0; v1 = null; draw(); } });
export const viewSpan = () => span();

// Transport: first / last frame (Home / End do the same).
document.querySelector('#toStart')?.addEventListener('click', () => { if (frames()) { viewer.setPlaying(false); viewer.setFrame(0); } });
document.querySelector('#toEnd')?.addEventListener('click', () => { if (frames()) { viewer.setPlaying(false); viewer.setFrame(frames() - 1); } });

viewer.onFrameChange(() => { follow(); draw(); });
let rowSig = '';
const relayout = () => {
  const kp = keyedParts().map(([p]) => p).join(','), kfCount = K.keyFrames().length;
  const sig = [expanded, kp, kfCount, !!guideCount(), !!markCount(), handsSet()].join('|');
  if (sig !== rowSig) { rowSig = sig; layoutRows(); canvas.width = 0; }
  draw();
};
K.onChange(relayout);
K.onPendingChange?.(draw);

// Right-click on a key row: what can be done with the keys there.
function keyMenu(x, y) {
  let m = document.querySelector('#keyMenu');
  if (!m) {
    m = Object.assign(document.createElement('div'), { id: 'keyMenu', className: 'key-menu' }); m.hidden = true; document.body.append(m);
    document.addEventListener('pointerdown', ev => { if (!m.hidden && !m.contains(ev.target)) m.hidden = true; }, true);
  }
  const has = K.selection.size > 0, item = (text, fn, hint = '') => { const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title: hint }); b.onclick = () => { m.hidden = true; fn(); }; return b; };
  const sep = () => Object.assign(document.createElement('hr'));
  m.replaceChildren(
    item('Key the whole body here', () => K.keyHere({ all: true }), 'Every part, as the pose is at the playhead (Shift+S)'),
    ...(has ? [sep(), item('Smooth to the next key', () => K.setInterp('smooth')), item('Linear to the next key', () => K.setInterp('linear')), item('Hold until the next key', () => K.setInterp('hold')),
      sep(), item('Copy', () => K.copySelected(), 'Ctrl+C'), item(`Delete ${K.selection.size === 1 ? 'key' : K.selection.size + ' keys'}`, () => K.deleteSelected(), 'Delete')] : []),
    ...(K.hasClipboard() ? [item('Paste at the playhead', () => K.paste(), 'Ctrl+V')] : []));
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
canvas.addEventListener('contextmenu', e => {
  const r = canvas.getBoundingClientRect(), row = rowAt(e.clientY - r.top);
  if (!isKeyRow(row)) return;
  e.preventDefault();
  const hit = keyHit(localX(e), row);
  if (hit && !hit.ids.every(i => K.selection.has(i))) { K.selection.clear(); for (const i of hit.ids) K.selection.add(i); draw(); }
  keyMenu(e.clientX, e.clientY);
});
// Keys from the keyboard (not while typing, not with a dialog open, not while a box on the stage is selected).
window.addEventListener('keydown', e => {
  const t = e.target; if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  if (document.querySelector('dialog[open]') || viewer.state.selectedProp >= 0 || !frames()) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (k === 's' && !mod && !e.altKey) { e.preventDefault(); K.keyHere({ all: e.shiftKey }); }
  else if ((k === 'delete' || k === 'backspace') && K.selection.size) { e.preventDefault(); K.deleteSelected(); }
  else if (mod && k === 'c' && K.selection.size) { e.preventDefault(); K.copySelected(); }
  else if (mod && k === 'v' && K.hasClipboard()) { e.preventDefault(); K.paste(); }
  else if (k === ',' && !mod) K.jump(-1);
  else if (k === '.' && !mod) K.jump(1);
  else if (k === 'escape' && K.selection.size) K.clearSelection();
});
document.querySelector('#keyNow')?.addEventListener('click', e => K.keyHere({ all: e.shiftKey }));
document.querySelector('#undoBtn')?.addEventListener('click', async () => (await import('./handles.js')).undoEdit());
document.querySelector('#redoBtn')?.addEventListener('click', async () => (await import('./handles.js')).redoEdit());
viewer.onDraw(() => {
  const a = viewer.state.animation, u = document.querySelector('#undoBtn'), r = document.querySelector('#redoBtn');
  if (u) { u.disabled = !(a?.edits > 0); u.title = a?.edits > 0 ? `Undo the last edit (Ctrl+Z) · ${a.edits} to undo` : 'Nothing to undo'; }
  if (r) { r.disabled = !(a?.redos > 0); r.title = a?.redos > 0 ? `Redo (Ctrl+Y) · ${a.redos} to redo` : 'Nothing to redo'; }
  const fs = K.keyFrames(), f = viewer.state.frame;
  const prevF = [...fs].reverse().find(x => x < f), nextF = fs.find(x => x > f);
  const pk = document.querySelector('#prevKey'), nk = document.querySelector('#nextKey');
  if (pk) { pk.disabled = prevF == null; pk.title = prevF != null ? `Previous key (,) · frame ${prevF + 1}` : (fs.length ? 'At or before the first key' : 'No keys on this clip yet'); }
  if (nk) { nk.disabled = nextF == null; nk.title = nextF != null ? `Next key (.) · frame ${nextF + 1}` : (fs.length ? 'At or past the last key' : 'No keys on this clip yet'); }
});
document.querySelector('#prevKey')?.addEventListener('click', () => K.jump(-1));
document.querySelector('#nextKey')?.addEventListener('click', () => K.jump(1));
const blendSel = document.querySelector('#keyBlend');
blendSel?.addEventListener('change', () => K.setBlend(+blendSel.value));
viewer.onDraw(() => { if (blendSel && document.activeElement !== blendSel) { const b = String(K.blend()); if (![...blendSel.options].some(o => o.value === b)) blendSel.append(new Option(b + ' frames', b)); blendSel.value = b; } });
layoutRows();
viewer.onDraw(relayout);
new ResizeObserver(draw).observe(canvas);
export function refresh() { draw(); }
