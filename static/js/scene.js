// Actors: a scene of several clips on one stage. Each actor owns a clip and a
// placement (x, z, facing, frame offset). The clip on the stage is drawn as
// usual; every other actor is drawn in its colour, placed relative to the
// stage actor, with its markers on the timeline so reactions can be lined up.
// Prompts may name actors ("Actor 1 dodges Actor 2"); the composer's "For"
// select says who the clip is for, and a finished generation for Actor N
// takes that actor's slot.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as compose from './compose.js';
import * as timeline from './timeline.js';
import { choose } from './dialogs.js';

const $ = s => document.querySelector(s);
const list = $('#actorList');
export const COLOURS = ['#ff5c5c', '#7fd0ff', '#8fe3a2', '#ffd27f', '#d79cff', '#ff9ccf', '#9ff0ff', '#ffb27f'];
let scene = { actors: [] };
let selectedActor = null;
let loadedFor = undefined;

const key = () => `understudy.scene.${library.currentProject() || 'inbox'}`;
let loadedText = '';
function load() {
  const pid = library.currentProject();
  const project = library.projects.find(p => p.id === pid);
  let s = project?.scene || null;
  if (!s) { try { s = JSON.parse(localStorage.getItem(key()) || 'null'); } catch { s = null; } }
  const text = JSON.stringify(s || null);
  // reload when the project changes or when the project's saved scene arrives/changes (the project list loads after this module)
  if (loadedFor === pid && text === loadedText) return;
  loadedFor = pid; loadedText = text;
  scene = s && Array.isArray(s.actors) ? s : { actors: [] };
  render();
}
async function save() {
  loadedText = JSON.stringify(scene);
  try { localStorage.setItem(key(), JSON.stringify(scene)); } catch {}
  const pid = library.currentProject();
  if (pid) { try { await fetch(`/api/projects/${pid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene }) }); } catch {} }
}

const clipOf = a => a.clip ? library.find(a.clip) : null;
const stageActor = () => scene.actors.find(a => a.clip && a.clip === viewer.state.animation?.id) || null;
const rot = (x, z, deg) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + z * s, -x * s + z * c]; };

// Push the other actors to the stage, placed in the stage actor's space.
function push() {
  const stage = stageActor(), S = stage || { x: 0, z: 0, yaw: 0, offset: 0 };
  const others = scene.actors.filter(a => a !== stage && !a.hidden && clipOf(a)?.status === 'ready');
  viewer.setExtras(others.map(a => {
    const clip = clipOf(a);
    const [dx, dz] = rot(a.x - S.x, a.z - S.z, -S.yaw);
    return { animation: clip, skeleton: compose.skeletonOf(clip.model), x: dx, z: dz, yaw: a.yaw - S.yaw, frameOffset: a.offset - S.offset, colour: a.colour, label: `Actor ${a.n}` };
  }));
  timeline.setExtraMarkers(() => others.flatMap(a => (clipOf(a)?.markers || []).map(m => ({ frame: m.frame + a.offset - S.offset, name: `${m.name} · A${a.n}`, colour: a.colour }))));
  compose.setActorOptions(scene.actors.map(a => a.n));
}

function render() {
  list.replaceChildren(...scene.actors.map(a => {
    const clip = clipOf(a);
    const row = document.createElement('div'); row.className = 'actor-row' + (a.n === selectedActor ? ' selected' : '');
    row.innerHTML = `<label class="actor-show" title="Show this actor on the stage"><input type="checkbox" ${a.hidden ? '' : 'checked'}></label><button type="button" class="actor-pick" title="Select this actor"><i class="swatch" style="background:${a.colour}"></i><b>Actor ${a.n}</b></button>
      <span class="actor-clip" title="${clip ? clip.prompt.replace(/"/g, '&quot;') : ''}">${clip ? library.titleOf(clip).slice(0, 34) : '<span class="hint">no clip yet — generate for this actor, or use the clip on stage</span>'}</span>
      <label title="Position across the stage, metres">x <input type="number" step="0.1" class="actor-x" value="${a.x}"></label>
      <label title="Position along the stage, metres">z <input type="number" step="0.1" class="actor-z" value="${a.z}"></label>
      <label title="Facing, degrees">yaw <input type="number" step="15" class="actor-yaw" value="${a.yaw}"></label>
      <label title="Frame offset: this actor's clip starts this many frames after the stage clip">+f <input type="number" step="1" class="actor-offset" value="${a.offset}"></label>
      ${clip ? '<button type="button" class="chip actor-stage" title="Put this actor\'s clip on the stage">Stage</button>' : ''}
      <button type="button" class="chip actor-remove" title="Remove this actor">×</button>`;
    row.querySelector('.actor-pick').onclick = () => { selectedActor = a.n; compose.selectActor(a.n); render(); };
    row.querySelector('.actor-show input').onchange = e => { a.hidden = !e.target.checked; save(); push(); if (a === stageActor()) { viewer.setBody(!a.hidden); } };
    if (scene.actors.some(o => o !== a && clipOf(o))) { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = 'React…'; b.title = 'Set this actor up to react to another actor at one of its markers'; b.onclick = () => openReact(a); row.querySelector('.actor-remove').before(b); }
    for (const [cls, prop] of [['.actor-x', 'x'], ['.actor-z', 'z'], ['.actor-yaw', 'yaw'], ['.actor-offset', 'offset']]) row.querySelector(cls).onchange = e => { a[prop] = Number(e.target.value) || 0; save(); push(); };
    row.querySelector('.actor-stage')?.addEventListener('click', () => library.select(clip));
    row.querySelector('.actor-remove').onclick = () => { scene.actors = scene.actors.filter(x => x !== a); if (selectedActor === a.n) selectedActor = null; save(); render(); };
    return row;
  }));
  const hasActors = scene.actors.length > 0, hasReadyClip = scene.actors.some(a => clipOf(a)?.status === 'ready'); const setOff = (sel, off, why) => { const b = $(sel); if (!b) return; if (b.dataset.baseTitle === undefined) b.dataset.baseTitle = b.title || ''; b.disabled = !!off; b.title = off ? why : b.dataset.baseTitle; }; setOff('#actorUseStage', !hasActors || !viewer.state.animation, !hasActors ? 'Add an actor first (+ Actor)' : 'Put a clip on the stage first'); setOff('#actorContact', !hasActors, 'Add an actor first (+ Actor)'); setOff('#sceneExport', !hasActors, 'Add an actor first (+ Actor)'); setOff('#sceneUnreal', !hasActors || !hasReadyClip, !hasActors ? 'Add an actor first (+ Actor)' : 'Give at least one actor a ready clip first');
  $('#actorsHint').textContent = scene.actors.length ? `${scene.actors.length} actor${scene.actors.length === 1 ? '' : 's'}. “For” in the composer picks who a prompt generates for.` : 'No actors yet. Add one, give it the clip on the stage, add another, and write “Actor 2 dodges Actor 1”.';
  push();
}

function add(clipId = null) {
  const n = (scene.actors.reduce((m, a) => Math.max(m, a.n), 0) || 0) + 1;
  const a = { n, clip: clipId, x: n === 1 ? 0 : 1.2 * (n - 1), z: 0, yaw: 0, offset: 0, colour: COLOURS[(n - 1) % COLOURS.length] };
  scene.actors.push(a); selectedActor = n; compose.selectActor(n); save(); render();
  window.showTab?.('right', 'actors');
  return a;
}
export function clipOfActor(n) { const a = scene.actors.find(x => x.n === n); return a ? clipOf(a) : null; }
export function assign(n, clipId) { const a = scene.actors.find(x => x.n === n); if (!a) return; a.clip = clipId; save(); render(); }
// The director: give an actor (created if needed) a clip and, optionally, a placement.
export function setActorClip(n, clipId, placement) {
  let a = scene.actors.find(x => x.n === n);
  if (!a) { a = { n, clip: clipId, x: 0, z: 0, yaw: 0, offset: 0, colour: COLOURS[(n - 1) % COLOURS.length] }; scene.actors.push(a); scene.actors.sort((p, q) => p.n - q.n); }
  a.clip = clipId;
  if (placement) Object.assign(a, placement);
  adopted.add(clipId);
  save(); render();
  window.showTab?.('right', 'actors');
}

$('#addActor').onclick = () => add();
$('#actorUseStage').onclick = () => {
  const clip = viewer.state.animation; if (!clip) { library.setStatus('Put a clip on the stage first.', 'error'); return; }
  let a = scene.actors.find(x => x.n === selectedActor);
  if (!a) a = add(clip.id); else { a.clip = clip.id; save(); render(); }
};
// From a clip's ⋯ menu: give it to an actor.
window.sceneAssign = async a => {
  const options = [...scene.actors.map(x => ({ value: String(x.n), label: `Actor ${x.n}${clipOf(x) ? ' · ' + library.titleOf(clipOf(x)).slice(0, 24) : ''}` })), { value: 'new', label: 'New actor' }];
  const v = await choose('Use as an actor', library.titleOf(a).slice(0, 50), options, options[0].value);
  if (!v) return;
  if (v === 'new') add(a.id); else assign(Number(v), a.id);
};

// React: place this actor against another at a marker, pin a pose at that moment, prefill the prompt.
async function openReact(actor) {
  const dlg = $('#reactDialog'), others = scene.actors.filter(o => o !== actor && clipOf(o));
  if (!others.length) return;
  const toSel = $('#reactTo'), mkSel = $('#reactMarker'), poseSel = $('#reactPose');
  toSel.replaceChildren(...others.map(o => { const el = document.createElement('option'); el.value = String(o.n); el.textContent = `Actor ${o.n} · ${library.titleOf(clipOf(o)).slice(0, 30)}`; return el; }));
  const fillMarkers = () => {
    const o = scene.actors.find(x => x.n === Number(toSel.value)), c = clipOf(o);
    const list = (c?.markers || []).map(m => ({ value: String(m.frame), label: `${m.name} · frame ${m.frame + 1}` }));
    if (!list.length) list.push({ value: String(Math.floor((c?.frames || 60) / 2)), label: `middle of the clip (frame ${Math.floor((c?.frames || 60) / 2) + 1}) — add markers with M for precise timing` });
    mkSel.replaceChildren(...list.map(m => { const el = document.createElement('option'); el.value = m.value; el.textContent = m.label; return el; }));
  };
  toSel.onchange = fillMarkers; fillMarkers();
  poseSel.replaceChildren(...[{ value: '', label: '— none —' }, { value: '__screen', label: 'pose on screen' }, ...compose.savedPoses().map(p => ({ value: p.id, label: p.name }))].map(o => { const el = document.createElement('option'); el.value = o.value; el.textContent = o.label; return el; }));
  const to = () => scene.actors.find(x => x.n === Number(toSel.value));
  $('#reactPrompt').value = `Actor ${actor.n} dodges Actor ${to().n}'s attack, then recovers.`;
  toSel.addEventListener('change', () => { $('#reactPrompt').value = $('#reactPrompt').value.replace(/Actor \d+'s/, `Actor ${to().n}'s`); });
  $('#reactHint').textContent = '';
  dlg.querySelector('.cancel').onclick = () => dlg.close();
  dlg.querySelector('.ok').onclick = async () => {
    const other = to(), c = clipOf(other); if (!c) return;
    const markerFrame = Number(mkSel.value) || 0, distance = Number($('#reactDistance').value) || 1.2;
    // where the other actor is and faces at that frame, in scene space
    const st = await viewer.streamsOf(c);
    const f = Math.max(0, Math.min(c.frames - 1, markerFrame));
    const root = [st.root[f * 3], st.root[f * 3 + 1], st.root[f * 3 + 2]];
    const joints = st.rotations.length / (c.frames * 4);
    const hips = [st.rotations[f * joints * 4], st.rotations[f * joints * 4 + 1], st.rotations[f * joints * 4 + 2], st.rotations[f * joints * 4 + 3]];
    const headingLocal = compose.headingOf(hips) * 180 / Math.PI;      // degrees, in the other clip's own space
    const [wx, wz] = rot(root[0], root[2], other.yaw);                   // placed on the scene
    const px = wx + other.x, pz = wz + other.z;
    const facing = (other.yaw + headingLocal) * Math.PI / 180;            // the other actor faces this way (scene)
    const fx = Math.sin(facing), fz = Math.cos(facing);
    actor.x = +(px + fx * distance).toFixed(2); actor.z = +(pz + fz * distance).toFixed(2);
    if ($('#reactFace').checked) actor.yaw = Math.round(other.yaw + headingLocal + 180) % 360;
    // the moment in this actor's own clip: the marker frame, shifted by the two offsets, a little early
    const lead = $('#reactLead').checked ? 5 : 0;
    const atFrame = Math.max(0, f + other.offset - actor.offset - lead);
    save(); render();
    compose.clear();
    document.querySelector('#prompt').value = $('#reactPrompt').value.trim();
    const frames = Math.max(60, Math.min(360, Math.ceil((atFrame + 45) / 15) * 15));
    document.querySelector('[data-primary] .segment-frames').value = frames;
    if (poseSel.value) { const name = compose.addPoseAtFrame(poseSel.value, atFrame, [0, 0]); if (name) library.setStatus(`Pinned “${name}” at frame ${atFrame + 1} for Actor ${actor.n}.`); }
    compose.selectActor(actor.n);
    window.showTab?.('left', 'generate');
    dlg.close();
    library.setStatus(`Actor ${actor.n} placed ${distance} m from Actor ${other.n} at “${mkSel.selectedOptions[0]?.textContent.split(' · ')[0]}”. Press Generate.`);
  };
  dlg.showModal();
}

// Contact: pin the stage actor's hand/foot to another actor's joint at the current frame.
$('#actorContact').onclick = async () => {
  const me = stageActor(); const others = scene.actors.filter(o => o !== me && clipOf(o)?.status === 'ready');
  if (!viewer.state.animation) { library.setStatus('Put a clip on the stage first.', 'error'); return; }
  if (!others.length) { library.setStatus('Add another actor with a clip first.', 'error'); return; }
  const dlg = $('#contactDialog'), otherSel = $('#contactOther');
  otherSel.replaceChildren(...others.map(o => { const el = document.createElement('option'); el.value = String(o.n); el.textContent = `Actor ${o.n} · ${library.titleOf(clipOf(o)).slice(0, 28)}`; return el; }));
  $('#contactHint').textContent = `Frame ${viewer.state.frame + 1}.`;
  dlg.querySelector('.cancel').onclick = () => dlg.close();
  dlg.querySelector('.ok').onclick = async () => {
    const other = scene.actors.find(x => x.n === Number(otherSel.value));
    const e = viewer.extras.find(x => x.label === `Actor ${other.n}`); if (!e) { $('#contactHint').textContent = 'That actor is not on the stage.'; return; }
    const src = viewer.extraSource(e), j = viewer.skeleton.names.indexOf($('#contactJoint').value); if (j < 0) return;
    const target = [...src.pose[j]];
    // offset toward me: along the line from their joint to my effector's current spot
    const handles = await import('./handles.js'); const mineName = $('#contactMine').value;
    const myPose = viewer.pose(), myJ = viewer.skeleton.names.indexOf({ 'Left hand': 'LeftHand', 'Right hand': 'RightHand', 'Left foot': 'LeftFoot', 'Right foot': 'RightFoot' }[mineName]);
    const off = Number($('#contactOffset').value) || 0;
    if (myJ >= 0 && off) { const d = [myPose[myJ][0] - target[0], myPose[myJ][1] - target[1], myPose[myJ][2] - target[2]], n = Math.hypot(...d) || 1; for (let k = 0; k < 3; k++) target[k] += d[k] / n * off; }
    dlg.close();
    handles.pinTo(mineName, target, `Actor ${other.n}'s ${$('#contactJoint').selectedOptions[0].textContent}`);
  };
  dlg.showModal();
};
// Scene export: a JSON of actors + placements, and the whole scene to Unreal one clip after another.
$('#sceneExport').onclick = () => {
  const data = { project: library.currentProject() || 'inbox', fps: 30, actors: scene.actors.map(a => { const c = clipOf(a); return { actor: a.n, clip: a.clip, name: c ? library.titleOf(c) : null, frames: c?.frames ?? null, x: a.x, z: a.z, yaw: a.yaw, frame_offset: a.offset, markers: c?.markers || [], hand_track: c?.hand_track || [] }; }) };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const u = document.createElement('a'); u.href = URL.createObjectURL(blob); u.download = `understudy-scene-${(library.currentProject() || 'inbox')}.json`; u.click(); setTimeout(() => URL.revokeObjectURL(u.href), 2000);
};
$('#sceneUnreal').onclick = async () => {
  const clips = scene.actors.map(clipOf).filter(c => c?.status === 'ready');
  if (!clips.length) { library.setStatus('No actor has a ready clip.', 'error'); return; }
  for (const c of clips) { await window.sendClipToUnreal?.(c, { quiet: true }); }
  library.setStatus(`${clips.length} actor clip${clips.length === 1 ? '' : 's'} sent to Unreal; watch the job status.`);
};

// A generation made "for Actor N" takes that actor's slot once it is ready (newest wins; several takes: the cleanest).
let adopted = new Set();
function adopt() {
  const pid = library.currentProject();
  for (const a of scene.actors) {
    const mine = library.animations.filter(c => c.actor === a.n && c.status === 'ready' && (c.project || '') === pid && !adopted.has(c.id));
    if (!mine.length) continue;
    mine.sort((p, q) => (q.created_at || '').localeCompare(p.created_at || ''));
    const newest = mine[0];
    const batch = newest.batch ? mine.filter(c => c.batch === newest.batch) : [newest];
    const stillRunning = newest.batch && library.animations.some(c => c.batch === newest.batch && c.status !== 'ready' && c.status !== 'failed');
    if (stillRunning) continue;
    const pick = library.bestOf(batch) || newest;
    for (const c of mine) adopted.add(c.id);
    const current = clipOf(a);
    if (!current || (pick.created_at || '') > (current.created_at || '')) {
      a.clip = pick.id;
      // smart placement: a clip written against another actor ("Actor 2 … Actor 1") that has no placement yet faces that actor at 1.2 m
      const m = /\bactor\s*(\d+)\b/gi; let ref = null; for (const mm of (pick.actor_prompt || '').matchAll(m)) { const k = Number(mm[1]); if (k !== a.n && scene.actors.find(x => x.n === k && clipOf(x))) { ref = scene.actors.find(x => x.n === k); break; } }
      if (ref && !a.x && !a.z && !a.yaw && !a.placed) { const r = ref.yaw * Math.PI / 180; a.x = +(ref.x + Math.sin(r) * 1.2).toFixed(2); a.z = +(ref.z + Math.cos(r) * 1.2).toFixed(2); a.yaw = (ref.yaw + 180) % 360; a.placed = true; }
      save(); render(); library.setStatus(`Actor ${a.n} took “${library.titleOf(pick).slice(0, 40)}”${ref ? `, placed facing Actor ${ref.n}` : ''}.`);
    }
  }
}
setInterval(() => { load(); adopt(); }, 2500);
export function onClipChanged() { load(); push(); render(); }
library.setOnProjectChange(() => { loadedFor = undefined; load(); });
load();
