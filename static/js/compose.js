// The compose dock: prompt segments, model and sampling settings, keyframe
// constraints. `request()` turns it into the /api/generate body; `restore()`
// fills it from a saved animation so a take can be regenerated or edited.
import { currentPose, state as stage, setFrame as stageFrame, setPlaying as stagePlaying } from './viewer.js';
import { ask, choose, confirm } from './dialogs.js';

const $ = s => document.querySelector(s);
const segments = $('#segments'), prompt = $('#prompt'), modelSelect = $('#motionModel'), quantSelect = $('#textQuantization');
const seedInput = $('#seed'), cfgInput = $('#textCFG'), stepsInput = $('#steps'), postInput = $('#postProcess'), takesInput = $('#takes');
const constraintCFGInput = $('#constraintCFG'), keyframeList = $('#keyframeList'), keyframeHint = $('#keyframeHint'), reuse = $('#reuseConstraints');
const poseSelect = $('#poseSelect'), poseFrame = $('#poseFrame'), actorSelect = $('#actorTarget');
// Actors: "Actor 1 dodges Actor 2" is written for people; the model hears "a person dodges another person".
export function setActorOptions(numbers) {
  const current = actorSelect.value;
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  actorSelect.replaceChildren(...[{ v: '', t: 'No actor' }, ...numbers.map(n => ({ v: String(n), t: `Actor ${n}` })), { v: String(next), t: `New actor ${next}` }].map(o => { const el = document.createElement('option'); el.value = o.v; el.textContent = o.t; return el; }));
  actorSelect.value = [...actorSelect.options].some(o => o.value === current) ? current : '';
}
export function selectActor(n) { if ([...actorSelect.options].some(o => o.value === String(n))) actorSelect.value = String(n); }
export function rewriteActors(text, target) {
  const out = text.replace(/\bactor\s*(\d+)\b/gi, (m, n) => Number(n) === target ? 'a person' : 'another person');
  return out.charAt(0).toUpperCase() + out.slice(1);
}
let poses = [];

export let models = [], quantizations = [];
const minFrames = 60, maxFrames = 360, maxSeed = 0xFFFFFFFF, defaultCFG = 2;
let keyframes = [], selectedConstraints = [];
let pathConstraint = null; // from the Path tool: a root2d constraint the next clip follows
let firstHeading = null;   // used when no frame-0 keyframe supplies one (regenerating a clip's start)
let lineageExtra = null;   // e.g. { free: [in, out] } from Regenerate range
export function setPath(c) { pathConstraint = c; renderKeyframes(c ? 'The next clip follows the drawn path.' : undefined); }
export function currentKeyframes() { return keyframes; }
export function replaceKeyframes(list) { keyframes = list; renderKeyframes(); }
export function setFirstHeading(v) { firstHeading = v; }
export function setLineage(x) { lineageExtra = x; }
export function newSeed() { seedInput.value = randomSeed(); }
// Iterating on a clip (its keeps, pinned poses or lineage are in the composer): the next generation reuses the seed,
// so the motion stays close to the last one and only what was fixed changes. A fresh prompt gets a fresh seed.
export function iterating() { return keyframes.length > 0 || !!pathConstraint || !!lineageExtra; }
export function selectedSkeletonKey() { return skeletonOf(modelSelect.value)?.skeleton_key; }
// Replace the prompt segments: [{ prompt, frames }].
export function setSegments(segs) {
  for (const row of [...segments.children]) if (!row.hasAttribute('data-primary')) row.remove();
  prompt.value = segs[0]?.prompt || ''; segments.querySelector('[data-primary] .segment-frames').value = clampFrames(segs[0]?.frames || 150);
  for (const s of segs.slice(1)) segments.append(segmentRow(s.prompt || '', s.frames));
  updateCount();
}
// Draw the eye to the keyframes card after something was added to it from the stage.
export function flash() {
  window.showTab?.('left', 'keyframes');
  const card = keyframeList.closest('details'); if (card) card.open = true;
  keyframeList.classList.remove('flash'); void keyframeList.offsetWidth; keyframeList.classList.add('flash');
}
export function segmentsTotalFrames() { return [...segments.querySelectorAll('.segment-frames')].reduce((n, i) => n + clampFrames(i.value), 0); }
// [{start, frames}] per prompt segment, frames counted across the whole clip.
export function segmentFrames() {
  let start = 0;
  return [...segments.querySelectorAll('.segment-frames')].map(i => { const frames = clampFrames(i.value); const seg = { start, frames }; start += frames; return seg; });
}
export function savedPoses() { return poses.filter(p => p.skeleton_key === skeletonOf(modelSelect.value)?.skeleton_key); }
export function poseOnScreenRaw() { return poseOnScreen(); }
// Pin a saved pose (or the pose on screen) at a frame, with its root moved onto a path point (xz relative to the path start).
export function addPoseAtFrame(pick, frame, xz) {
  let root, rotations, name;
  if (pick === '__screen') { const pose = poseOnScreen(); if (!pose) return null; root = [...pose.root]; rotations = splitRotations(pose.rotations); name = 'pose'; }
  else { const sp = poses.find(p => p.id === pick); if (!sp) return null; root = [...sp.root]; rotations = sp.rotations.map(q => [...q]); name = sp.name; }
  const k = keyframeFrom(root, rotations, frame);
  k.root_positions[0][0] = xz[0]; k.root_positions[0][2] = xz[1];
  keyframes.push(k); renderKeyframes(`Pinned “${name}” at frame ${frame} on the path.`);
  return name;
}

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const clampSeed = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 && n <= maxSeed ? n : randomSeed(); };
const clampCFG = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 20 ? Math.round(n * 100) / 100 : defaultCFG; };
const validFrames = v => Number.isInteger(v) && v >= minFrames && v <= maxFrames;
const clampFrames = v => validFrames(Number(v)) ? Number(v) : Math.max(minFrames, Math.min(maxFrames, Number(v) || 150));
const clampSteps = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 50; };
const clampTakes = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 8 ? n : 1; };
export function takes() { const n = clampTakes(takesInput.value); takesInput.value = n; return n; }
export const skeletonOf = modelID => models.find(m => m.id === modelID);

// --- prompt segments ---
const fmtSecs = v => `${((Math.max(1, Number(v) || 150)) / 30).toFixed(1)} s`;
function syncSecs() { for (const r of segments.querySelectorAll('.segment')) { const i = r.querySelector('.segment-frames'), s = r.querySelector('.segment-secs'); if (i && s) s.textContent = fmtSecs(i.value); } }
function segmentRow(text, frames) {
  const row = document.createElement('div'); row.className = 'segment extra';
  const area = document.createElement('textarea'); area.className = 'segment-prompt'; area.rows = 3; area.value = text; area.placeholder = 'Then: what happens next'; area.title = 'The next part of the motion; it follows the part above in the same clip';
  const duration = document.createElement('input'); duration.className = 'segment-frames'; duration.type = 'number'; duration.min = minFrames; duration.max = maxFrames; duration.step = 1; duration.value = clampFrames(frames); duration.title = `How long this part is, in frames: ${minFrames} to ${maxFrames} (30 frames = 1 second)`;
  const secs = document.createElement('span'); secs.className = 'hint segment-secs'; secs.textContent = fmtSecs(duration.value);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary remove'; remove.textContent = '×'; remove.title = 'Remove this part';
  remove.onclick = () => { row.remove(); updateCount(); };
  row.append(area, duration, secs, remove);
  return row;
}
function updateCount() {
  const n = segments.querySelectorAll('.segment').length;
  syncSecs();
  $('#segmentCount').textContent = n === 1 ? '' : `${n} parts, one after the other · ${(segmentsTotalFrames() / 30).toFixed(1)} s`;
}
// Back to a blank slate: one empty segment, no keyframes, a fresh seed.
export function clear() {
  pathConstraint = null;
  for (const row of [...segments.children]) if (!row.hasAttribute('data-primary')) row.remove();
  prompt.value = ''; segments.querySelector('[data-primary] .segment-frames').value = 150;
  keyframes = []; selectedConstraints = []; firstHeading = null; lineageExtra = null; renderKeyframes();
  seedInput.value = randomSeed();
  updateCount(); prompt.focus();
}
$('#clearCompose').onclick = clear;
$('#addSegment').onclick = () => { segments.append(segmentRow('', 150)); updateCount(); segments.lastElementChild.querySelector('textarea').focus(); };
segments.addEventListener('input', e => { if (e.target.classList.contains('segment-frames')) updateCount(); });
segments.addEventListener('change', e => { if (e.target.classList.contains('segment-frames')) { e.target.value = clampFrames(e.target.value); updateCount(); } });

// --- sampling ---
seedInput.value = randomSeed();
seedInput.addEventListener('change', () => { seedInput.value = clampSeed(seedInput.value); });
$('#randomSeed').onclick = () => { seedInput.value = randomSeed(); };
cfgInput.addEventListener('change', () => { cfgInput.value = clampCFG(cfgInput.value); });
$('#resetCFG').onclick = () => { cfgInput.value = defaultCFG; };
stepsInput.addEventListener('change', () => { stepsInput.value = clampSteps(stepsInput.value); });
takesInput.addEventListener('change', () => { takesInput.value = clampTakes(takesInput.value); });
constraintCFGInput.addEventListener('change', () => { constraintCFGInput.value = clampCFG(constraintCFGInput.value); });

// --- models ---
function fillSelect(select, items, unavailableSuffix) {
  select.replaceChildren(...items.map(item => {
    const o = document.createElement('option'); o.value = item.id; o.disabled = !item.available;
    o.textContent = item.label + (item.available ? '' : unavailableSuffix); return o;
  }));
}
function updateModel() {
  const model = skeletonOf(modelSelect.value); if (!model) return;
  $('#eyebrow').textContent = 'Animation for games';   // the model's name lives in the Model picker; up here it read as jargon ("SOMA RP V1.2")
  const hint = $('#modelHint'); hint.classList.toggle('error', !model.commercial);
  const terms = model.commercial ? 'commercial use allowed (NVIDIA Open Model License)' : '⚠ non-commercial research use only';
  const link = document.createElement('a'); link.href = model.license_url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = terms;
  hint.replaceChildren(document.createTextNode(`${model.skeleton} · `), link);
  postInput.checked = model.skeleton_key !== 'g1skel34';
}
function updateQuantization() {
  const q = quantizations.find(item => item.id === quantSelect.value); if (!q) return;
  const size = q.bytes ? `${(q.bytes / 1073741824).toFixed(2)} GiB · ` : '';
  $('#quantizationHint').textContent = q.available ? `${size}${q.description}` : q.reason;
}
// one motion model = nothing to pick: the picker hides and the row has room (it read as jargon, cut to "SOM…")
new MutationObserver(() => { const lab = modelSelect.closest('label'); if (lab) lab.hidden = modelSelect.options.length <= 1; }).observe(modelSelect, { childList: true });
modelSelect.onchange = () => { updateModel(); renderPoseGrid(); };
quantSelect.onchange = updateQuantization;

export async function init() {
  [models, quantizations] = await Promise.all([fetch('/api/models').then(r => r.json()), fetch('/api/text-quantizations').then(r => r.json())]);
  fillSelect(modelSelect, models, ' — not installed');
  fillSelect(quantSelect, quantizations, ' — unavailable');
  // Newest SOMA checkpoint first, Q8 encoder (closest to BF16 at half the size); fall back to SOMA skeleton metadata if no GGUF is installed yet.
  const pref = ['soma-rp-v1.2', 'soma-rp-v1.1'];
  const pick = pref.find(id => models.some(m => m.id === id && m.available)) || pref.find(id => models.some(m => m.id === id));
  if (pick) modelSelect.value = pick;
  const qPick = quantizations.find(q => q.id === 'q8_0' && q.available) || quantizations.find(q => q.available) || quantizations.find(q => q.id === 'q8_0') || quantizations[0];
  if (qPick) quantSelect.value = qPick.id;
  updateModel(); updateQuantization(); updateCount(); renderKeyframes();
  await loadPoses();
}

// --- keyframes ---
const fmt = v => (Math.round(v * 100) / 100).toFixed(2);
const PART_LABEL = { body: 'full body', feet: 'feet', hands: 'hands', limbs: 'hands + feet', hips: 'hips path', lfoot: 'left foot planted', rfoot: 'right foot planted', hold: 'hold' };
// Guardrails. The same keep twice (Plant feet pressed again, constraints reused on top of the same ones) is
// dropped, the newer one kept. Two keeps that disagree about the same joint on the same frame, or a keep past
// the end of the clip, cannot all be honoured: Kimodo bends the body to try, which is where warped frames come
// from. Those are listed under the keyframes until they are removed.
const jointsOf = k => k.type === 'fullbody' ? ['*'] : k.type === 'root2d' ? ['root'] : (k.joint_names || []);
const sameKey = (a, b) => a.type === b.type && JSON.stringify(jointsOf(a)) === JSON.stringify(jointsOf(b)) && JSON.stringify(a.frame_indices) === JSON.stringify(b.frame_indices);
export function dedupeKeyframes(list) { const out = []; for (const k of list) { const i = out.findIndex(o => sameKey(o, k)); if (i >= 0) out[i] = k; else out.push(k); } return out; }
const describe = k => k.keep ? `“${PART_LABEL[k.keep.part] || k.keep.part}” (frames ${k.keep.frames[0] + 1}–${k.keep.frames[1] + 1})`
  : k.type === 'fullbody' ? `the pose at frame ${k.frame_indices[0] + 1}` : k.type === 'root2d' ? 'the root path' : `the ${(k.joint_names || []).join(', ')} target`;
function shareJoints(a, b) {
  const ja = jointsOf(a), jb = jointsOf(b);
  if (ja[0] === 'root' || jb[0] === 'root') return (ja[0] === 'root' || ja[0] === '*') && (jb[0] === 'root' || jb[0] === '*');
  return ja[0] === '*' || jb[0] === '*' || ja.some(j => jb.includes(j));
}
function disagreeAt(a, b, f) {
  const i = a.frame_indices.indexOf(f), j = b.frame_indices.indexOf(f);
  const xz = (k, n) => k.smooth_root_2d ? k.smooth_root_2d[n] : k.root_positions ? [k.root_positions[n][0], k.root_positions[n][2]] : null;
  const pa = xz(a, i), pb = xz(b, j);
  if (pa && pb && Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > 0.03) return true;
  if (a.root_positions && b.root_positions && Math.abs(a.root_positions[i][1] - b.root_positions[j][1]) > 0.03) return true;
  const ra = a.local_joints_rot_xyzw?.[i], rb = b.local_joints_rot_xyzw?.[j];
  if (ra && rb) for (let n = 0; n < Math.min(ra.length, rb.length); n++) {
    const d = Math.abs(ra[n][0] * rb[n][0] + ra[n][1] * rb[n][1] + ra[n][2] * rb[n][2] + ra[n][3] * rb[n][3]);
    if (2 * Math.acos(Math.min(1, d)) > 10 * Math.PI / 180) return true;
  }
  return false;
}
function clipLength() { return [...segments.querySelectorAll('.segment-frames')].reduce((s, el) => s + (Number(el.value) || 0), 0); }
export function keyframeWarnings(list = pathConstraint ? [pathConstraint, ...keyframes] : keyframes) {
  const out = [], total = clipLength();
  list.forEach((a, n) => {
    const last = Math.max(...(a.frame_indices || [0]));
    if (total && last >= total) out.push(`${describe(a)} reaches frame ${last + 1}, past the end of this ${total}-frame clip; slide it or remove it.`);
    for (const b of list.slice(n + 1)) {
      if (!shareJoints(a, b)) continue;
      const f = (a.frame_indices || []).find(x => (b.frame_indices || []).includes(x) && disagreeAt(a, b, x));
      if (f !== undefined) out.push(`${describe(a)} and ${describe(b)} want different poses at frame ${f + 1}; the generation cannot match both and will bend the body trying. Remove one.`);
    }
  });
  return out;
}
function renderKeyframes(message) {
  const guide = $('#guideCard'); if (guide && (keyframes.length || pathConstraint || message)) guide.open = true;   // something to show: open it
  reuse.hidden = !selectedConstraints.length;
  const planned = selectedConstraints.filter(c => c.label && c.label !== 'Standing start').length;
  reuse.textContent = planned ? `Edit this clip's ${planned} planned key${planned === 1 ? '' : 's'} for the next clip` : `Use the selected animation's ${selectedConstraints.length} constraint${selectedConstraints.length === 1 ? '' : 's'}`;
  reuse.title = 'Load the poses this clip was generated through into the list below: change a frame, remove a key, or pose the stage and Pin this pose to replace the key at that frame; then generate again';
  const rows = pathConstraint ? [pathConstraint, ...keyframes] : keyframes;
  keyframeList.replaceChildren(...rows.map((constraint, index) => {
    const isPath = constraint === pathConstraint;
    if (!isPath) index -= pathConstraint ? 1 : 0;
    const row = document.createElement('div'); row.className = 'keyframe';
    const text = document.createElement('div');
    const type = document.createElement('div'); type.className = 'type';
    const keep = constraint.keep;
    type.textContent = keep ? `Keep · ${PART_LABEL[keep.part] || keep.part} · frames ${keep.frames[0] + 1}–${keep.frames[1] + 1}`
      : constraint.label ? constraint.label : constraint.type === 'fullbody' ? 'Full-body pose' : constraint.type === 'end-effector' ? `Target: ${(constraint.joint_names || []).join(', ')}` : constraint.type === 'root2d' ? 'Root path' : constraint.type;
    const detail = document.createElement('div'); detail.className = 'detail';
    const rp = constraint.root_positions?.[0], r2 = constraint.smooth_root_2d?.[0];
    detail.textContent = keep ? `from “${keep.name.slice(0, 32)}” · ${constraint.frame_indices.length} keys` : rp ? `hips ${fmt(rp[0])}, ${fmt(rp[1])}, ${fmt(rp[2])} m` : r2 ? `root at ${fmt(r2[0])}, ${fmt(r2[1])} m` : '';
    text.append(type, detail);
    // a planned key reads by its figure and its words, not hip coordinates (critic, 2026-10-28)
    const rot = constraint.local_joints_rot_xyzw?.[0], rp0 = constraint.root_positions?.[0], skel = skeletonOf(modelSelect.value);
    let fig = null;
    if (rot && rp0 && skel?.parents && rot.length === skel.parents.length) {
      fig = document.createElement('canvas'); fig.width = 34; fig.height = 44; fig.className = 'key-fig';
      try { poseFigure(fig, { root: rp0, rotations: rot }, skel); } catch { fig = null; }
    }
    if (constraint.label) detail.textContent = constraint.frame_indices?.length === 1 ? `frame ${constraint.frame_indices[0] + 1} · click to see it on the stage` : `frames ${constraint.frame_indices[0] + 1}–${constraint.frame_indices[constraint.frame_indices.length - 1] + 1}`;
    if (constraint.frame_indices?.length) {
      text.classList.add('goto'); text.title = 'Show this frame on the stage (to change this pose: pose the stage, then Pin this pose)';
      text.onclick = () => { stagePlaying(false); stageFrame(Math.max(0, Math.min((stage.animation?.frames || 1) - 1, constraint.frame_indices[0]))); };
    }
    let frame;
    if (constraint.frame_indices?.length === 1) {
      frame = document.createElement('input'); frame.type = 'number'; frame.min = 1; frame.step = 1; frame.className = 'frame'; frame.value = constraint.frame_indices[0] + 1; frame.title = 'Frame of the generated clip this is reached at';
      frame.addEventListener('change', () => { constraint.frame_indices = [Math.max(0, (Math.floor(Number(frame.value)) || 1) - 1)]; frame.value = constraint.frame_indices[0] + 1; });
    } else if (keep) {
      // A kept range can be slid to another place in the new clip; its frames move together.
      frame = document.createElement('input'); frame.type = 'number'; frame.min = 0; frame.step = 1; frame.className = 'frame'; frame.value = constraint.frame_indices[0]; frame.title = 'Frame of the generated clip this range starts at (slide the whole range)';
      frame.addEventListener('change', () => {
        const start = Math.max(0, Math.floor(Number(frame.value)) || 0), delta = start - constraint.frame_indices[0];
        constraint.frame_indices = constraint.frame_indices.map(f => f + delta); keep.frames = [keep.frames[0] + delta, keep.frames[1] + delta];
        if (constraint.frame_indices[0] === 0 && typeof keep.heading0 === 'number') constraint.heading = keep.heading0; else delete constraint.heading;
        frame.value = start; renderKeyframes();
      });
    } else { frame = document.createElement('span'); frame.className = 'hint'; frame.textContent = `${constraint.frame_indices?.length ?? 0} frames`; }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary remove'; remove.textContent = '×'; remove.title = 'Remove constraint';
    remove.onclick = () => { if (isPath) { pathConstraint = null; import('./path.js').then(m => m.setActive(false)); } else keyframes.splice(index, 1); renderKeyframes(); };
    if (fig) row.append(fig);
    row.append(text, frame);
    // a single-frame pose (a planned step, a pinned pose): swap in the pose on the stage, keeping the step's frame
    if (!isPath && !keep && (constraint.type === 'fullbody' || constraint.type === 'end-effector') && constraint.frame_indices?.length === 1) {
      const use = document.createElement('button'); use.type = 'button'; use.className = 'secondary use-stage'; use.textContent = 'Set from stage';
      use.title = 'Overwrite this step with the pose currently on the stage (pose it with Handles first); the step keeps its frame';
      use.onclick = () => {
        const pose = poseOnScreen(); if (!pose) return;
        const k = keyframeFrom(pose.root, splitRotations(pose.rotations), constraint.frame_indices[0]);
        if (constraint.type === 'end-effector') { k.type = 'end-effector'; k.joint_names = [...(constraint.joint_names || [])]; }   // a planned step holds the same joints (hips and feet)
        if (constraint.label) k.label = constraint.label.replace(/ \(changed\)$/, '') + ' (changed)';
        keyframes[index] = k; renderKeyframes(`Step at frame ${constraint.frame_indices[0] + 1} now uses the pose on the stage.`);
      };
      row.append(use);
    }
    row.append(remove);
    return row;
  }));
  const warnings = keyframeWarnings();
  keyframeHint.classList.remove('warn');
  let warnBox = document.querySelector('#keyframeWarn');
  if (!warnBox) { warnBox = Object.assign(document.createElement('div'), { id: 'keyframeWarn', className: 'hint warn' }); keyframeHint.after(warnBox); }
  warnBox.textContent = warnings.map(w => `⚠ ${w}`).join('\n'); warnBox.hidden = !warnings.length;
  const again = $('#regenWithKeys'); if (again) again.hidden = !keyframes.some(k => k.label);
  keyframeHint.textContent = [message ?? (keyframes.some(k => k.label)
    ? 'These keys shape the next clip. Click a step to preview its frame on the stage; to change its pose, move it with Handles and press Set from stage. Then press Generate again with these keys.'
    : keyframes.length
    ? 'Frames count across the whole clip. Pinned poses keep their place on the ground.'
    : 'Select an animation, scrub to a pose, and pin it: the next generation passes through it.')].join('\n');
}
// Hips yaw (radians) from a parent-local XYZW quaternion: where +Z ends up.
export function headingOf(q) {
  const [x, y, z, w] = q;
  const fx = 2 * (x * z + w * y), fz = 1 - 2 * (x * x + y * y);
  return Math.atan2(fx, fz);
}
const splitRotations = flat => { const out = []; for (let i = 0; i < flat.length; i += 4) out.push(flat.slice(i, i + 4)); return out; };
function poseOnScreen() {
  const pose = currentPose();
  if (!pose) { renderKeyframes('Select a ready animation first.'); return null; }
  if (skeletonOf(pose.model)?.skeleton_key !== skeletonOf(modelSelect.value)?.skeleton_key) { renderKeyframes('That pose is from a different skeleton than the selected motion model.'); return null; }
  return pose;
}
// A full-body keyframe. At frame 0 the pose is re-centred on the origin (Kimodo
// starts every clip there) and its heading becomes the clip's first heading.
function keyframeFrom(root, rotations, frame) {
  const k = { type: 'fullbody', frame_indices: [frame], root_positions: [[...root]], local_joints_rot_xyzw: [rotations.map(q => [...q])], heading: headingOf(rotations[0]) };
  if (frame === 0) { k.root_positions[0][0] = 0; k.root_positions[0][2] = 0; }
  return k;
}
$('#pinPose').onclick = () => {
  const pose = poseOnScreen(); if (!pose) return;
  // a key already at this frame is replaced: pose the stage on a planned step and Pin it to change that step
  const before = keyframes.length;
  keyframes = keyframes.filter(k => k.keep || k.type !== 'fullbody' || (k.frame_indices || []).length !== 1 || k.frame_indices[0] !== pose.frame);
  keyframes.push(keyframeFrom(pose.root, splitRotations(pose.rotations), pose.frame));
  keyframes.sort((a, b) => (a.frame_indices?.[0] ?? 0) - (b.frame_indices?.[0] ?? 0));
  renderKeyframes(before > keyframes.length - 1 ? `The key at frame ${pose.frame + 1} was replaced by the pose on the stage.` : undefined);
};

// --- pose library ---
export async function loadPoses() {
  poses = await fetch('/api/poses').then(r => r.json());
  const current = poseSelect.value;
  poseSelect.replaceChildren(...[{ id: '', name: poses.length ? 'Pick…' : 'None yet' }, ...poses].map(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; return o; }));
  if ([...poseSelect.options].some(o => o.value === current)) poseSelect.value = current;
  renderPoseGrid();
}
// The pose picker: every saved pose for this skeleton as a small figure (three-quarter view, fitted to its card).
// Click picks it (the dropdown follows, so Insert / ⋯ / + Sequence act on it); + adds it to the sequence at once.
function poseFigure(canvas, pose, skel) {
  const { parents, offsets } = skel, J = parents.length, P = [], G = [];
  const mul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
  const rot = (q, v) => { const [x, y, z, w] = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2]; return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x]; };
  for (let j = 0; j < J; j++) { const q = pose.rotations[j], p = parents[j]; if (p < 0) { G[j] = q; P[j] = [0, pose.root[1], 0]; } else { G[j] = mul(G[p], q); const o = rot(G[p], offsets[j]); P[j] = [P[p][0] + o[0], P[p][1] + o[1], P[p][2] + o[2]]; } }
  // face the viewer three-quarter: the body's own heading, then 30° round
  const f = rot(G[0], [0, 0, 1]), yaw = Math.atan2(f[0], f[2]) - Math.PI / 6, c = Math.cos(-yaw), sn = Math.sin(-yaw);
  const pts = P.map(p => [p[0] * c + p[2] * sn, p[1]]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), w = canvas.width, h = canvas.height;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.6), k = (h - 12) / span, cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const sx = x => w / 2 - (x - cx) * k, sy = y => h / 2 - (y - cy) * k;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.moveTo(6, sy(Math.min(...ys)) + 1); ctx.lineTo(w - 6, sy(Math.min(...ys)) + 1); ctx.stroke();
  ctx.lineCap = 'round'; ctx.lineWidth = 2.2;
  const names = skel.joint_names || [];
  for (let j = 1; j < J; j++) { const n = names[j] || ''; ctx.strokeStyle = n.startsWith('Left') ? '#7fb8ff' : n.startsWith('Right') ? '#ffb27f' : '#f2f2f2'; ctx.beginPath(); ctx.moveTo(sx(pts[j][0]), sy(pts[j][1])); ctx.lineTo(sx(pts[parents[j]][0]), sy(pts[parents[j]][1])); ctx.stroke(); }
  const hd = names.indexOf('Head'); if (hd >= 0) { ctx.fillStyle = '#f2f2f2'; ctx.beginPath(); ctx.arc(sx(pts[hd][0]), sy(pts[hd][1]), Math.min(5, Math.max(3, 0.07 * k)), 0, Math.PI * 2); ctx.fill(); }
}
function renderPoseActions() {
  const box = $('#poseActions'); if (!box) return;
  const p = poses.find(p => p.id === poseSelect.value);
  box.hidden = false;
  box.classList.toggle('empty', !p);
  $('#poseActionsName').textContent = p ? p.name.replace(/^Starter · /, '') : 'Click a pose above to use it (or press + on a pose to add it below)';
  const how = box.querySelector('.pose-actions-how'), row = box.querySelector('.row-gap');
  if (how) how.hidden = !p;
  if (row) row.hidden = !p;
  for (const id of ['#addToSequence', '#insertPose', '#poseMenu']) { const el = $(id); if (el) el.disabled = !p; }
}
// the Guide card's own pose picker (a first-time user was sent "above" to another tab for a saved pose)
const RANK = ['standing', 'seated', 'kneeling', 'crouch', 'lean on', 'lean low', 'push', 'brace'];
const rank = p => { const n = p.name.toLowerCase(); const i = RANK.findIndex(k => n.includes(k)); return i < 0 ? RANK.length : i; };
const orderedPoses = list => [...list].sort((a, b) => (b.name.startsWith('Starter') - a.name.startsWith('Starter')) || (a.name.startsWith('Starter') ? rank(a) - rank(b) : String(b.created_at).localeCompare(String(a.created_at))));
function renderGuidePick() {
  const sel = $('#guidePose'); if (!sel) return;
  const list = orderedPoses(savedPoses()), keep = sel.value;
  sel.replaceChildren(...(list.length ? list.map(p => Object.assign(document.createElement('option'), { value: p.id, textContent: p.name.replace(/^Starter · /, '') })) : [Object.assign(document.createElement('option'), { value: '', textContent: 'none saved yet' })]));
  if (list.some(p => p.id === keep)) sel.value = keep;
  // the picked pose as a small figure beside the list (a name alone said little: "seated on a box (hips 40.." )
  let fig = $('#guidePoseFig');
  if (!fig) { fig = Object.assign(document.createElement('canvas'), { id: 'guidePoseFig', width: 34, height: 44, className: 'key-fig' }); sel.closest('label')?.after(fig); sel.addEventListener('change', drawGuideFig); }
  drawGuideFig();
}
function drawGuideFig() {
  const fig = $('#guidePoseFig'), sel = $('#guidePose'); if (!fig || !sel) return;
  const pose = savedPoses().find(p => p.id === sel.value), skel = skeletonOf(modelSelect.value);
  fig.hidden = !pose; if (!pose || !skel?.parents) return;
  try { poseFigure(fig, pose, skel); } catch { fig.hidden = true; }
}
function renderPoseGrid() {
  renderPoseActions(); renderGuidePick();
  const grid = $('#poseGrid'); if (!grid) return;
  const skel = skeletonOf(modelSelect.value), list = savedPoses();
  grid.replaceChildren(); grid.hidden = !list.length || !skel?.parents;
  if (grid.hidden) return;
  // starters first, then the rest newest first
  // starters first, the everyday ones before the special ones (standing and sitting were below the fold: a first-time
  // user looked for them and found "brace against a wall"), then the rest newest first
  const order = orderedPoses(list);
  for (const p of order) {
    const card = document.createElement('div'); card.className = 'pose-card' + (poseSelect.value === p.id ? ' on' : ''); card.title = p.name; card.dataset.id = p.id;
    const cv = document.createElement('canvas'); cv.width = 76; cv.height = 96; try { poseFigure(cv, p, skel); } catch {}
    const label = document.createElement('span'); label.textContent = p.name.replace(/^Starter · /, '');
    const add = document.createElement('button'); add.type = 'button'; add.className = 'pose-add'; add.textContent = '+'; add.title = 'Add this pose to the sequence';
    add.onclick = e => { e.stopPropagation(); poseSelect.value = p.id; $('#addToSequence').click(); renderPoseGrid(); };
    card.onclick = () => { poseSelect.value = p.id; poseSelect.dispatchEvent(new Event('change')); renderPoseGrid(); };
    card.append(cv, label, add); grid.append(card);
  }
}
poseSelect.addEventListener('change', () => renderPoseGrid());
// Pose sequence: saved poses in order → /api/animations/sequence (MotionBricks through the poses, Clean up after).
// Each pose after the first is reached from wherever the body is (turned to its heading); a ballistic move wants the
// take-off pose and the apex pose with nothing between (the model supplies the flight).
let sequence = [];
function renderSequence() {
  const row = $('#sequenceRow'); row.hidden = sequence.length === 0;
  const how = $('#sequenceHow'); if (how) how.hidden = sequence.length >= 2;
  const list = $('#sequenceList'); list.textContent = '';
  const boxes = (stage.animation?.props || []).length > 0;
  sequence.forEach((p, i) => {
    const item = document.createElement('li'); item.className = 'seq-item';
    const name = document.createElement('span'); name.className = 'seq-name'; name.textContent = p.name.replace(/^Starter · /, '');
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon'; remove.textContent = '×'; remove.title = 'Take this pose out';
    remove.onclick = () => { sequence.splice(i, 1); renderSequence(); };
    const opts = document.createElement('div'); opts.className = 'seq-opts';
    if (boxes) {
      // with a box on the stage each pose can be put onto it (sit, hands, stand, push); left as is it's slid off a box
      const sel = document.createElement('select'); sel.title = 'Where this pose goes relative to the box on the stage';
      for (const [v, t] of [['', 'not on the box'], ['sit', 'sit on the box'], ['hands', 'hands on the box'], ['stand', 'stand on the box'], ['push', 'push against the box']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); }
      sel.value = p.onto || ''; sel.onchange = () => { p.onto = sel.value; };
      opts.append(sel);
    }
    // stay in the pose for a while (a seat held, a lean held), and turn it relative to the body's heading
    const num = (key, label, title, step, unit) => {
      const lab = document.createElement('label'); lab.className = 'inline'; lab.title = title;
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = step; inp.className = 'tiny'; inp.value = p[key] ?? ''; inp.placeholder = '0';
      inp.onchange = () => { p[key] = inp.value === '' ? undefined : +inp.value; };
      lab.append(label + ' ', inp, ' ' + unit); return lab;
    };
    opts.append(num('hold', 'hold', 'Seconds to stay in this pose once reached', '0.5', 's'), num('turn', 'turn', 'Turn this pose about the vertical, degrees, relative to the way the body faces when it gets there', '15', '°'));
    item.append(name, remove, opts); list.append(item);
  });
  const make = $('#generateSequence'); make.disabled = sequence.length < 2; make.title = sequence.length < 2 ? 'Add at least two poses' : 'Make a clip that moves through these poses, in this order';
}
$('#addToSequence').onclick = async () => {
  const library = await import('./library.js');
  const p = poses.find(p => p.id === poseSelect.value);
  if (!p) { library.setStatus('Pick a saved pose first.', 'error'); return; }
  sequence.push({ id: p.id, name: p.name }); renderSequence();
};
$('#clearSequence').onclick = () => { sequence = []; renderSequence(); };
$('#generateSequence').onclick = async () => {
  const library = await import('./library.js');
  if (sequence.length < 2) { library.setStatus('Add at least two poses to animate between.', 'error'); return; }
  const name = await ask('Name the animation', `It moves through ${sequence.length} poses: ${sequence.map(p => p.name.replace(/^Starter · /, '')).join(' → ')}`, sequence.map(p => p.name.replace(/^Starter · /, '')).join(' → '));
  if (name === null) return;
  library.setStatus('Making the animation through your poses, then cleaning it up…', 'readout progress');
  // the boxes on the stage's current clip go with the sequence: a pose over a box top sits or stands on it
  const body = { name, project: library.currentProject() || '', model: modelSelect.value, prompt: name, poses: sequence.map(p => ({ id: p.id, onto: p.onto || undefined, hold: p.hold || undefined, turn: p.turn || undefined })), props: stage.animation?.props || [] };
  const r = await fetch('/api/animations/sequence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { library.setStatus(await r.text(), 'error'); return; }
  const a = await r.json(); await library.refresh();
  const viewer = await import('./viewer.js'); await viewer.load(library.find(a.id) || a, skeletonOf(a.model), { frame: 0 });
  library.setStatus(`Animation made: ${(a.frames / 30).toFixed(1)} s through ${sequence.length} poses. It’s on the stage.${(a.metrics?.flags || []).length ? ' Checks: ' + a.metrics.flags.join(', ') + '.' : ''}`);
};

$('#savePose').onclick = async () => {
  const pose = poseOnScreen(); if (!pose) return;
  const name = await ask('Save pose', `Frame ${pose.frame + 1} of the clip on screen. Name it for what it is, e.g. "aimed cast".`);
  if (!name) return;
  const rotations = splitRotations(pose.rotations);
  const body = { name, skeleton_key: skeletonOf(pose.model).skeleton_key, root: pose.root, rotations, heading: headingOf(rotations[0]), source: { animation: stage.animation?.id, frame: pose.frame } };
  const r = await fetch('/api/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) { $('#poseNote').textContent = await r.text(); return; }
  const saved = await r.json(); await loadPoses(); poseSelect.value = saved.id; renderPoseGrid();
  $('#poseNote').textContent = `Saved “${saved.name}”. It’s picked: add it to a pose animation, or use it in the next clip.`;
};
function insertPoseAt(p, frameValue) {
  if (!p) { $('#poseNote').textContent = 'Click a saved pose first.'; return false; }
  if (p.skeleton_key !== skeletonOf(modelSelect.value)?.skeleton_key) { $('#poseNote').textContent = 'That pose is for a different skeleton than the selected motion model.'; return false; }
  const frame = Math.max(0, Math.floor(Number(frameValue)) || 0);
  keyframes.push(keyframeFrom(p.root, p.rotations, frame));
  renderKeyframes(`The next clip will pass through “${p.name}” at frame ${frame}.`);
  $('#poseNote').textContent = `The next clip will pass through “${p.name}” at frame ${frame} (see Guide the next clip).`;
  return true;
}
$('#insertPose').onclick = () => insertPoseAt(poses.find(p => p.id === poseSelect.value), poseFrame.value);
$('#guideAdd')?.addEventListener('click', () => {
  const sel = $('#guidePose'); if (!sel?.value) { renderKeyframes('Save a pose first (From poses › Save this pose).'); return; }
  insertPoseAt(poses.find(p => p.id === sel.value), $('#guideFrame')?.value || '0');
});
$('#poseMenu').onclick = async () => {
  const p = poses.find(p => p.id === poseSelect.value);
  if (!p) { renderKeyframes('Pick a saved pose first.'); return; }
  const action = await choose('Saved pose', p.name, [{ value: 'rename', label: 'Rename' }, { value: 'delete', label: 'Delete pose' }], 'rename');
  if (action === 'rename') {
    const name = await ask('Rename pose', '', p.name);
    if (name) { await fetch(`/api/poses/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); await loadPoses(); }
  } else if (action === 'delete' && await confirm('Delete pose', `Delete “${p.name}” from the pose library?`, 'Delete', true)) {
    await fetch(`/api/poses/${p.id}`, { method: 'DELETE' }); await loadPoses();
  }
};

// --- from the clip on screen ---
// Keep the prompt area as is; start the next clip in this clip's final pose.
$('#continueFrom').onclick = () => {
  const a = stage.animation, root = stage.root, rotations = stage.rotations;
  if (!a || !root) { renderKeyframes('Select a ready animation first.'); return; }
  if (skeletonOf(a.model)?.skeleton_key !== skeletonOf(modelSelect.value)?.skeleton_key) { renderKeyframes('That clip is on a different skeleton than the selected motion model.'); return; }
  const last = a.frames - 1, joints = rotations.length / (a.frames * 4);
  keyframes = [keyframeFrom([...root.slice(last * 3, last * 3 + 3)], splitRotations([...rotations.slice(last * joints * 4, (last + 1) * joints * 4)]), 0)];
  for (const row of [...segments.children]) if (!row.hasAttribute('data-primary')) row.remove();
  prompt.value = ''; seedInput.value = randomSeed(); updateCount();
  renderKeyframes(`Starts in the last pose of “${a.name || a.prompt.slice(0, 40)}”. Describe what happens next.`);
  prompt.focus();
};
// Loopable: the first pose pinned at the end too, carried along the clip's net travel.
$('#makeLoop').onclick = () => {
  const a = stage.animation, root = stage.root, rotations = stage.rotations;
  if (!a || !root) { renderKeyframes('Select a ready animation first.'); return; }
  restore(a);
  const last = a.frames - 1, joints = rotations.length / (a.frames * 4);
  const first = splitRotations([...rotations.slice(0, joints * 4)]);
  const start = keyframeFrom([...root.slice(0, 3)], first, 0);
  const endRoot = [root[0] + (root[last * 3] - root[0]), root[1], root[2] + (root[last * 3 + 2] - root[2])];
  const end = keyframeFrom(endRoot, first, last);
  end.root_positions[0][0] -= root[0]; end.root_positions[0][2] -= root[2]; // same re-centring as frame 0
  keyframes = [start, end];
  seedInput.value = randomSeed();
  renderKeyframes('First pose pinned at both ends (the end carried along the clip\'s travel). Generate takes; the cleanest should loop.');
};
// Same prompt and settings, first and last poses pinned, new seeds: variations that fit the same slot.
$('#moreLikeThis').onclick = () => {
  const a = stage.animation, root = stage.root, rotations = stage.rotations;
  if (!a || !root) { renderKeyframes('Select a ready animation first.'); return; }
  restore(a);
  const last = a.frames - 1, joints = rotations.length / (a.frames * 4);
  const at = f => keyframeFrom([...root.slice(f * 3, f * 3 + 3)], splitRotations([...rotations.slice(f * joints * 4, (f + 1) * joints * 4)]), f);
  keyframes = [at(0), at(last)];
  seedInput.value = randomSeed();
  renderKeyframes('First and last poses pinned. Generate takes for variations that fit the same slot.');
};
segments.addEventListener('change', () => renderKeyframes()); // a shorter clip can leave a keep past its end
reuse.onclick = () => { const all = structuredClone(selectedConstraints), kept = dedupeKeyframes(all); keyframes = kept;
  // the keys keep the frames they were generated at (the clip may have been trimmed since): the next clip is long enough for them
  const last = Math.max(-1, ...kept.flatMap(k => k.frame_indices || [])), fr = segments.querySelector('[data-primary] .segment-frames');
  if (fr && last + 1 > Number(fr.value)) fr.value = clampFrames(last + 1);
  renderKeyframes(all.length > kept.length ? `${all.length - kept.length} duplicate constraint${all.length - kept.length === 1 ? '' : 's'} dropped (the clip carried the same keep twice).` : undefined); };
export function addKeyframe(constraint) {
  const twin = keyframes.findIndex(k => sameKey(k, constraint));
  if (twin >= 0) { keyframes[twin] = constraint; renderKeyframes(`Already pinned: ${describe(constraint)} was replaced, not added twice.`); return; }
  keyframes.push(constraint); renderKeyframes();
}

// --- restore / request ---
export function restore(a) {
  if (a.seed != null) seedInput.value = clampSeed(a.seed);
  cfgInput.value = clampCFG(a.text_cfg ?? defaultCFG);
  if (a.diffusion_steps) stepsInput.value = clampSteps(a.diffusion_steps);
  selectedConstraints = Array.isArray(a.constraints) ? a.constraints : [];
  if (selectedConstraints.length) constraintCFGInput.value = clampCFG(a.constraint_cfg ?? defaultCFG);
  renderKeyframes();
  if (a.model && [...modelSelect.options].some(o => o.value === a.model)) { modelSelect.value = a.model; updateModel(); renderPoseGrid(); }
  if (typeof a.post_processing === 'boolean') postInput.checked = a.post_processing;
  if (a.text_quantization && [...quantSelect.options].some(o => o.value === a.text_quantization && !o.disabled)) { quantSelect.value = a.text_quantization; updateQuantization(); }
  const restored = Array.isArray(a.segments) && a.segments.length ? a.segments : [{ prompt: a.prompt, frames: a.frames }];
  prompt.value = restored[0].prompt || '';
  segments.querySelector('[data-primary] .segment-frames').value = clampFrames(restored[0].frames);
  for (const row of [...segments.children]) if (!row.hasAttribute('data-primary')) row.remove();
  for (const s of restored.slice(1)) segments.append(segmentRow(s.prompt || '', s.frames));
  updateCount();
}

export function request(project = '', folder = '') {
  const body = {
    project, folder,
    model: modelSelect.value, text_quantization: quantSelect.value, transition_frames: 5,
    steps: clampSteps(stepsInput.value), seed: clampSeed(seedInput.value), text_cfg: clampCFG(cfgInput.value),
    post_processing: postInput.checked, clean_wrists: $('#cleanWristsGen').checked, clean_hands: $('#cleanHandsGen')?.checked ?? true, ground_hands: $('#groundHandsGen')?.checked ?? true, ground_feet: $('#groundFeetGen')?.checked ?? true, smooth_jitter: $('#smoothJitterGen')?.checked ?? false, clean_up: $('#cleanUpGen')?.checked ?? true, finish_settled: $('#finishSettledGen')?.checked ?? true, start_standing: $('#startStandingGen')?.checked ?? true, action_retries: ($('#retryActionGen')?.checked ?? true) ? 3 : 0,
    segments: [...segments.querySelectorAll('.segment')].map(row => {
      const frames = Number(row.querySelector('.segment-frames').value);
      if (!validFrames(frames)) throw new Error(`Each segment must be a whole number from ${minFrames} to ${maxFrames} frames.`);
      return { prompt: row.querySelector('.segment-prompt').value.trim(), frames };
    }),
  };
  seedInput.value = body.seed; cfgInput.value = body.text_cfg; stepsInput.value = body.steps;
  const actor = Number(actorSelect.value) || 0;
  if (actor) {
    body.actor = actor; body.actor_prompt = body.segments.map(s => s.prompt).join(' | ');
    body.segments = body.segments.map(s => ({ ...s, prompt: rewriteActors(s.prompt, actor) }));
  }
  body.prompt = body.segments[0].prompt;
  if (body.segments.some(s => !s.prompt)) throw new Error('Every segment needs a prompt.');
  const all = dedupeKeyframes(pathConstraint ? [pathConstraint, ...keyframes] : keyframes);
  if (all.length) {
    body.constraints = all.map(({ heading, keep, ...k }) => k);
    body.constraint_cfg = clampCFG(constraintCFGInput.value); constraintCFGInput.value = body.constraint_cfg;
    const start = all.find(k => k.frame_indices?.[0] === 0 && typeof k.heading === 'number');
    if (start) body.first_heading = start.heading;
    else if (typeof firstHeading === 'number') body.first_heading = firstHeading;
    // Lineage: which clips this one keeps frames from, so iterations form a tree.
    const keeps = keyframes.filter(k => k.keep).map(k => ({ from: k.keep.from, frames: [k.frame_indices[0], k.frame_indices[k.frame_indices.length - 1]], part: k.keep.part }));
    if (keeps.length || lineageExtra) body.lineage = { parent: keeps[0]?.from, keeps, ...(lineageExtra || {}) };
  }
  return body;
}

$('#regenWithKeys')?.addEventListener('click', () => (window.generateNow || (() => $('#generate').click()))());
