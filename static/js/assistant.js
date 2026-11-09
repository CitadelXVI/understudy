// The assistant: every check that flagged on the clip on the stage, with the fix
// that applies, as one row under the stage. Nothing runs by itself.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as keep from './keep.js';

const $ = s => document.querySelector(s);
const bar = $('#assistant');
let lastKey = '';
// Clean up: physics + anti-clipping on the server (MuJoCo body with self-collision and a floor, then smoothing of
// what still shakes and an eased push-out of what still overlaps). In place, undoable.
export async function cleanUp() {
  const a = viewer.state.animation; if (!a) return;
  const frame = viewer.state.frame, before = a.metrics || {};
  library.setStatus('Cleaning up: physics, shakes and clipping…', 'readout progress');
  const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'cleanup', in_place: true }) });
  if (!r.ok) { library.setStatus(await r.text(), 'error'); return; }
  const u = await r.json(); await library.refresh();
  const compose = await import('./compose.js'); await viewer.load(library.find(u.id) || u, compose.skeletonOf(u.model), { frame });
  const m = u.metrics || {}, left = (m.flags || []).filter(f => ['clip', 'jitter', 'hand_head', 'floor', 'float', 'foot_hover', 'balance', 'anatomy'].includes(f));
  if (u.warnings?.length) { library.setStatus(u.warnings[0], 'error'); return; }
  // A take that misses its move is not Clean up's to fix, and a result with the same flags and no real change in the
  // numbers is not a clean-up: say so, and say what will help, instead of "Cleaned up" (the owner clicked five times
  // on a tumble Kimodo offered for "falls over" and saw no change).
  const flags = m.flags || [];
  if (flags.includes('action')) { library.setStatus(`This take misses the move (${(m.action_notes || []).join('; ')}). Clean up fixes contact, shakes and clipping, not the motion: use Try 4 takes for a take that does it.`, 'error'); return; }
  const sameFlags = JSON.stringify((before.flags || []).filter(f => f !== 'action')) === JSON.stringify(flags);
  const improved = (before.jitter_peak || 0) - (m.jitter_peak || 0) >= 3 || (before.self_clip || 0) - (m.self_clip || 0) >= 0.03;
  if (sameFlags && !improved && left.length) {
    const why = left.map(f => FIX[f] ? FIX[f].text(m) : f).join('; ');
    library.setStatus(`Clean up has nothing more to fix here. What is left (${why}) is in the generated motion itself, not in its contact or smoothing: use Try 4 takes or Regenerate for a better take.`, 'error');
    return;
  }
  library.setStatus(`Cleaned up: shake ${Math.round(before.jitter_peak || 0)} → ${Math.round(m.jitter_peak || 0)} cm, self-clip ${Math.round((before.self_clip || 0) * 100)} % → ${Math.round((m.self_clip || 0) * 100)} %, floor contact ${(before.flags || []).filter(f => ['floor', 'float', 'foot_hover', 'balance'].includes(f)).length} → ${(m.flags || []).filter(f => ['floor', 'float', 'foot_hover', 'balance'].includes(f)).length} issues${left.length ? ` (still flagged: ${left.join(', ')})` : ''}. Undo in the Handles bar.`);
}
// MotionBricks edits (motion generated between the clip's own frames; Clean up runs after): a range regenerated
// from the frames around it, the end settled into a standing pose, the end bridged back to the start (a loop).
async function brick(op, extra, busy, done) {
  const a = viewer.state.animation; if (!a) return;
  const frame = viewer.state.frame;
  library.setStatus(busy, 'readout progress');
  const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, in_place: true, ...extra }) });
  // 422: the best-of regenerate found nothing better and left the clip alone; that is an answer, not a failure
  if (!r.ok) { library.setStatus(await r.text(), r.status === 422 ? 'readout' : 'error'); return; }
  const u = await r.json(); await library.refresh();
  const compose = await import('./compose.js'); await viewer.load(library.find(u.id) || u, compose.skeletonOf(u.model), { frame: Math.min(frame, u.frames - 1) });
  library.setStatus(u.warnings?.length ? u.warnings[0] : (u.edit_note ? `${u.edit_note} Undo puts it back.` : done(a, u)), u.warnings?.length ? 'error' : undefined);
}
async function regenRange(from, to) {
  const a = viewer.state.animation; if (!a) return;
  // MotionBricks needs 4 frames before the range and 1 after it (from frame 1 it answered with an error)
  from = Math.max(4, (from ?? 0) - 6); to = Math.max(from + 1, Math.min(a.frames - 2, (to ?? 0) + 6));
  await brick('mb_regen', { from, to }, `Regenerating frames ${from + 1}–${to + 1} from the frames around them…`, (was, u) => `Frames ${from + 1}–${to + 1} regenerated (${was.frames} → ${u.frames} frames). Undo in the Handles bar.`);
}
async function regenerateFrames() {
  const a = viewer.state.animation; if (!a) return;
  const keep = await import('./keep.js'); const b = keep.bounds();
  let from, to;
  if (b) { [from, to] = b; } else { from = Math.max(4, viewer.state.frame - 9); to = Math.min(a.frames - 2, viewer.state.frame + 9); }
  if (from < 4 || to >= a.frames - 1 || to < from) { library.setStatus('Regenerate needs 4 frames before the range and 1 after it: choose a range inside the clip (Range → Set start and Set end).', 'error'); return; }
  await brick('mb_regen', { from, to }, `Regenerating frames ${from + 1}–${to + 1} from the frames around them…`, (was, u) => `Frames ${from + 1}–${to + 1} regenerated (${was.frames} → ${u.frames} frames). Undo in the Handles bar.`);
}
// + Box: a 0.5 × 0.45 × 0.5 m box 0.7 m ahead of the hips at the current frame, facing the body; saved on the clip
// (PATCH props) so the checks, Clean up and sequences all see it. Size/height edits: the clip's JSON for now.
document.querySelector('#addBox')?.addEventListener('click', async () => {
  const a = viewer.state.animation; if (!a) return;
  const pose = viewer.pose(); const names = viewer.skeleton.names; const G = viewer.globalRotations();
  const hips = pose[0]; const fwd = viewer.rotate(G[0], [0, 0, 1]); const fl = Math.hypot(fwd[0], fwd[2]) || 1;
  const fx = fwd[0] / fl, fz = fwd[2] / fl; const n = (a.props || []).length + 1;
  const box = { kind: 'box', name: `box ${n}`, pos: [hips[0] + fx * .7, viewer.state.floorY || 0, hips[2] + fz * .7], size: [.5, .45, .5], yaw: Math.atan2(fx, fz) };
  const r = await fetch(`/api/animations/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ props: [...(a.props || []), box] }) });
  if (!r.ok) { library.setStatus(await r.text(), 'error'); return; }
  const u = await r.json(); a.props = u.props; a.metrics = u.metrics; await library.refresh(); (await import('./props.js')).select(u.props.length - 1);
  library.setStatus(`Box ${n} placed 0.7 m ahead (0.5 × 0.45 × 0.5 m). Drag it on the stage to move it; the Box bar sets its size, Delete removes it. The checks treat its top as floor.`);
});
export const BRICKS = [
  { label: 'Regenerate frames', hint: 'Replace the kept range (Range → Set start and Set end), or ±9 frames around the current frame, with motion generated from the frames before and after it (MotionBricks), then Clean up. Undoable', run: regenerateFrames },
  { label: 'Settle', hint: 'Bridge the last frames into a standing pose (the clip’s own first frame, where the body is) so the clip comes to rest (MotionBricks), then Clean up. Undoable', run: () => brick('mb_settle', {}, 'Settling the end into a standing pose…', (was, u) => `Settled: ${u.frames - was.frames} frames added, the clip now ends standing. Undo in the Handles bar.`) },
  { label: 'Make loop', hint: 'Bridge the last frames back to the first frames so the clip loops (MotionBricks; the root carries on forward), then Clean up. Undoable', run: () => brick('mb_loop', {}, 'Bridging the end back to the start…', (was, u) => `Loop made: ${u.frames - was.frames} frames added; the last frame leads into the first. Undo in the Handles bar.`) },
];
// One in-place edit on the server, then the clip reloaded where it was; the server says what the edit did.
async function edit(op, busy, done) {
  const a = viewer.state.animation; if (!a) return;
  const frame = viewer.state.frame;
  library.setStatus(busy, 'readout progress');
  const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, in_place: true }) });
  if (!r.ok) { library.setStatus(await r.text(), 'error'); return; }
  const u = await r.json(); await library.refresh();
  const compose = await import('./compose.js'); await viewer.load(library.find(u.id) || u, compose.skeletonOf(u.model), { frame });
  library.setStatus(u.warnings?.length ? u.warnings[0] : typeof done === 'function' ? done(a.metrics || {}, u.metrics || {}) : done, u.warnings?.length ? 'error' : undefined);
}
async function finishIt() {
  const a = viewer.state.animation; if (!a || !viewer.state.root) return;
  const compose = await import('./compose.js');
  compose.restore(a);            // prompt, seed and settings of the clip
  const step = Math.max(3, Math.ceil(a.frames / 19));
  compose.replaceKeyframes([keep.buildKeep(a, viewer.state.root, viewer.state.rotations, 0, a.frames - 1, 'body', step)]);
  if ($('#finishSettledGen')) $('#finishSettledGen').checked = true;
  library.setStatus('Finishing the move: every frame kept, then it comes to rest (same seed)…', 'readout progress');
  (window.generateNow || (() => $('#generate').click()))();
}
const JOINT = { Neck1: 'neck', Neck2: 'neck', Head: 'head', Spine1: 'spine', Spine2: 'spine', Chest: 'chest', LeftShin: 'left knee', RightShin: 'right knee', LeftForeArm: 'left elbow', RightForeArm: 'right elbow', LeftShoulder: 'left shoulder', RightShoulder: 'right shoulder', LeftFoot: 'left ankle', RightFoot: 'right ankle', LeftToeBase: 'left toes', RightToeBase: 'right toes' };
const PART = { LeftToeBase: 'left toes', RightToeBase: 'right toes', LeftFoot: 'left foot', RightFoot: 'right foot', LeftHand: 'left hand', RightHand: 'right hand', LeftShin: 'left knee', RightShin: 'right knee', LeftLeg: 'left thigh', RightLeg: 'right thigh', Hips: 'hips', Head: 'head', Chest: 'back', Spine1: 'back', Spine2: 'back', LeftForeArm: 'left forearm', RightForeArm: 'right forearm', LeftArm: 'left arm', RightArm: 'right arm' };
const CLEAN = { fix: 'Clean up', hint: 'Physics + anti-clipping + contact: a body with real collision follows the clip (no limb through the body), shakes are smoothed, overlaps pushed out, then the body touches the floor where it should (floats settle, still feet planted, nothing through the floor, weight over the feet). Baked, undoable', run: cleanUp };
const FIX = {
  // gait (gait.go): a foot gliding along the floor instead of stepping; the body turning on planted feet
  slide: { text: m => `${(m.slide_side || '').toLowerCase()} foot slides ${Math.round((m.slide_m || 0) * 100)} cm along the floor (frames ${(m.slide_from ?? 0) + 1}–${(m.slide_to ?? 0) + 1}${m.slide_count > 1 ? `, ${m.slide_count} slides in all` : ''})`,
    fix: m => (m.slide_m || 0) <= 0.08 ? 'Lock the sliding foot' : 'Plant the feet', hint: m => (m.slide_m || 0) <= 0.08 ? CLEAN.hint : 'Keeps the motion: a foot that glides while it is down is held where it landed, then takes a quick lifted step to where it was going (the hips dip a little if a straight leg needs it). Undoable. If it still slides, More fixes → Regenerate frames makes new motion for that stretch.',
    run: m => (m.slide_m || 0) <= 0.08 ? CLEAN.run() : brick('plant_feet', {}, 'Planting the feet: held where they land, then stepped…', () => 'Feet planted. Undo puts the slide back.') },
  pivot: { text: m => `turns ${Math.round(m.pivot_deg || 0)}° without stepping (frames ${(m.pivot_from ?? 0) + 1}–${(m.pivot_to ?? 0) + 1}): the body spins on planted feet`,
    fix: m => `Regenerate the turn (frames ${(m.pivot_from ?? 0) + 1}–${(m.pivot_to ?? 0) + 1})`, hint: 'New motion for the turn: several versions, some rebuilt as alternating steps, and the best kept (if none beats the clip, it is left as it is). A real turn steps round', run: m => regenRange(m.pivot_from, m.pivot_to) },
  skate: { text: m => `foot slide ${Math.round(m.foot_skate * 100)} %`, fix: 'Keep planted feet in next clip', hint: 'Pin every planted run for the next generation (Range → Keep planted feet in next clip, then Generate)', run: () => { keep.setActive(true); $('#plantFeet').click(); } },
  // Contact checks read the body's real surface (the stage mannequin's), not joints; Clean up fixes all of them.
  floor: { text: m => `${PART[m.floor_part] || 'body'} through the floor ${Math.round(-m.floor_m * 100)} cm${m.floor_part ? ` (frame ${(m.floor_frame ?? 0) + 1})` : ''}`, ...CLEAN },
  float: { text: m => `floats ${Math.round((m.float_gap_m || 0) * 100)} cm over the floor, nothing touching (frames ${(m.float_from ?? 0) + 1}–${(m.float_to ?? 0) + 1})`, ...CLEAN },
  foot_hover: { text: m => `${(m.foot_hover || '').toLowerCase()} foot hovers ${Math.round((m.foot_hover_m || 0) * 100)} cm while standing (frames ${(m.foot_hover_from ?? 0) + 1}–${(m.foot_hover_to ?? 0) + 1})`, ...CLEAN },
  balance: { text: m => `off balance: weight ${Math.round((m.balance_out_m || 0) * 100)} cm past the feet (frames ${(m.balance_from ?? 0) + 1}–${(m.balance_to ?? 0) + 1})`, ...CLEAN },
  jitter: { text: m => m.jitter_peak > 4 ? `jitter: ${(m.jitter_joint || 'a joint').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} jumps ${Math.round(m.jitter_peak)} cm at frame ${(m.jitter_frame ?? 0) + 1}` : 'jitter', ...CLEAN, oldRun: async () => { const a = viewer.state.animation; if (!a) return; const frame = viewer.state.frame; library.setStatus('Smoothing the jitter…', 'readout progress'); const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'smooth', in_place: true }) }); if (!r.ok) { library.setStatus(await r.text(), 'error'); return; } const u = await r.json(); await library.refresh(); const compose = await import('./compose.js'); await viewer.load(library.find(u.id) || u, compose.skeletonOf(u.model), { frame }); const was = a.metrics?.jitter_peak || 0, now = u.metrics?.jitter_peak || 0; library.setStatus(now >= was ? 'Could not smooth this shake without moving a planted foot or hand; regenerate that range instead.' : u.metrics?.flags?.includes('jitter') ? `Shake reduced (${Math.round(was)} → ${Math.round(now)}), still above the line; regenerating that range will do better. Undo in the Handles bar.` : 'Jitter smoothed. Undo in the Handles bar.'); } },
  hover: { text: m => `ends in the air (${Math.round((m.hover_m || 0) * 100)} cm)`, fix: 'Ground the feet', hint: 'Lower the body wherever a foot stands still above the floor, eased over the landing; baked, undoable', run: async () => { const a = viewer.state.animation; if (!a) return; const frame = viewer.state.frame; library.setStatus('Grounding the feet…', 'readout progress'); const r = await fetch(`/api/animations/${a.id}/derive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'floor', in_place: true }) }); if (!r.ok) { library.setStatus(await r.text(), 'error'); return; } const u = await r.json(); await library.refresh(); const compose = await import('./compose.js'); await viewer.load(library.find(u.id) || u, compose.skeletonOf(u.model), { frame }); library.setStatus('Feet grounded. Undo in the Handles bar.'); } },
  hand_head: { text: m => `hand in face on ${Math.round(m.hand_head * 100) || '<1'} % of frames`, fix: 'Fix hand-in-head', hint: 'Push each hand just outside the skull on every frame it sinks in (two-bone IK, eased over ±4 frames), baked, undoable', run: () => { $('#handles').classList.contains('on') || $('#handles').click(); setTimeout(() => $('#fixClipping').click(), 150); } },
  clip: { text: m => (m.clip_pairs?.some(p => / hand × head$/.test(p.pair)) ? 'hand in head' : 'self-clip') + ` ${Math.round(m.self_clip * 100)} %`, ...CLEAN },
  // Was "Tween 60 %" over the whole clip, which blended every joint toward the first and last frames and erased
  // most of a flip. The arc fix moves only the body's height while it is in the air; every limb keeps its motion.
  ballistic: { text: m => `floaty jump (${Math.round((m.ballistic_m || 0) * 100)} cm off gravity)`, fix: 'Fix the arc', hint: 'While the body is in the air, lift or lower it onto the gravity arc. Only the height moves; arms, legs and spin are untouched. Baked, undoable', run: () => edit('arc', 'Putting the jump on a gravity arc…', (b, m) => `Jump closer to gravity: ${Math.round((b.ballistic_m || 0) * 100)} → ${Math.round((m.ballistic_m || 0) * 100)} cm off; only the body height moved.${(m.flags || []).includes('ballistic') ? ' The rest is the landing (the body slows down before its feet touch): keep the take-off and landing and regenerate the flight to fix it fully.' : ''} Undo in the Handles bar.`) },
  // Incomplete: a move cut off mid-motion. Finish it = one new clip that keeps every frame and comes to rest (same
  // seed, a hidden "stops and stands still" segment after it, the idle past a short hold trimmed).
  action: { text: m => `misses the move: ${(m.action_notes || []).join('; ') || 'the prompt is not performed'}`, fix: 'Try 4 takes', hint: 'Generate 4 more takes of this prompt with new seeds; the best one (the move done, fewest flags) is shown', run: async () => { const a = viewer.state.animation; if (!a) return; const compose = await import('./compose.js'); compose.restore(a); compose.newSeed(); if ($('#takes')) $('#takes').value = 4; library.setStatus('Generating 4 takes; the one that does the move is shown…', 'readout progress'); (window.generateNow || (() => $('#generate').click()))(); } },
  unsettled_end: { text: m => `ends mid-motion (still moving ${(m.end_speed || 0).toFixed(2)} m/s): incomplete`, fix: 'Finish it', hint: 'Generate this clip again with every frame kept and a settle after it, so it comes to rest (same seed). Arrives as a new clip', run: finishIt },
  unsettled_start: { text: m => `starts mid-motion (${(m.start_speed || 0).toFixed(2)} m/s)`, fix: 'Regenerate', hint: 'A clip continued from another starts moving on purpose; otherwise regenerate with "Finish settled" on (Advanced)', run: () => $('#generate').click() },
  idle: { text: m => `${(((m.idle_head || 0) + (m.idle_tail || 0)) / 30).toFixed(1)} s of idle at the ${m.idle_head && m.idle_tail ? 'start and end' : m.idle_tail ? 'end' : 'start'}`, fix: 'Trim idle', hint: 'A copy without the standing still before and after the move (a short hold is kept at each end)', run: () => edit('trim_idle', 'Trimming the idle…', (b, m) => 'Idle trimmed: a new copy is on the stage.') },
  anatomy: { text: m => `${JOINT[m.anatomy_joint] || m.anatomy_joint || 'a joint'} bent ${Math.round(m.anatomy_deg || 0)}° past what a body can do (frame ${(m.anatomy_frame ?? 0) + 1})`, ...CLEAN },
};
// Each problem's button says what the fix does to it (owner's critic: five vague buttons for one sliding foot). The
// Clean up fixes share one run; only the words differ.
for (const [flag, label] of Object.entries({ floor: 'Put it back on the floor', float: 'Set it down on the floor', foot_hover: 'Plant the hovering foot', balance: 'Settle the balance', jitter: 'Smooth the shake', clip: 'Push the limb out of the body', anatomy: 'Straighten the bent joint' })) {
  if (FIX[flag] && FIX[flag].fix === 'Clean up') { FIX[flag].fix = label; FIX[flag].hint = 'Clean up does this: ' + (FIX[flag].hint || CLEAN.hint); }
}

// Frame spans (0-based, inclusive) named by active Checks on clip `a`, drawn as thin warning bands on the timeline ruler.
export function issueSpans(a) {
  const m = a?.metrics, n = a?.frames || 0;
  if (!m || !n) return [];
  const flags = (m.flags || []).filter(f => !(f === 'unsettled_start' && a?.starts_moving));
  const out = [], add = (from, to, flag) => {
    const f0 = Math.max(0, Math.min(n - 1, Math.floor(from))), f1 = Math.max(f0, Math.min(n - 1, Math.floor(to)));
    out.push({ from: f0, to: f1, flag, text: FIX[flag] ? FIX[flag].text(m) : flag });
  };
  for (const f of flags) {
    if (f === 'slide' && m.slide_from != null && m.slide_to != null) add(m.slide_from, m.slide_to, f);
    else if (f === 'pivot' && m.pivot_from != null && m.pivot_to != null) add(m.pivot_from, m.pivot_to, f);
    else if (f === 'float' && m.float_from != null && m.float_to != null) add(m.float_from, m.float_to, f);
    else if (f === 'foot_hover' && m.foot_hover_from != null && m.foot_hover_to != null) add(m.foot_hover_from, m.foot_hover_to, f);
    else if (f === 'balance' && m.balance_from != null && m.balance_to != null) add(m.balance_from, m.balance_to, f);
    else if (f === 'floor' && m.floor_part && m.floor_frame != null) add(m.floor_frame, m.floor_frame, f);
    else if (f === 'jitter' && m.jitter_peak > 4 && m.jitter_frame != null) add(m.jitter_frame, m.jitter_frame, f);
    else if (f === 'anatomy' && m.anatomy_frame != null) add(m.anatomy_frame, m.anatomy_frame, f);
    else if (f === 'idle') {
      if (m.idle_head > 0) add(0, m.idle_head - 1, f);
      if (m.idle_tail > 0) add(n - m.idle_tail, n - 1, f);
    }
  }
  return out;
}

export function render() {
  const a = library.selected && viewer.state.animation?.id === library.selected.id ? library.selected : viewer.state.animation;
  const m = a?.metrics; const flags = (m?.flags || []).filter(f => !(f === 'unsettled_start' && a?.starts_moving));   // a pre-rolled clip starts moving on purpose
  const kb = keep.bounds(), rf0 = kb ? kb[0] : Math.max(4, viewer.state.frame - 9), rf1 = kb ? kb[1] : Math.min((a?.frames || 2) - 2, viewer.state.frame + 9);
  const regenSpan = kb ? `frames ${kb[0] + 1}–${kb[1] + 1} (Range)` : (!viewer.state.playing && a && rf0 >= 4 && rf1 < a.frames - 1 && rf1 >= rf0 ? `frames ${rf0 + 1}–${rf1 + 1}` : '±9 frames around this frame');
  const key = `${a?.id}:${a?.edits || 0}:${a?.redos || 0}:${flags.join(',')}:${(a?.warnings || []).join('|')}:${!!a?.has_original}:${a?.verdict || ''}:${regenSpan}`; if (key === lastKey) return; lastKey = key;
  bar.hidden = !a || !m;
  if (bar.hidden) return;
  const label = Object.assign(document.createElement('span'), { className: 'label', textContent: 'Checks' });
  // the general fixes, each with one line saying what it does (five bare buttons under a problem read as a guessing game)
  const WHAT = { 'Clean up': 'floor, clipping, shake and small slides (under 8 cm), all at once', 'Regenerate frames': `redo ${regenSpan}, best of several tries`, 'Settle': 'bring the end of the clip to rest, standing', 'Make loop': 'make the end flow back into the start' };
  const fixRow = (b, what) => { const row = document.createElement('div'); row.className = 'fix-row'; const w = Object.assign(document.createElement('span'), { className: 'fix-what', textContent: what }); row.append(b, w); return row; };
  const cleanBtn = () => { const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.id = 'cleanUp'; b.textContent = CLEAN.fix; b.title = CLEAN.hint; b.onclick = CLEAN.run; return fixRow(b, WHAT['Clean up']); };
  const brickBtns = () => [Object.assign(document.createElement('div'), { className: 'fix-more', textContent: 'More fixes' }), ...BRICKS.map(x => { const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = x.label; b.title = x.hint; b.onclick = x.run; return fixRow(b, WHAT[x.label] || ''); })];
  // What the last edit did that may not be wanted, with Undo; and the original, which is always one click away.
  const guard = [];
  for (const w of a.warnings || []) {
    const el = Object.assign(document.createElement('span'), { className: 'issue warn' });
    const undo = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Undo' });
    undo.onclick = async () => (await import('./handles.js')).undoEdit();
    el.append(Object.assign(document.createElement('span'), { textContent: w }), undo); guard.push(el);
  }
  if (a.has_original && (a.edits || a.redos)) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Revert to original', title: 'Bring back the clip as it was before its first edit (undoable)' });
    b.onclick = () => edit('revert', 'Reverting to the original…', 'Back to the original clip. Undo brings your edits back.'); guard.push(b);
  }
  // every take missed the move: say so first, plainly (the clip is the best of them, not a finished animation)
  if (a.verdict) guard.push(Object.assign(document.createElement('span'), { className: 'issue warn', textContent: a.verdict + '. Try other words, or build it from poses.' }));
  // a take that missed its move was generated again: say which one was kept, and with what wording
  if (a.action_tries) guard.push(Object.assign(document.createElement('span'), { className: 'issue good note', textContent: `Note: this is try ${a.action_tries}; the first missed the move${a.retry_wording ? ` (asked as “${a.retry_wording}”)` : ''}` }));
  // a regenerate kept its best try; the next best ones are one click away (the choice stays the person's)
  const altRow = () => {
    const n = a.regen_alts || 0; if (!n) return [];
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Try another version' });
    b.title = 'The last Regenerate kept its best try; this swaps in the next one (undoable). Keep going until one looks right, or Undo back';
    b.onclick = () => brick('mb_regen_next', {}, 'Swapping in the next version…', () => 'Another version applied. Undo puts the last one back.');
    const row = fixRow(b, `not right? ${n} more version${n === 1 ? '' : 's'} of the stretch you just regenerated (Undo goes back)`); row.classList.add('fix-alt');
    return [row];
  };
  if (!flags.length) { bar.replaceChildren(label, ...guard, Object.assign(document.createElement('span'), { className: 'issue good', textContent: 'clean · complete, feet planted, on the floor, steady, no clipping' }), ...altRow(), cleanBtn(), ...brickBtns()); return; }
  // the hand-in-face row already covers a self-clip that is only hands in the head
  const shown = flags.filter(f => !(f === 'clip' && flags.includes('hand_head') && (m.clip_pairs || []).every(p => / hand × head$/.test(p.pair))));
  bar.replaceChildren(label, ...guard, ...altRow(), ...shown.map(f => {
    const spec = FIX[f]; const el = document.createElement('span'); el.className = 'issue';
    el.append(Object.assign(document.createElement('span'), { textContent: spec ? spec.text(m) : f }));
    if (spec) { const v = x => typeof x === 'function' ? x(m) : x; const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = v(spec.fix); b.title = v(spec.hint); b.onclick = () => spec.run.length ? spec.run(m) : spec.run(); el.append(b); }
    return el;
  }), ...(shown.some(f => FIX[f]?.run === cleanUp) ? [] : [cleanBtn()]), ...brickBtns());
}
setInterval(render, 1500);
viewer.onDraw?.(() => { if (!viewer.state.playing) render(); });
export function onClipChanged() { lastKey = ''; render(); }
