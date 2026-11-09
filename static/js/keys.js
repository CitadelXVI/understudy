// Timeline keys (the key layer, layer.go): keyframes per body part on top of the generated motion. A key holds the pose
// of its part at its frame; between two keys of a part the motion blends from one to the next (smooth, linear or held),
// before the first and after the last it eases in and out over `blend` frames. Keys are saved with the clip; every
// change is one undoable edit (Ctrl+Z).
//
// Key (S): the parts changed in the Handles pose at this frame (all parts when nothing is changed, or with Shift).
// Selection is a set of 'part@frame' strings; timeline.js draws and edits it.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as compose from './compose.js';

export const PARTS = [['body', 'Body'], ['spine', 'Back & head'], ['larm', 'Left arm'], ['rarm', 'Right arm'], ['lleg', 'Left leg'], ['rleg', 'Right leg']];
export const partLabel = Object.fromEntries(PARTS);
export const selection = new Set();
export const id = k => `${k.part}@${k.frame}`;
let listeners = [];
export const onChange = fn => listeners.push(fn);
const changed = () => { for (const fn of listeners) try { fn(); } catch {} };

export const layerOf = a => a?.layer || null;
export function keys() { return layerOf(viewer.state.animation)?.keys || []; }
export function blend() { const l = layerOf(viewer.state.animation); return l ? l.blend : remembered(); }
const remembered = () => { try { return +(localStorage.getItem('understudy.keyBlend') || 12); } catch { return 12; } };

// The joints of each part, as the server splits them (layer.go layerParts).
let partsCache = null;
export function jointParts() {
  const sk = viewer.skeleton; if (!sk?.names) return {};
  if (partsCache?.names === sk.names) return partsCache.parts;
  const idx = (...ns) => { for (const n of ns) { const i = sk.names.indexOf(n); if (i >= 0) return i; } return -1; };
  const under = r => { const set = new Set(r >= 0 ? [r] : []); let more = true; while (more) { more = false; sk.parents.forEach((p, j) => { if (p >= 0 && set.has(p) && !set.has(j)) { set.add(j); more = true; } }); } return set; };
  const sets = { larm: under(idx('LeftShoulder', 'left_collar', 'left_shoulder_pitch_skel')), rarm: under(idx('RightShoulder', 'right_collar', 'right_shoulder_pitch_skel')),
    lleg: under(idx('LeftLeg', 'left_hip', 'left_hip_pitch_skel')), rleg: under(idx('RightLeg', 'right_hip', 'right_hip_pitch_skel')) };
  const parts = { body: [], spine: [], larm: [], rarm: [], lleg: [], rleg: [] };
  sk.parents.forEach((p, j) => { let n = p < 0 ? 'body' : 'spine'; for (const k of ['larm', 'rarm', 'lleg', 'rleg']) if (sets[k].has(j)) n = k; parts[n].push(j); });
  partsCache = { names: sk.names, parts }; return parts;
}

// Handles registers where its pose is (the pose being edited and the clip's pose under it, at a frame).
let poseSource = () => null;
export const setPoseSource = fn => { poseSource = fn; };
let pendingSource = () => null;
let pendingListeners = [];
export const setPendingKeySource = fn => { pendingSource = fn; };
export const pendingFrame = () => pendingSource();
export const onPendingChange = fn => pendingListeners.push(fn);
export const notifyPending = () => { for (const fn of pendingListeners) try { fn(); } catch {} };
export const hasClipboard = () => !!clipboard?.length;

// The pose on the stage at the current frame (the clip's, or the Handles edit when it is on this frame).
function stagePose() {
  const st = viewer.state, f = st.frame, o = st.override;
  if (o && o.frame === f) return { root: [...o.root], rotations: o.rotations.map(r => [...r]) };
  const J = viewer.skeleton.parents.length, rotations = [];
  for (let j = 0; j < J; j++) rotations.push([...st.rotations.subarray((f * J + j) * 4, (f * J + j + 1) * 4)]);
  return { root: [...st.root.slice(f * 3, f * 3 + 3)], rotations };
}

// Which parts a pose changed from the clip at this frame.
export function changedParts(pose, base) {
  const parts = jointParts(), out = [];
  const diff = (a, b) => 1 - Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) > 1e-6;
  for (const [p] of PARTS) {
    let moved = parts[p].some(j => diff(pose.rotations[j], base.rotations[j]));
    if (p === 'body') moved = moved || Math.hypot(pose.root[0] - base.root[0], pose.root[1] - base.root[1], pose.root[2] - base.root[2]) > 1e-5;
    if (moved) out.push(p);
  }
  return out;
}

// Save the clip's keys (all of them): one edit, undoable. Reloads the clip on the stage at the same frame.
export async function commit(list, { message, blend: b } = {}) {
  const a = viewer.state.animation; if (!a) return false;
  const bl = b ?? blend(), frame = viewer.state.frame;
  try {
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'layer', in_place: true, layer: { keys: list, blend: bl } }) });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json();
    await library.refresh();
    viewer.setOverride(null);
    await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
    // the selection follows the keys that still exist
    const now = new Set((updated.layer?.keys || []).map(id));
    for (const s of [...selection]) if (!now.has(s)) selection.delete(s);
    if (message) library.setStatus(message);
    changed();
    return true;
  } catch (e) { library.setStatus(e.message, 'error'); return false; }
}

// Key the stage's pose at this frame: the changed parts (or all of them).
export async function keyHere({ all = false, pose = null, base = null } = {}) {
  const a = viewer.state.animation; if (!a || !viewer.state.rotations) return false;
  const ps = !pose ? poseSource() : null;
  if (ps && ps.frame === viewer.state.frame) { pose = ps.pose; base = ps.base; }
  const p = pose || stagePose(), f = viewer.state.frame;
  let parts = all || !base ? [] : changedParts(p, base);
  const allParts = !parts.length;
  if (allParts) parts = PARTS.map(([x]) => x);
  const fresh = parts.map(part => ({ frame: f, part, rotations: p.rotations.map(r => [...r]), ...(part === 'body' ? { root: [...p.root] } : {}) }));
  const keep = keys().filter(k => !(k.frame === f && parts.includes(k.part)));
  selection.clear(); for (const k of fresh) selection.add(id(k));
  return commit([...keep, ...fresh], { message: `Key set at frame ${f + 1}: ${allParts ? 'the whole body' : parts.map(x => partLabel[x].toLowerCase()).join(', ')}. Ctrl+Z undoes it.` });
}

export function selectedKeys() { return keys().filter(k => selection.has(id(k))); }

export async function deleteSelected() {
  const n = selection.size; if (!n) return;
  const rest = keys().filter(k => !selection.has(id(k)));
  selection.clear();
  await commit(rest, { message: `${n} key${n === 1 ? '' : 's'} deleted. Ctrl+Z undoes it.` });
}

// Move the selected keys by df frames (kept inside the clip; a moved key replaces one already at its new place).
export async function moveSelected(df) {
  if (!df || !selection.size) return;
  const n = viewer.state.animation.frames, sel = selectedKeys();
  const lo = Math.min(...sel.map(k => k.frame)), hi = Math.max(...sel.map(k => k.frame));
  df = Math.max(-lo, Math.min(n - 1 - hi, df)); if (!df) return;
  const moved = sel.map(k => ({ ...k, frame: k.frame + df }));
  const movedIds = new Set(moved.map(id));
  const rest = keys().filter(k => !selection.has(id(k)) && !movedIds.has(id(k)));
  selection.clear(); for (const k of moved) selection.add(id(k));
  await commit([...rest, ...moved], { message: `Moved ${moved.length} key${moved.length === 1 ? '' : 's'} ${df > 0 ? 'later' : 'earlier'} by ${Math.abs(df)} frame${Math.abs(df) === 1 ? '' : 's'}.` });
}

// Spread or squeeze the selected keys from `pivot` by `factor` (Alt + drag on the timeline).
export async function scaleSelected(pivot, factor) {
  if (!selection.size) return;
  const n = viewer.state.animation.frames, sel = selectedKeys();
  const moved = new Map();
  for (const k of sel) { const f = Math.max(0, Math.min(n - 1, pivot + Math.round((k.frame - pivot) * factor))); moved.set(`${k.part}@${f}`, { ...k, frame: f }); }
  const list = [...moved.values()], ids = new Set(list.map(id));
  const rest = keys().filter(k => !selection.has(id(k)) && !ids.has(id(k)));
  selection.clear(); for (const k of list) selection.add(id(k));
  await commit([...rest, ...list], { message: `Retimed ${sel.length} key${sel.length === 1 ? '' : 's'}: ${factor > 1 ? 'slower' : 'faster'} (×${factor.toFixed(2)}).${list.length < sel.length ? ` ${sel.length - list.length} landed on the same frame and merged.` : ''}` });
}

export async function setInterp(kind) {
  if (!selection.size) return;
  const list = keys().map(k => selection.has(id(k)) ? { ...k, interp: kind === 'smooth' ? '' : kind } : k);
  await commit(list, { message: `${selection.size} key${selection.size === 1 ? '' : 's'}: ${{ smooth: 'smooth', linear: 'linear', hold: 'hold' }[kind]} to the next key.` });
}

let clipboard = null;
export function copySelected() {
  const sel = selectedKeys(); if (!sel.length) return false;
  const lo = Math.min(...sel.map(k => k.frame));
  clipboard = sel.map(k => ({ ...k, frame: k.frame - lo }));
  library.setStatus(`${sel.length} key${sel.length === 1 ? '' : 's'} copied. Go to a frame and press Ctrl+V.`);
  return true;
}
export async function paste() {
  if (!clipboard?.length) return false;
  const n = viewer.state.animation?.frames || 0, f = viewer.state.frame;
  const fresh = clipboard.map(k => ({ ...k, frame: k.frame + f })).filter(k => k.frame < n);
  const ids = new Set(fresh.map(id));
  selection.clear(); for (const k of fresh) selection.add(id(k));
  await commit([...keys().filter(k => !ids.has(id(k))), ...fresh], { message: `${fresh.length} key${fresh.length === 1 ? '' : 's'} pasted at frame ${f + 1}.` });
  return true;
}

export async function setBlend(b) {
  try { localStorage.setItem('understudy.keyBlend', String(b)); } catch {}
  if (keys().length) await commit(keys(), { blend: b, message: `Keys ease in and out over ${b} frames.` });
}

// The key frames, for jumping between them.
export function keyFrames() { return [...new Set(keys().map(k => k.frame))].sort((p, q) => p - q); }
export function jump(dir) {
  const fs = keyFrames(), f = viewer.state.frame; if (!fs.length) return;
  const to = dir > 0 ? fs.find(x => x > f) : [...fs].reverse().find(x => x < f);
  if (to != null) { viewer.setPlaying(false); viewer.setFrame(to); }
}
export const clearSelection = () => { selection.clear(); changed(); };

// Auto key: Handles keys each change as it is let go (remembered).
// on unless turned off: a dragged limb becomes part of the clip by itself (critic: four ways to commit a pose)
let auto = (() => { try { return localStorage.getItem('understudy.autoKey') !== '0'; } catch { return true; } })();
export const autoKey = () => auto;
export function setAutoKey(on) {
  auto = !!on; try { localStorage.setItem('understudy.autoKey', auto ? '1' : '0'); } catch {}
  const b = document.querySelector('#autoKey'); if (b) { b.classList.toggle('on', auto); b.setAttribute('aria-pressed', auto); }
  document.body.classList.toggle('autokey', auto);
  changed();
}
document.querySelector('#autoKey')?.addEventListener('click', () => setAutoKey(!auto));
{ const b = document.querySelector('#autoKey'); if (b) { b.classList.toggle('on', auto); b.setAttribute('aria-pressed', auto); } document.body.classList.toggle('autokey', auto); }
