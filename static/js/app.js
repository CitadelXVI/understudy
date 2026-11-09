// Boot: wire the docks to the stage, direct links, shortcuts.
import './layout.js';
import './tabs.js';
import * as viewer from './viewer.js';
import * as compose from './compose.js';
import * as library from './library.js';
import * as handles from './handles.js';
import * as path from './path.js';
import * as point from './point.js';
import * as keep from './keep.js';
import * as character from './character.js';
import * as timeline from './timeline.js';
import * as scene from './scene.js';
import * as takes from './takes.js';
import * as director from './director.js';
import * as assistant from './assistant.js';
import './clipview.js';
import './wrist.js';
import './mocap.js';
import './props.js';
import './flow.js';

const $ = s => document.querySelector(s);
const download = $('#download'), downloadBVH = $('#downloadBVH'), downloadSkinned = $('#downloadSkinned'), copyLink = $('#copyLink'), exportMenu = $('#exportMenu');

// Direct links: #a=<animation id>[&f=<frame>] open that animation, paused at the frame when one is given.
function linked() {
  const p = new URLSearchParams(location.hash.slice(1)), id = p.get('a');
  if (!id) return null;
  const f = parseInt(p.get('f'), 10);
  return { animation: library.find(id), frame: Number.isFinite(f) ? f : null };
}

function syncStageClipState(a) {
  const noMotion = !a || a.kind === 'blank';
  const why = !a ? 'Generate or pick a clip in the Library first' : 'Generate or pick a motion clip first — the stage holds the blank T-pose';
  for (const sel of ['#continueFrom', '#moreLikeThis', '#makeLoop']) {
    const btn = $(sel); if (!btn) continue;
    if (btn.dataset.baseTitle === undefined) btn.dataset.baseTitle = btn.title || '';
    btn.disabled = noMotion;
    btn.title = noMotion ? why : btn.dataset.baseTitle;
  }
  const nameEl = $('#exportClipName'), checksEl = $('#exportClipChecks');
  if (nameEl) {
    nameEl.textContent = a ? `“${library.titleOf(a)}” · ${(a.frames / 30).toFixed(1)} s` : 'No clip on the stage';
    nameEl.title = a ? library.titleOf(a) : '';
  }
  if (checksEl && noMotion) checksEl.hidden = true;
}
function savingToText(id, folder) {
  if (library.projectFilter?.() === 'all') return 'New clips appear at the top of the Library on the right (filed in Inbox)';
  if (!id) return 'New clips appear at the top of Inbox in the Library on the right';
  return `New clips are saved to “${library.locationName(id, folder)}” in the Library on the right`;
}
syncStageClipState(null);

async function onSelectClip(a, { frame = null } = {}) {
  handles.setActive(false); path.setActive(false); point.setActive(false);
  syncStageClipState(a);
  download.href = `/api/animations/${a.id}/animation.glb`; download.download = `${(a.name || 'understudy-' + a.id).replace(/[^\w.-]+/g, '-')}.glb`;
  downloadSkinned.href = `/api/animations/${a.id}/skinned.glb`; downloadSkinned.download = `${(a.name || 'understudy-' + a.id).replace(/[^\w.-]+/g, '-')}-skinned.glb`;
  { const f = document.querySelector('#downloadFBX'); if (f) { f.href = `/api/animations/${a.id}/animation.fbx`; f.download = `${(a.name || 'understudy-' + a.id).replace(/[^\w.-]+/g, '-')}.fbx`; } }
  downloadBVH.href = `/api/animations/${a.id}/animation.bvh`; downloadBVH.download = `${(a.name || 'understudy-' + a.id).replace(/[^\w.-]+/g, '-')}.bvh`;
  exportMenu?.classList.add('ready');   // the Share tab's export list works once a clip is on the stage
  copyLink.hidden = false;
  compose.restore(a);
  history.replaceState(null, '', `#a=${a.id}`);
  try { await viewer.load(a, compose.skeletonOf(a.model), { frame }); }
  catch (e) { library.setStatus(`Could not open “${library.titleOf(a)}”: ${e.message}.`, 'error'); return; }
  keep.onClipChanged(); timeline.refresh(); scene.onClipChanged(); takes.onClipChanged(); assistant.onClipChanged();
  const title = library.titleOf(a), short = title.length > 46 ? title.slice(0, 45).trimEnd() + '…' : title;
  if (!/takes ready|Done\./.test($('#status').textContent)) library.setStatus(`On stage: “${short}”`);
}
library.setOnSelect(onSelectClip);

// A prompt that speaks for two or more actors is a scene: the director generates, places and times them.
function sceneCheck() {
  const text = $('#prompt').value, lines = director.parse(text);
  $('#sceneRow').hidden = lines.length < 2;
  if (lines.length >= 2) $('#sceneHint').textContent = `Scene: ${lines.map(l => `Actor ${l.actor}`).join(' → ')} — generated in order, each placed and timed against the one before.`;
}
$('#prompt').addEventListener('input', sceneCheck); setTimeout(sceneCheck, 500);
// Generate from the composer as it stands (keeps, pins, takes). Tools that prepare the
// composer and then generate call this directly: the button may be disabled while a scene runs.
function submitFromComposer() {
  try {
    const body = compose.request(library.currentProject(), library.currentFolder());
    const takes = compose.takes();
    const batch = takes > 1 ? Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('') : '';
    library.submit(Array.from({ length: takes }, (_, i) => ({ ...body, seed: (body.seed + i) >>> 0, batch, take: i + 1, takes })));
    // A fresh prompt starts the next generation from a new seed (the clip remembers the one it used). Iterating on a
    // clip (keeps/pins in the composer) keeps the seed, so a fix-and-regenerate changes only what was fixed.
    if (!seedLocked() && !compose.iterating()) compose.newSeed();
    else if (!seedLocked() && takes === 1) library.setStatus(`Generating with the same seed (${body.seed}) as the clip it iterates on: only what changed should change.`, 'readout progress');
  } catch (e) { library.setStatus(e.message, 'error'); }
}
const seedLocked = () => $('#lockSeed')?.getAttribute('aria-pressed') === 'true';
if ($('#lockSeed')) {
  const b = $('#lockSeed'), saved = localStorage.getItem('understudy.seedLock') === 'on';
  const show = on => { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.textContent = on ? '🔒' : '🔓'; b.classList.toggle('on', on); };
  show(saved);
  b.onclick = () => { const on = !seedLocked(); show(on); localStorage.setItem('understudy.seedLock', on ? 'on' : 'off'); };
}
// 2. the page is served from disk and changes under a long-lived tab: when the scripts on the server
//    differ from the ones this tab loaded, a one-line notice offers a reload.
(async () => {
  const stamp = async () => { try { const r = await fetch('/static/js/app.js', { method: 'HEAD', cache: 'no-store' }); return (r.headers.get('last-modified') || '') + '|' + (r.headers.get('content-length') || ''); } catch { return null; } };
  const first = await stamp(); if (!first) return;
  setInterval(async () => {
    const now = await stamp(); if (!now || now === first) return;
    if ($('#staleNotice')) return;
    const n = document.createElement('div'); n.id = 'staleNotice'; n.className = 'stale-notice';
    n.innerHTML = 'Understudy was updated. <button type="button" class="secondary">Reload</button>';
    n.querySelector('button').onclick = () => location.reload();
    document.body.append(n);
  }, 30000);
})();
window.generateNow = submitFromComposer;
$('#generate').onclick = async () => {
  if (director.isScene($('#prompt').value)) { $('#generate').disabled = true; try { await director.runSafe($('#prompt').value); } finally { $('#generate').disabled = false; } return; }
  submitFromComposer();
};

copyLink.onclick = async () => {
  const a = viewer.state.animation; if (!a) return;
  const url = `${location.origin}/#a=${a.id}&f=${viewer.state.frame}`;
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); copyLink.textContent = 'Copied'; }
  catch { copyLink.textContent = 'Link in address bar'; }
  setTimeout(() => { copyLink.textContent = 'Copy link'; }, 1500);
};

window.addEventListener('hashchange', () => {
  const l = linked();
  if (l?.animation && l.animation !== library.selected) library.select(l.animation, { frame: l.frame });
  else if (l?.animation && l.frame != null) viewer.load(l.animation, compose.skeletonOf(l.animation.model), { frame: l.frame });
});

$('#about').onclick = () => $('#aboutDialog').showModal();

// Clear the stage: no clip, nothing selected, tools off.
export function clearStage() {
  handles.setActive(false); path.setActive?.(false); point.setActive?.(false); keep.setActive?.(false);
  viewer.setGhost?.(null); $('#ghostBar').hidden = true;
  viewer.unload(); library.deselect();
  syncStageClipState(null);
  exportMenu?.classList.remove('ready'); copyLink.hidden = true;
  history.replaceState(null, '', location.pathname);
  loadBlank('Stage cleared: a blank T-pose to pose and key, or pick a clip in the Library.');
}
// A blank clip (2 s of T-pose) to pose and key from nothing; the server reuses an untouched one rather than make more
async function loadBlank(message) {
  try {
    const r = await fetch('/api/animations/blank', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: library.currentProject() }) });
    if (!r.ok) throw new Error(await r.text());
    const a = await r.json(); await library.refresh();
    library.select(library.find(a.id) || a, { frame: 0, noScroll: true });
    if (message) library.setStatus(message);
  } catch (e) { library.setStatus(e.message, 'error'); }
}
$('#clearStage')?.addEventListener('click', clearStage);
viewer.onDraw?.(() => { const b = $('#clearStage'); if (b) b.hidden = !viewer.state.animation; });

// Ghost compare.
window.setGhostClip = async a => {
  // the ghost is drawn over the clip on the stage: with nothing on the stage the clip itself goes on
  if (!viewer.state.animation) { library.select(a); library.setStatus(`“${library.titleOf(a).slice(0, 40)}” is on the stage. Now pick another clip's ⋯ → Compare to overlay it as a ghost.`); return; }
  if (viewer.state.animation.id === a.id) { library.setStatus(`That is the clip on the stage. Pick another clip's ⋯ → Compare to overlay it as a blue ghost.`); return; }
  await viewer.setGhost(a, compose.skeletonOf(a.model));
  library.setStatus(`Ghost on: “${library.titleOf(a).slice(0, 40)}” in blue over the clip on the stage. Ghost bar: align starts, side by side, or as recorded.`);
  $('#ghostBar').hidden = false; $('#ghostHint').textContent = library.titleOf(a).slice(0, 44); $('#ghostHint').title = `Ghost (blue): ${library.titleOf(a)}`;
};
$('#clearGhost').onclick = () => { viewer.setGhost(null); $('#ghostBar').hidden = true; };
$('#ghostMode').onchange = e => { viewer.ghost.align = e.target.value; viewer.alignGhost(); viewer.draw(); };
$('#bodyScale').onchange = e => viewer.setBodyScale(Number(e.target.value));
$('#onion').value = localStorage.getItem('understudy.onion') || 'off';
$('#onion').onchange = e => viewer.setOnion(e.target.value);

// Body button cycles: skeleton only → body only → body + skeleton (B).
const bodyModes = ['skeleton', 'body', 'both'];
const bodyLabels = { skeleton: 'Body', body: 'Body ●', both: 'Body ◐' };
function bodyMode() { return !viewer.isBodyShown() ? 'skeleton' : character.character.showSkeleton ? 'both' : 'body'; }
function syncBodyLabel() { const m = bodyMode(); $('#body').textContent = bodyLabels[m]; $('#body').title = { skeleton: 'Skeleton only · B shows the body', body: 'Body · B adds the skeleton through it', both: 'Body + skeleton · B goes back to the skeleton' }[m]; }
function applyBodyMode(m) {
  if (m === 'skeleton') { character.setShowSkeleton(false); viewer.setBody(false); }
  else { viewer.setBody(true); character.setShowSkeleton(m === 'both'); }
  localStorage.setItem('understudy.bodyMode', m); syncBodyLabel();
}
$('#body').onclick = () => applyBodyMode(bodyModes[(bodyModes.indexOf(bodyMode()) + 1) % 3]);
$('#xray').addEventListener('change', () => setTimeout(syncBodyLabel));
// The body is parked (owner, 2026-10-24 evening: "get rid of the body and keep working on functionality; a body
// comes later"). The stage works on the skeleton; the Body button, the Body tab and the B key stay out of the way
// until `localStorage.understudy.bodyFeature = 'on'` brings them back.
// The body is on again (2026-10-25): the generated mannequin, fitted to the skeleton (joints exact, shapes kept).
// `understudy.bodyFeature = 'off'` parks it.
export const BODY_FEATURE = localStorage.getItem('understudy.bodyFeature') !== 'off' || new URLSearchParams(location.search).has('body');
// transport on the timeline row (play · ruler · frame read left to right)
// (the transport has its own row above the timeline: index.html .transport-row)
$('#shipClip')?.addEventListener('click', () => $('#sendUnreal').click());
if (!BODY_FEATURE) {
  applyBodyMode('skeleton'); $('#body').hidden = true;
  const tab = document.querySelector('[data-tab="character"]'); if (tab) tab.hidden = true;
  for (const id of ['xray', 'hands', 'bodyChoice', 'bodyFit', 'bodyScale']) { const el = $('#' + id); if (el) el.closest('label').hidden = true; }
  import('./timeline.js').then(m => m.setHandsRow(false));
  document.querySelector('.timeline')?.classList.add('no-hands');
  for (const el of document.querySelectorAll('[data-body-only]')) el.hidden = true;
} else { const saved = localStorage.getItem('understudy.bodyMode'); applyBodyMode(saved === 'both' || saved === 'skeleton' ? saved : 'body'); } // the doll is the default view
const applyProp = () => { const [kind, len] = ($('#prop').value || ':0').split(':'); viewer.setProp(kind, Number(len), $('#propHand').value); };
$('#prop').onchange = applyProp; $('#propHand').onchange = applyProp;

// Reference: an image or video beside the library; a video can follow the clip's frame.
$('#referencePick')?.addEventListener('click', () => $('#referenceFile')?.click());
$('#referenceFile').onchange = () => {
  const file = $('#referenceFile').files[0];
  const fn = $('#referenceFileName');
  if (fn) { fn.textContent = file ? file.name : 'No file chosen'; fn.title = file ? file.name : ''; }
  if (!file) return;
  const url = URL.createObjectURL(file), view = $('#referenceView');
  if (file.type.startsWith('video')) { const v = document.createElement('video'); v.src = url; v.controls = true; v.muted = true; v.loop = true; view.replaceChildren(v); }
  else { const img = document.createElement('img'); img.src = url; view.replaceChildren(img); }
  window.showTab?.('right', 'reference');
};
viewer.onFrameChange(frame => {
  const v = $('#referenceView video'); const a = viewer.state.animation;
  if (!v || !a || !$('#referenceSync').checked || !v.duration || viewer.state.playing) return;
  v.currentTime = (frame / Math.max(1, a.frames - 1)) * v.duration;
});

// Saved prompts per project: the prompt plus the settings it ran with.
import('./dialogs.js').then(({ ask, confirm }) => {
  const select = $('#savedPrompts');
  // no project chosen (All projects, the default): the Inbox's own saved prompts (/api/prompts)
  let inbox = { id: '', name: 'Inbox', prompts: [] };
  fetch('/api/prompts').then(r => r.ok ? r.json() : []).then(list => { inbox.prompts = list || []; fill(); }).catch(() => {});
  const projectOrInbox = () => library.projects.find(p => p.id === library.currentProject()) || inbox;
  function fill() {
    const project = projectOrInbox();
    const list = project?.prompts || [];
    select.replaceChildren(...[{ name: list.length ? 'Load…' : 'None yet' }, ...list].map((sp, i) => { const o = document.createElement('option'); o.value = i ? String(i - 1) : ''; o.textContent = sp.name; return o; }));
    select.disabled = !project;
  }
  select.onchange = async () => {
    const project = projectOrInbox(); const sp = project?.prompts?.[Number(select.value)]; select.value = '';
    if (!sp) return;
    const settings = sp.settings || {};
    compose.restore({ prompt: sp.prompt, frames: settings.frames || 150, segments: settings.segments, seed: settings.seed, text_cfg: settings.text_cfg, diffusion_steps: settings.steps, model: settings.model, text_quantization: settings.text_quantization, post_processing: settings.post_processing });
    library.setStatus(`Loaded “${sp.name}”.`);
  };
  $('#savePrompt').onclick = async () => {
    const project = projectOrInbox(); if (!project) { library.setStatus('Pick a project to save prompts into.', 'error'); return; }
    let body; try { body = compose.request(project.id, ''); } catch (e) { library.setStatus(e.message, 'error'); return; }
    const name = await ask('Save prompt', 'A short name for this prompt and its settings.', body.prompt.slice(0, 40));
    if (!name) return;
    const settings = { segments: body.segments, frames: body.segments[0].frames, seed: body.seed, text_cfg: body.text_cfg, steps: body.steps, model: body.model, text_quantization: body.text_quantization, post_processing: body.post_processing };
    const prompts = [...(project.prompts || []).filter(sp => sp.name !== name), { name, prompt: body.prompt, settings }];
    try { if (project === inbox) { const r = await fetch('/api/prompts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(prompts) }); if (!r.ok) throw new Error(await r.text()); inbox.prompts = await r.json(); } else { await fetch(`/api/projects/${project.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompts }) }); await library.loadProjects(); } fill(); library.setStatus(`Saved “${name}”.`); } catch (e) { library.setStatus(e.message, 'error'); }
  };
  const previous = $('#savedPrompts');
  $('#clearCompose').addEventListener('click', () => path.reset());
library.setOnProjectChange((id, folder) => { $('#savingTo').textContent = savingToText(id, folder); fill(); });
  fill();
});

// Batch builders.
const newBatch = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
function submitPlanned(items) {
  // items: [{ prompt, frames, name, tags, constraints?, first_heading? }]
  const base = compose.request(library.currentProject(), library.currentFolder());
  const takes = compose.takes(), bodies = [];
  for (const it of items) {
    const batch = takes > 1 ? newBatch() : '';
    for (let i = 0; i < takes; i++) bodies.push({ ...base, prompt: it.prompt, segments: [{ prompt: it.prompt, frames: it.frames }], constraints: it.constraints, first_heading: it.first_heading, name: it.name, tags: it.tags, seed: (base.seed + bodies.length) >>> 0, batch, take: i + 1, takes });
  }
  library.submit(bodies);
}
$('#styleSet').onclick = () => {
  const dlg = $('#styleDialog');
  const plan = () => {
    const action = $('#styleAction').value.trim().replace(/\.$/, '');
    const genders = [...dlg.querySelectorAll('[data-gender]:checked')].map(i => i.dataset.gender), archs = [...dlg.querySelectorAll('[data-arch]:checked')].map(i => i.dataset.arch);
    const frames = Math.max(60, Math.min(360, Number($('#styleFrames').value) || 120));
    const items = [];
    for (const g of genders) for (const a of archs) {
      const article = /^[aeiou]/.test(a) ? 'An' : 'A';
      items.push({ prompt: `${article} ${a} ${g} ${action}.`, frames, name: `${a} ${g} · ${action}`, tags: [`${a}_${g}`] });
    }
    $('#styleHint').textContent = action ? `${items.length} prompts × ${compose.takes()} takes` : 'Describe the action first.';
    return action ? items : [];
  };
  dlg.oninput = plan; plan();
  dlg.querySelector('.ok').onclick = e => { e.preventDefault(); const items = plan(); if (!items.length) return; dlg.close(); submitPlanned(items); };
  dlg.querySelector('.cancel').onclick = e => { e.preventDefault(); dlg.close(); };
  dlg.showModal();
};
$('#locoSet').onclick = () => {
  const dlg = $('#locoDialog');
  // A straight or turning root path at the gait's speed, as root2d waypoints every 15 frames.
  const pathFor = (dir, speed, frames) => {
    const idx = [], pts = [], head = [];
    for (let f = 0; f < frames; f += 15) idx.push(f);
    if (idx[idx.length - 1] !== frames - 1) idx.push(frames - 1);
    for (const f of idx) {
      const t = f / 30, d = speed * t;
      let x = 0, z = 0, yaw = 0;
      if (dir === 'forward') z = d;
      else if (dir === 'backward') z = -d;
      else if (dir === 'left') x = -d;
      else if (dir === 'right') x = d;
      else { // 90° turn over the clip: an arc
        const total = speed * (frames - 1) / 30, radius = total / (Math.PI / 2), ang = (d / total) * Math.PI / 2 * (dir === 'turn_left' ? 1 : -1);
        x = radius * (1 - Math.cos(ang)) * (dir === 'turn_left' ? -1 : 1); z = radius * Math.sin(Math.abs(ang)); yaw = ang;
      }
      pts.push([x, z]); head.push([Math.cos(yaw), Math.sin(yaw)]);
    }
    return { type: 'root2d', frame_indices: idx, smooth_root_2d: pts, global_root_heading: head };
  };
  const words = { forward: 'forward', backward: 'backward, facing forward', left: 'sideways to the left, facing forward', right: 'sideways to the right, facing forward', turn_left: 'forward and turns left', turn_right: 'forward and turns right' };
  const plan = () => {
    const subject = $('#locoSubject').value.trim() || 'A person';
    const gaits = [...dlg.querySelectorAll('[data-gait]:checked')].map(i => ({ gait: i.dataset.gait, speed: Number(i.dataset.speed) }));
    const dirs = [...dlg.querySelectorAll('[data-dir]:checked')].map(i => i.dataset.dir);
    const frames = Math.max(60, Math.min(360, Number($('#locoFrames').value) || 90));
    const items = [];
    for (const g of gaits) for (const d of dirs) items.push({ prompt: `${subject} ${g.gait}s ${words[d]}.`, frames, name: `${g.gait} ${d.replace('_', ' ')}`, tags: [`${g.gait}_${d}`], constraints: [pathFor(d, g.speed, frames)] });
    $('#locoHint').textContent = `${items.length} clips × ${compose.takes()} takes`;
    return items;
  };
  dlg.oninput = plan; plan();
  dlg.querySelector('.ok').onclick = e => { e.preventDefault(); const items = plan(); if (!items.length) return; dlg.close(); submitPlanned(items); };
  dlg.querySelector('.cancel').onclick = e => { e.preventDefault(); dlg.close(); };
  dlg.showModal();
};

// Export: the list sits open in the Share tab (flow.js); nothing to open or close.

// Frame sheet: the clip from a locked side view, every Nth frame, as one PNG for drawing over.
$('#frameSheet').onclick = async () => {
  const a = viewer.state.animation; if (!a) return;
  const every = Math.max(1, Math.round(a.frames / 24)), cols = 6, tile = 320;
  const frames = []; for (let f = 0; f < a.frames; f += every) frames.push(f);
  const rows = Math.ceil(frames.length / cols);
  const sheet = document.createElement('canvas'); sheet.width = cols * tile; sheet.height = rows * tile;
  const ctx = sheet.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  const wasPlaying = viewer.state.playing, wasFrame = viewer.state.frame;
  viewer.setPlaying(false);
  for (let i = 0; i < frames.length; i++) {
    const tileCanvas = viewer.renderFrame(frames[i], { width: tile, height: tile, side: true });
    ctx.drawImage(tileCanvas, (i % cols) * tile, Math.floor(i / cols) * tile);
    ctx.fillStyle = '#888'; ctx.font = '14px monospace'; ctx.fillText(`f${frames[i] + 1}`, (i % cols) * tile + 8, Math.floor(i / cols) * tile + 18);
  }
  viewer.setFrame(wasFrame); viewer.setPlaying(wasPlaying);
  const link = document.createElement('a'); link.href = sheet.toDataURL('image/png'); link.download = `${(a.name || 'understudy-' + a.id).replace(/[^\w.-]+/g, '-')}-sheet.png`; link.click();
  library.setStatus(`Frame sheet saved: ${frames.length} frames, from the side (${link.download}).`);
};

// Send to Unreal: a server job; poll it and report.
async function sendClipToUnreal(a, { quiet = false } = {}) {
  if (!a) return;
  const project = library.projectOf(a);
  if (!project) { library.setStatus('Move the clip into a project first (the Inbox has no pipeline).', 'error'); return; }
  if (!project.pipeline?.uproject) { await library.editPipeline(project.id); if (!library.projectOf(a)?.pipeline?.uproject) return; }
  let job;
  try {
    const r = await fetch(`/api/animations/${a.id}/pipeline`, { method: 'POST' });
    if (!r.ok) throw new Error(await r.text());
    job = await r.json();
  } catch (e) { library.setStatus(e.message, 'error'); return; }
  library.setStatus('Unreal: importing and retargeting… (the editor must stay closed)', 'readout progress');
  const started = Date.now();
  await new Promise(resolve => {
    const timer = setInterval(async () => {
      const j = await (await fetch(`/api/jobs/${job.id}`)).json();
      if (j.status === 'running' || j.status === 'queued') { if (!quiet) library.setStatus(`Unreal: working… ${Math.floor((Date.now() - started) / 1000)}s`, 'readout progress'); return; }
      clearInterval(timer);
      if (j.status === 'done') library.setStatus(`In Unreal: ${j.assets?.slice(-1)[0] || ''}${j.fbx ? ` · FBX ${j.fbx}` : ''}`);
      else library.setStatus(`Unreal job failed: ${j.error}. ${j.log?.slice(-2).join(' ')}`, 'error');
      resolve();
    }, 2000);
  });
}
window.sendClipToUnreal = sendClipToUnreal;
$('#sendUnreal').onclick = () => sendClipToUnreal(library.selected);

// Video export: every frame of the clip drawn on the stage (skeleton, body, overlays) into a WebM.
$('#exportVideo').onclick = async () => {
  const a = viewer.state.animation; if (!a) return;
  const view = $('#view'), body = $('#view3d'), ui = $('#viewui');
  const out = document.createElement('canvas'); out.width = view.width; out.height = view.height;
  const ctx = out.getContext('2d');
  const stream = out.captureStream(0), track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm', videoBitsPerSecond: 12_000_000 });
  const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(r => { rec.onstop = r; });
  const wasPlaying = viewer.state.playing, startFrame = viewer.state.frame;
  viewer.setPlaying(false);
  rec.start();
  library.setStatus('Rendering video…', 'readout progress');
  for (let f = 0; f < a.frames; f++) {
    viewer.setFrame(f); viewer.draw();
    await new Promise(r => requestAnimationFrame(r));
    ctx.fillStyle = getComputedStyle(document.querySelector('.stage')).backgroundColor || '#15090b'; ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(view, 0, 0); if (body.style.visibility !== 'hidden') ctx.drawImage(body, 0, 0, out.width, out.height); ctx.drawImage(ui, 0, 0, out.width, out.height);
    if (track.requestFrame) track.requestFrame();
    await new Promise(r => setTimeout(r, 1000 / 30));
    if (f % 30 === 0) library.setStatus(`Rendering video… ${f + 1} / ${a.frames}`, 'readout progress');
  }
  rec.stop(); await done;
  viewer.setFrame(startFrame); viewer.setPlaying(wasPlaying);
  const blob = new Blob(chunks, { type: 'video/webm' });
  const u = document.createElement('a'); u.href = URL.createObjectURL(blob); u.download = `${(a.name || 'understudy-' + a.id).replace(/[^\w.-]+/g, '-')}.webm`; u.click(); setTimeout(() => URL.revokeObjectURL(u.href), 5000);
  library.setStatus(`Video saved: ${a.frames} frames, ${(blob.size / 1e6).toFixed(1)} MB.`);
};

// Prompt sheet: many prompts at once, each with the current settings and Takes.
$('#promptSheet').onclick = () => {
  const dlg = $('#sheetDialog'), text = $('#sheetText'), hint = $('#sheetHint');
  text.oninput = () => { const n = text.value.split('\n').filter(l => l.trim()).length; hint.textContent = n ? `${n} prompt${n === 1 ? '' : 's'} × ${compose.takes()} take${compose.takes() === 1 ? '' : 's'} = ${n * compose.takes()} clips` : ''; };
  text.oninput();
  dlg.querySelector('.ok').onclick = e => {
    e.preventDefault(); dlg.close();
    const lines = text.value.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const base = compose.request(library.currentProject(), library.currentFolder());
    const takes = compose.takes(), bodies = [];
    for (const line of lines) {
      const [prompt, framesText] = line.split('|').map(x => x.trim());
      const frames = Math.max(60, Math.min(360, parseInt(framesText, 10) || 150));
      const batch = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
      for (let i = 0; i < takes; i++) bodies.push({ ...base, prompt, segments: [{ prompt, frames }], constraints: undefined, first_heading: undefined, seed: (base.seed + bodies.length) >>> 0, batch: takes > 1 ? batch : '', take: i + 1, takes });
    }
    library.submit(bodies);
  };
  dlg.querySelector('.cancel').onclick = e => { e.preventDefault(); dlg.close(); };
  dlg.showModal();
};
$('#speed').onchange = () => viewer.setSpeed(Number($('#speed').value));
for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => viewer.setViewPreset(b.dataset.view);

// Markers: named frames on the selected clip (hit, plant, release…), stored on its record.
import('./dialogs.js').then(({ ask }) => {
  const track = $('#markerTrack'), chips = $('#markerChips'), bar = $('#markerBar');
  const current = () => library.selected;
  function renderMarkers() {
    const a = current(); const list = a?.markers || [];
    bar.hidden = !a;
    track.replaceChildren(...list.map(m => { const t = document.createElement('div'); t.className = 'tick'; t.style.left = `${(m.frame / Math.max(1, a.frames - 1)) * 100}%`; t.title = `${m.name} · frame ${m.frame + 1}`; t.onclick = () => { viewer.setPlaying(false); viewer.setFrame(m.frame); }; return t; }));
    chips.replaceChildren(...list.map((m, i) => { const c = document.createElement('button'); c.type = 'button'; c.className = 'chip'; c.innerHTML = `<b>${m.frame + 1}</b>${m.name.replace(/[&<>]/g, '')}<span class="x">×</span>`; c.onclick = e => { if (e.target.classList.contains('x')) save(list.filter((_, j) => j !== i)); else { viewer.setPlaying(false); viewer.setFrame(m.frame); } }; return c; }));
  }
  async function save(markers) { const a = current(); if (!a) return; try { await library.patch(a.id, { markers }); await library.refresh(); renderMarkers(); } catch (e) { library.setStatus(e.message, 'error'); } }
  async function add() {
    const a = current(); if (!a) return;
    viewer.setPlaying(false);
    const name = await ask('Marker', `Frame ${viewer.state.frame + 1}. Name the event: hit, plant, release, contact…`);
    if (!name) return;
    save([...(a.markers || []), { frame: viewer.state.frame, name }]);
  }
  $('#addMarker').onclick = add;
  window.addEventListener('keydown', e => { const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return; if (e.key === 'm' || e.key === 'M') add(); });
  library.setOnSelect((a, options) => { onSelectClip(a, options); renderMarkers(); });
  window.renderMarkers = renderMarkers;
});

// Shortcuts (not while typing).
window.addEventListener('keydown', e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (handles.hasSelection() && /^(Arrow|Page)/.test(e.key)) return; // the handle takes the nudge
  if (e.code === 'Space') { e.preventDefault(); viewer.setPlaying(!viewer.state.playing); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); viewer.step(e.shiftKey ? -10 : -1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); viewer.step(e.shiftKey ? 10 : 1); }
  else if (e.key === 'Home') { e.preventDefault(); viewer.setPlaying(false); viewer.setFrame(0); }
  else if (e.key === 'End') { e.preventDefault(); viewer.setPlaying(false); viewer.setFrame(-1); }
  else if (e.key === 'g' || e.key === 'G') { $('#generate').click(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); library.toggleAll(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !handles.isActive()) { e.preventDefault(); handles.undoEdit(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y') && !handles.isActive()) { e.preventDefault(); handles.redoEdit(); }
  else if (e.key === 'Escape') { library.clearSelection(); }
  else if (e.key === 't' || e.key === 'T') { viewer.toggleTrails(); }
  else if (e.key === 'h' || e.key === 'H') { $('#handles').click(); }
  else if (e.key === 'p' || e.key === 'P') { $('#pathTool').click(); }
  else if (e.key === 'o' || e.key === 'O') { $('#pointTool').click(); }
  else if ((e.key === 'b' || e.key === 'B') && BODY_FEATURE) { $('#body').click(); }
  else if (e.key === 'k' || e.key === 'K') { $('#keepTool').click(); }
  else if (e.key === '?') { $('#aboutDialog').open ? $('#aboutDialog').close() : $('#aboutDialog').showModal(); }
  else if (e.key === 'x' || e.key === 'X') { const x = $('#xray'); x.checked = !x.checked; x.dispatchEvent(new Event('change')); }
  else if (e.key === '[') { keep.setIn(); }
  else if (e.key === ']') { keep.setOut(); }
  else if (e.key === '1') viewer.setViewPreset('front');
  else if (e.key === '3') viewer.setViewPreset('side');
  else if (e.key === '7') viewer.setViewPreset('top');
  else if (e.key === '5') viewer.setViewPreset('three');
});

$('#clearCompose').addEventListener('click', () => path.reset());
library.setOnProjectChange((id, folder) => { $('#savingTo').textContent = savingToText(id, folder); });

(async () => {
  await compose.init();
  await library.loadProjects();
  await library.refresh();
  const l = linked();
  if (location.hash && !l?.animation) library.setStatus('Linked animation not found in the library', 'error');
  // a linked clip opens; otherwise the stage starts clean (owner: no clip "already set" and its skeleton on the stage
  // every time the page opens)
  if (l?.animation) library.select(l.animation, { frame: l.frame ?? null });
  else loadBlank('');   // a blank T-pose to start from (owner: a clean canvas, but a mannequin "we can do something with")
  setInterval(library.refresh, 2500);
})();

// Handle labels on the stage can be switched off (Handles bar → Labels, or L)
{ const box = document.querySelector('#handleLabels'); if (box) { box.checked = viewer.handleLabelsShown(); box.onchange = () => viewer.setHandleLabels(box.checked); }
  window.addEventListener('keydown', e => { if ((e.key === 'l' || e.key === 'L') && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '') && !e.ctrlKey && !e.metaKey) { const b = document.querySelector('#handleLabels'); if (b) { b.checked = !b.checked; viewer.setHandleLabels(b.checked); } } }); }
