// Keep ranges: mark the frames of the clip on screen worth keeping and feed
// them to the next generation as dense constraints (one key every few frames,
// the range's first and last frames always included), or keep everything
// outside a range and regenerate just that range with a new prompt.
// Measured 2026-10-24 on a 90-frame walk: with post-processing on, kept frames
// land within 0.4 cm at one key per 6 frames and the free part moves as
// cleanly as the source; one key per 15 frames drifts 14 cm after the seam.
import * as viewer from './viewer.js';
import * as compose from './compose.js';
import * as library from './library.js';
import { ask } from './dialogs.js';

const $ = s => document.querySelector(s);
const bar = $('#keepBar'), band = $('#keepBand'), button = $('#keepTool'), hint = $('#keepHint'), partSelect = $('#keepPart'), densitySelect = $('#keepDensity');
export const PARTS = {
  body: { label: 'full body' },
  feet: { label: 'feet', joints: ['LeftFoot', 'RightFoot'] },
  hands: { label: 'hands', joints: ['LeftHand', 'RightHand'] },
  limbs: { label: 'hands + feet', joints: ['LeftHand', 'RightHand', 'LeftFoot', 'RightFoot'] },
  lfoot: { label: 'left foot', joints: ['LeftFoot'] },
  rfoot: { label: 'right foot', joints: ['RightFoot'] },
  hips: { label: 'hips path' },
};
const minSegment = 60; // Kimodo's shortest prompt segment
let active = false, range = { in: null, out: null }, rangeClip = null;

export function setActive(on) { active = on; bar.hidden = !on; button.classList.toggle('on', on); update(); }
export function isActive() { return active; }
button.onclick = () => setActive(!active);

const clip = () => viewer.state.animation;
export function bounds() { if (range.in == null || range.out == null || rangeClip !== viewer.state.animation?.id) return null; return range.in <= range.out ? [range.in, range.out] : [range.out, range.in]; }
export function setRange(a, b) { if (!clip()) return; startRange(); range.in = Math.min(a, b); range.out = Math.max(a, b); if (!active) setActive(true); update(); }
function startRange() { const a = clip(); if (rangeClip !== a.id) { range = { in: null, out: null }; rangeClip = a.id; } }
export function setIn(f = viewer.state.frame) { if (!clip()) return; startRange(); range.in = f; if (range.out == null) range.out = clip().frames - 1; if (!active) setActive(true); update(); }
export function setOut(f = viewer.state.frame) { if (!clip()) return; startRange(); range.out = f; if (range.in == null) range.in = 0; if (!active) setActive(true); update(); }
export function clearRange() { range = { in: null, out: null }; update(); }

// The frames pinned inside [from, to]: every `step`th, plus the last one.
export function keyFrames(from, to, step) {
  const idx = [];
  for (let f = from; f < to; f += step) idx.push(f);
  idx.push(to);
  return idx;
}

function syncRangeButtons(hasRange) {
  const why = 'Pick a range first: Shift-drag across the timeline, or press Set start and Set end';
  for (const sel of ['#keepClear', '#keepRegen', '#tweenRange', '#mirrorRange', '#cutRange', '#keepAdd']) {
    const btn = $(sel); if (!btn) continue;
    if (btn.dataset.baseTitle === undefined) btn.dataset.baseTitle = btn.title || '';
    btn.disabled = !hasRange;
    btn.title = hasRange ? btn.dataset.baseTitle : why;
  }
}

function update() {
  const a = clip(), b = bounds(), hasRange = !!(a && b && rangeClip === a.id);
  syncRangeButtons(hasRange);
  viewer.draw();
  if (!a) { band.hidden = true; hint.textContent = 'Select a clip first.'; return; }
  // the start and end buttons carry their frames (a first-time user could not see where the range was)
  const inB = $('#keepIn'), outB = $('#keepOut');
  if (inB) inB.textContent = hasRange ? `Start: ${b[0] + 1}` : 'Set start';
  if (outB) outB.textContent = hasRange ? `End: ${b[1] + 1}` : 'Set end';
  if (!hasRange) { band.hidden = true; hint.textContent = 'Pick a stretch: Shift-drag across the timeline, or press Set start where it begins and Set end where it ends (keys: [ and ]).'; return; }
  const n = Math.max(1, a.frames - 1);
  band.hidden = false; band.style.left = `${b[0] / n * 100}%`; band.style.width = `${Math.max(.4, (b[1] - b[0]) / n * 100)}%`;
  const step = Number(densitySelect.value), keys = keyFrames(b[0], b[1], step).length;
  hint.textContent = `Frames ${b[0] + 1}–${b[1] + 1} of “${library.titleOf(a).slice(0, 36)}” · ${keys} key${keys === 1 ? '' : 's'}`;
}
densitySelect.onchange = update;

// One constraint covering [from, to] of the clip's own streams, tagged with
// where it came from (`keep`) for the list and the clip's lineage.
export function buildKeep(a, root, rotations, from, to, part, step) {
  const joints = rotations.length / (a.frames * 4);
  const idx = keyFrames(from, to, step);
  const rootAt = f => [root[f * 3], root[f * 3 + 1], root[f * 3 + 2]];
  const rotAt = f => { const out = []; for (let j = 0; j < joints; j++) { const at = (f * joints + j) * 4; out.push([rotations[at], rotations[at + 1], rotations[at + 2], rotations[at + 3]]); } return out; };
  let c;
  if (part === 'hips') {
    c = { type: 'root2d', frame_indices: idx, smooth_root_2d: idx.map(f => { const r = rootAt(f); return [r[0], r[2]]; }), global_root_heading: idx.map(f => { const h = compose.headingOf(rotAt(f)[0]); return [Math.cos(h), Math.sin(h)]; }) };
  } else {
    const spec = PARTS[part] || PARTS.body;
    c = { type: spec.joints ? 'end-effector' : 'fullbody', frame_indices: idx, root_positions: idx.map(rootAt), local_joints_rot_xyzw: idx.map(rotAt) };
    if (spec.joints) c.joint_names = [...spec.joints];
  }
  const heading0 = typeof a.first_heading === 'number' ? a.first_heading : compose.headingOf(rotAt(0)[0]);
  if (from === 0) c.heading = heading0;
  c.keep = { from: a.id, name: library.titleOf(a), frames: [from, to], part, step, heading0 };
  return c;
}

function current() {
  const a = clip(), b = bounds();
  if (!a || !b || rangeClip !== a.id) { hint.textContent = 'Set start and end on the clip first.'; return null; }
  if (compose.skeletonOf(a.model)?.skeleton_key !== compose.selectedSkeletonKey()) { hint.textContent = 'This clip is on a different skeleton than the selected motion model.'; return null; }
  return { a, b, root: viewer.state.root, rotations: viewer.state.rotations, part: partSelect.value, step: Number(densitySelect.value) };
}

// Keep: add the range to the next generation's constraint set (stacks with keeps from other clips).
$('#keepAdd').onclick = () => {
  const k = current(); if (!k) return;
  const c = buildKeep(k.a, k.root, k.rotations, k.b[0], k.b[1], k.part, k.step);
  const overlap = compose.currentKeyframes().filter(o => o.keep && o.type === c.type && o.frame_indices.some(f => c.frame_indices.includes(f)));
  compose.addKeyframe(c);
  const label = `Kept ${PARTS[k.part].label} frames ${k.b[0] + 1}–${k.b[1] + 1} (${c.frame_indices.length} keys).`;
  hint.textContent = overlap.length ? `${label} ⚠ Overlaps a keep already in the set on the same frames; shift one of them in the Keyframes list.` : `${label} Add more keeps or press Generate.`;
  compose.flash();
};

// Regenerate range: keep the clip's frames outside the range, new prompt for the range.
$('#keepRegen').onclick = async () => {
  const k = current(); if (!k) return;
  const { a, b, root, rotations, step } = k;
  const before = b[0], mid = b[1] - b[0] + 1, after = a.frames - 1 - b[1];
  const splittable = (before === 0 || before >= minSegment) && mid >= minSegment && (after === 0 || after >= minSegment);
  const segments = Array.isArray(a.segments) && a.segments.length ? a.segments : [{ prompt: a.prompt, frames: a.frames }];
  const text = await ask(`Regenerate frames ${b[0] + 1}–${b[1] + 1}`,
    splittable ? `Everything outside the range is kept from “${library.titleOf(a).slice(0, 40)}”. Describe the motion for these ${mid} frames.`
      : `Everything outside the range is kept from “${library.titleOf(a).slice(0, 40)}”. The range is shorter than ${minSegment} frames, so this prompt describes the whole clip (the kept frames lock the rest).`,
    splittable ? '' : a.prompt);
  if (text === null || !text.trim()) return;
  compose.restore(a);
  const keeps = [];
  if (before > 0) keeps.push(buildKeep(a, root, rotations, 0, b[0] - 1, 'body', step));
  if (after > 0) keeps.push(buildKeep(a, root, rotations, b[1] + 1, a.frames - 1, 'body', step));
  compose.replaceKeyframes(keeps);
  if (splittable) {
    const segs = [];
    if (before > 0) segs.push({ prompt: segments[0].prompt, frames: before });
    segs.push({ prompt: text.trim(), frames: mid });
    if (after > 0) segs.push({ prompt: segments[segments.length - 1].prompt, frames: after });
    compose.setSegments(segs);
  } else compose.setSegments([{ prompt: text.trim(), frames: a.frames }]);
  compose.setFirstHeading(typeof a.first_heading === 'number' ? a.first_heading : null);
  compose.setLineage({ free: [b[0], b[1]] });
  // Same prompt for the range: a different take is wanted, so a new seed (the same seed and keeps would make the same
  // motion). A new prompt: the clip's own seed (restored above), so the kept frames and the new range blend as before.
  const was = splittable ? (segments.find((s, i, all) => { let at = 0; for (let k = 0; k < i; k++) at += all[k].frames; return b[0] >= at && b[0] < at + s.frames; })?.prompt || a.prompt) : a.prompt;
  if (text.trim() === (was || '').trim()) compose.newSeed();
  hint.textContent = `Frames ${b[0] + 1}–${b[1] + 1} free, the rest kept. Generating…`;
  (window.generateNow || (() => $('#generate').click()))();
};
// Contact runs: frames where the toe is under 6 cm and moving under 0.5 m/s for at least 4 frames.
export function contactRuns(side) {
  const a = clip(); if (!a) return [];
  const names = viewer.skeleton.names, iT = names.indexOf(side + 'ToeBase'), iF = names.indexOf(side + 'Foot');
  const j = iT >= 0 ? iT : iF; if (j < 0) return [];
  const runs = []; let start = -1, prev = null;
  for (let f = 0; f < a.frames; f++) {
    const p = viewer.positionsAt(f)[j];
    const speed = prev ? Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]) * 30 : 0;
    const planted = p[1] < 0.06 && speed < 0.5;
    if (planted && start < 0) start = f;
    if (!planted && start >= 0) { if (f - start >= 4) runs.push([start, f - 1]); start = -1; }
    prev = p;
  }
  if (start >= 0 && a.frames - start >= 4) runs.push([start, a.frames - 1]);
  return runs;
}
$('#plantFeet').onclick = () => {
  const a = clip(); if (!a) { hint.textContent = 'Select a clip first.'; return; }
  if (compose.skeletonOf(a.model)?.skeleton_key !== compose.selectedSkeletonKey()) { hint.textContent = 'This clip is on a different skeleton than the selected motion model.'; return; }
  let n = 0;
  for (const side of ['Left', 'Right']) for (const [from, to] of contactRuns(side)) {
    const c = buildKeep(a, viewer.state.root, viewer.state.rotations, from, to, side === 'Left' ? 'lfoot' : 'rfoot', 3);
    compose.addKeyframe(c); n++;
  }
  hint.textContent = n ? `${n} planted-foot run${n === 1 ? '' : 's'} pinned: regenerations keep the feet where they are.` : 'No planted feet found (toe under 6 cm and still for 4+ frames).';
  if (n) compose.flash();
};
// Tween and Mirror range: baked edits over the range (undo in the Handles bar).
async function bakeRange(op, extra, label) {
  const a = clip(), b = bounds(); if (!a || !b) { hint.textContent = 'Set start and end on the clip first.'; return; }
  const frame = viewer.state.frame;
  try {
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, from: b[0], to: b[1], in_place: true, ...extra }) });
    if (!r.ok) throw new Error(await r.text());
    const updated = await r.json();
    await library.refresh();
    await viewer.load(library.find(updated.id) || updated, compose.skeletonOf(updated.model), { frame });
    hint.textContent = updated.warnings?.length ? `⚠ ${updated.warnings.join(' ')}` : `${label} over frames ${b[0] + 1}–${b[1] + 1}. Undo in the Handles bar.`;
  } catch (e) { hint.textContent = e.message; }
}
$('#tweenRange').onclick = () => bakeRange('tween', { amount: Number($('#tweenAmount').value) }, `Smoothed ${Math.round(Number($('#tweenAmount').value) * 100)}%`);
$('#mirrorRange').onclick = () => bakeRange('mirror_range', {}, 'Mirrored');
// Cut to range: a new clip of just the range (a copy; the original stays), then it goes on the stage
$('#cutRange').onclick = async () => {
  const a = clip(), b = bounds(); if (!a || !b) { hint.textContent = 'Set start and end on the clip first.'; return; }
  try {
    const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'trim', from: b[0], to: b[1], in_place: false }) });
    if (!r.ok) throw new Error(await r.text());
    const made = await r.json();
    await library.refresh();
    const item = library.find(made.id) || made;
    clearRange(); library.select(item, { frame: 0 });
    const said = `Cut frames ${b[0] + 1}–${b[1] + 1} into a new clip (${b[1] - b[0] + 1} frames); the original is unchanged.`;
    setTimeout(() => { hint.textContent = said; }, 300);   // after the range reset rewrites the hint
  } catch (e) { hint.textContent = e.message; }
};
$('#keepIn').onclick = () => setIn();
$('#keepOut').onclick = () => setOut();
$('#keepClear').onclick = () => { clearRange(); };

// The range on the stage's timeline follows the clip; a new clip starts without one.
export function onClipChanged() { if (active || !band.hidden) update(); }
