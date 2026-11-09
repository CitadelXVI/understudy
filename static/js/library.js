// The library dock: projects, the clips filed under them, search and filters,
// selection and bulk actions, and the progress of the generation in flight.
import { ask, choose, confirm } from './dialogs.js';

const $ = s => document.querySelector(s);
const items = $('#items'), status = $('#status'), generate = $('#generate');
const projectSelect = $('#projectSelect'), search = $('#search'), chipFavorites = $('#chipFavorites'), chipArchived = $('#chipArchived'), chipTrash = $('#chipTrash');
const bulk = $('#bulk'), bulkCount = $('#bulkCount'), countText = $('#libraryCount'), menu = $('#itemMenu');

export let animations = [];
export let projects = [];
export let selected = null;
const selection = new Set();
let onSelect = () => {}, onProjectChange = () => {};
let activeRequests = new Set(), activeStarted, activeTotal = 0;
const filters = { project: localStorage.getItem('understudy.project') ?? 'all', folder: localStorage.getItem('understudy.folder') ?? '', query: '', favorites: false, archived: false, trash: false, tag: '', board: false };
const chipBoard = $('#chipBoard'), board = $('#board'), slotsEl = $('#slots');
const foldersBar = $('#folders');

export function setOnSelect(fn) { onSelect = fn; }
export function setOnProjectChange(fn) { onProjectChange = fn; }
export function find(id) { return animations.find(a => a.id === id || a.id.startsWith(id)) || null; }
// Where a new clip is filed: the current project, or the Inbox when viewing everything.
export function currentProject() { return filters.project === 'all' ? '' : filters.project; }
export function projectFilter() { return filters.project; }
export function currentFolder() { return currentProject() ? filters.folder : ''; }
export function projectName(id) { return id === '' ? 'Inbox' : (projects.find(p => p.id === id)?.name ?? id); }
export function locationName(projectID, folder) { return projectName(projectID) + (folder ? ' › ' + folder.replaceAll('/', ' › ') : ''); }
const inFolder = (folder, path) => !path || folder === path || (folder || '').startsWith(path + '/');
export const titleOf = a => a.name || a.prompt;

const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
};
export const patch = (id, p) => api('PATCH', `/api/animations/${id}`, p);
export const batch = (ids, body) => api('POST', '/api/animations/batch', { ids, ...body });

let pendingScroll = false;
function scrollActiveIntoView() {
  if (!selected || selected.kind === 'blank') {
    pendingScroll = false;
    items.scrollTop = 0;
    return;
  }
  const el = items.querySelector('.item.active');
  if (!el) return;
  if (!items.offsetParent) { pendingScroll = true; return; }
  pendingScroll = false;
  const cards = [...items.querySelectorAll('.item')];
  const idx = cards.indexOf(el);
  const viewH = items.clientHeight || 0;
  if (!viewH) { el.scrollIntoView({ block: 'start' }); return; }
  const topOf = c => c.offsetParent === items ? c.offsetTop : c.offsetTop - items.offsetTop;
  const maxScroll = Math.max(0, items.scrollHeight - viewH);
  const elTop = topOf(el);
  const elBottom = elTop + el.offsetHeight;
  // Already completely visible from the top of the list: keep newest cards at top.
  if (elBottom + 6 <= viewH) {
    items.scrollTop = 0;
    return;
  }
  // Find the earliest whole card `i <= idx` that fits together with `el` inside `viewH`,
  // and align `scrollTop` to `topOf(cards[i]) - 6` so card `i - 1` ends at 0 px (never sliced in half).
  let target = Math.min(maxScroll, Math.max(0, elTop - 6));
  for (let i = 0; i <= idx; i++) {
    if (cards[i].classList.contains('take-follow')) continue;
    const cTop = topOf(cards[i]);
    const snap = Math.max(0, cTop - 6);
    if (snap <= maxScroll && (elBottom + 6) - snap <= viewH) {
      target = snap;
      break;
    }
  }
  items.scrollTop = target;
}
const libPage = items.closest('.page');
if (libPage) new MutationObserver(() => { if (!libPage.hidden && pendingScroll) requestAnimationFrame(scrollActiveIntoView); }).observe(libPage, { attributes: true, attributeFilter: ['hidden'] });
window.addEventListener('resize', () => { if (selected && selected.kind !== 'blank') requestAnimationFrame(scrollActiveIntoView); });

export function select(a, options = {}) {
  if (!a || a.status !== 'ready') return;
  selected = a;
  render();
  if (options.noScroll || a.kind === 'blank') { pendingScroll = false; items.scrollTop = 0; }
  else if (!options.fromList) requestAnimationFrame(scrollActiveIntoView);
  else pendingScroll = false;
  onSelect(a, options);
}

// --- projects ---
export async function loadProjects() {
  projects = await api('GET', '/api/projects');
  const options = [{ value: 'all', label: 'All projects & Inbox' }, { value: '', label: 'Inbox' }, ...projects.map(p => ({ value: p.id, label: p.name }))];
  projectSelect.replaceChildren(...options.map(o => { const el = document.createElement('option'); el.value = o.value; el.textContent = o.label; return el; }));
  if (![...projectSelect.options].some(o => o.value === filters.project)) filters.project = 'all';
  projectSelect.value = filters.project;
  renderFolders();
  onProjectChange(currentProject(), currentFolder());
}
function setFolder(folder) { filters.folder = folder; localStorage.setItem('understudy.folder', folder); selection.clear(); render(); onProjectChange(currentProject(), currentFolder()); }
projectSelect.onchange = () => { filters.project = projectSelect.value; localStorage.setItem('understudy.project', filters.project); filters.folder = ''; localStorage.setItem('understudy.folder', ''); selection.clear(); render(); onProjectChange(currentProject(), currentFolder()); };
function renderFolders() {
  const project = projects.find(p => p.id === filters.project);
  foldersBar.hidden = !project;
  if (!project) return;
  const folders = project.folders || [];
  if (filters.folder && !folders.includes(filters.folder)) filters.folder = '';
  const chip = (label, on, onclick, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'chip' + (on ? ' on' : '') + (cls ? ' ' + cls : ''); b.innerHTML = label; b.onclick = onclick; return b; };
  const all = chip('All', !filters.folder, () => setFolder(''));
  const list = folders.map(f => {
    const depth = f.split('/').length - 1, name = f.split('/').pop();
    const b = chip(`${'<span class="depth">›</span> '.repeat(depth)}${esc(name)}`, filters.folder === f, () => setFolder(f));
    b.title = `${f} · right-click for rename / trash / remove`;
    b.oncontextmenu = e => { e.preventDefault(); folderMenu(f, b); };
    return b;
  });
  const add = chip('+ folder', false, async () => {
    const name = await ask('New folder', filters.folder ? `Inside ${filters.folder}. Use / to nest, e.g. Locomotion/Male.` : 'Use / to nest, e.g. Locomotion/Male.');
    if (!name) return;
    const path = filters.folder ? `${filters.folder}/${name}` : name;
    try { await api('POST', `/api/projects/${project.id}/folders`, { name: path }); await loadProjects(); setFolder(path); } catch (e) { setStatus(e.message, 'error'); }
  }, 'add');
  const manage = filters.folder ? [chip('⋯', false, e => folderMenu(filters.folder, e.currentTarget))] : [];
  foldersBar.replaceChildren(all, ...list, add, ...manage);
}
async function folderMenu(folder, anchor) {
  const project = projects.find(p => p.id === filters.project); if (!project) return;
  const actions = [
    ['Rename folder', async () => { const to = await ask('Rename folder', 'The full path; nested folders move with it.', folder); if (to && to !== folder) { try { await api('PATCH', `/api/projects/${project.id}/folders`, { from: folder, to }); await loadProjects(); setFolder(to.split('/').map(x => x.trim()).filter(Boolean).join('/')); await refresh(); } catch (e) { setStatus(e.message, 'error'); } } }],
    ['Select all clips in it', () => { setFolder(folder); for (const a of visible()) selection.add(a.id); render(); }],
    ['Move its clips to the Trash', async () => { const ids = animations.filter(a => a.project === project.id && !a.trashed && inFolder(a.folder, folder)).map(a => a.id); if (!ids.length) { setStatus('No clips in that folder.'); return; } if (await confirm('Move to Trash', `Move the ${ids.length} clip${ids.length === 1 ? '' : 's'} in “${folder}” to the Trash?`, 'Move to Trash')) { try { await batch(ids, { delete: true }); await refresh(); } catch (e) { setStatus(e.message, 'error'); } } }],
    ['Remove folder (clips move up a level)', async () => { if (await confirm('Remove folder', `Remove “${folder}”? Its clips move up a level; nothing is deleted.`, 'Remove', true)) { try { await api('DELETE', `/api/projects/${project.id}/folders?name=${encodeURIComponent(folder)}`); await loadProjects(); setFolder(folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''); await refresh(); } catch (e) { setStatus(e.message, 'error'); } } }, 'danger'],
  ];
  menu.replaceChildren(...actions.map(([label, fn, cls]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.onclick = () => { closeMenu(); fn(); }; return b; }));
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  setTimeout(() => document.addEventListener('pointerdown', closeMenuOutside));
}
$('#newProject').onclick = async () => {
  const name = await ask('New project', 'One per game, or a bucket like “Game Jam”.');
  if (!name) return;
  try { const p = await api('POST', '/api/projects', { name }); filters.project = p.id; localStorage.setItem('understudy.project', p.id); await loadProjects(); render(); }
  catch (e) { setStatus(e.message, 'error'); }
};
$('#projectMenu').onclick = async () => {
  const id = filters.project;
  if (id === 'all' || id === '') { setStatus('Pick a project to rename or remove it.'); return; }
  const count = animations.filter(a => a.project === id && !a.trashed).length;
  const action = await choose('Project', `${projectName(id)} · ${count} clip${count === 1 ? '' : 's'}`, [
    { value: 'rename', label: 'Rename' },
    { value: 'folder', label: 'New folder…' },
    { value: 'pipeline', label: 'Pipeline settings (Send to Unreal)' },
    { value: 'delete', label: 'Delete project — clips go to the Inbox' },
    { value: 'deleteTrash', label: 'Delete project — clips go to the Trash too' },
  ], 'rename');
  if (action === 'pipeline') { await editPipeline(id); return; }
  if (action === 'folder') { const name = await ask('New folder', 'Use / to nest, e.g. Locomotion/Male.'); if (name) { try { await api('POST', `/api/projects/${id}/folders`, { name }); await loadProjects(); setFolder(name); } catch (e) { setStatus(e.message, 'error'); } } return; }
  if (action === 'rename') {
    const name = await ask('Rename project', '', projectName(id));
    if (name) { try { await api('PATCH', `/api/projects/${id}`, { name }); await loadProjects(); } catch (e) { setStatus(e.message, 'error'); } }
  } else if (action === 'delete' || action === 'deleteTrash') {
    const toTrash = action === 'deleteTrash';
    if (await confirm('Delete project', toTrash ? `Delete “${projectName(id)}” and move its ${count} clips to the Trash? They stay restorable until the Trash is emptied.` : `Delete “${projectName(id)}”? Its ${count} clips move to the Inbox; nothing is deleted.`, 'Delete', true)) {
      try { await api('DELETE', `/api/projects/${id}${toTrash ? '?trash=1' : ''}`); filters.project = 'all'; localStorage.setItem('understudy.project', 'all'); await loadProjects(); await refresh(); setStatus(toTrash ? `Project deleted; ${count} clips in the Trash.` : `Project deleted; ${count} clips in the Inbox.`); } catch (e) { setStatus(e.message, 'error'); }
    }
  }
};

export async function editPipeline(id) {
  const p = projects.find(p => p.id === id); if (!p) return;
  const dlg = $('#pipelineDialog'), cfg = p.pipeline || {};
  $('#plUproject').value = cfg.uproject || ''; $('#plTarget').value = cfg.target_mesh || '';
  $('#plPreset').value = ''; $('#plPreset').onchange = () => { const v = $('#plPreset').value; if (v) $('#plTarget').value = v === 'none' ? '' : v; }; $('#plContent').value = cfg.content_path || ''; $('#plExport').value = cfg.export_dir || ''; $('#plArgs').value = cfg.extra_args || '';
  await new Promise(resolve => {
    dlg.querySelector('.ok').onclick = async e => {
      e.preventDefault();
      const pipeline = { uproject: $('#plUproject').value.trim(), target_mesh: $('#plTarget').value.trim(), content_path: $('#plContent').value.trim(), export_dir: $('#plExport').value.trim(), extra_args: $('#plArgs').value.trim() };
      try { await api('PATCH', `/api/projects/${id}`, { pipeline }); await loadProjects(); setStatus(pipeline.uproject ? `Pipeline set for ${p.name}.` : `Pipeline cleared for ${p.name}.`); } catch (err) { setStatus(err.message, 'error'); }
      dlg.close(); resolve();
    };
    dlg.querySelector('.cancel').onclick = e => { e.preventDefault(); dlg.close(); resolve(); };
    dlg.onclose = () => resolve();
    dlg.showModal();
  });
}
export function projectOf(a) { return projects.find(p => p.id === (a?.project || '')); }

// --- filters ---
search.oninput = () => { filters.query = search.value.trim().toLowerCase(); render(); };
chipFavorites.onclick = () => { filters.favorites = !filters.favorites; render(); };
chipArchived.onclick = () => { filters.archived = !filters.archived; filters.trash = false; selection.clear(); render(); };
chipTrash.onclick = () => { filters.trash = !filters.trash; if (filters.trash) filters.archived = false; selection.clear(); render(); };
chipBoard.onclick = () => {
  // the coverage board is a project's list of needed animations: with All projects there is none to show
  if (!filters.board && !projects.some(p => p.id === filters.project)) { setStatus('The board belongs to a project: pick one in the list above, then Board shows which of its animations are done.'); return; }
  filters.board = !filters.board; if (!filters.board) filters.tag = ''; render();
};
$('#editSlots').onclick = async () => {
  const project = projects.find(p => p.id === filters.project); if (!project) { setStatus('Pick a project first.'); return; }
  const dlg = $('#slotsDialog'), text = $('#slotsText');
  text.value = (project.slots || []).join('\n');
  dlg.querySelector('.ok').onclick = async e => {
    e.preventDefault(); dlg.close();
    try { await api('PATCH', `/api/projects/${project.id}`, { slots: text.value.split('\n').map(x => x.trim()).filter(Boolean) }); await loadProjects(); render(); } catch (err) { setStatus(err.message, 'error'); }
  };
  dlg.querySelector('.cancel').onclick = e => { e.preventDefault(); dlg.close(); };
  dlg.showModal();
};
function renderBoard() {
  const project = projects.find(p => p.id === filters.project);
  board.hidden = !filters.board || !project;
  if (board.hidden) return;
  const slots = project.slots || [];
  const inProject = animations.filter(a => !a.archived && (a.project || '') === project.id);
  slotsEl.replaceChildren(...slots.map(slot => {
    const clips = inProject.filter(a => (a.tags || []).includes(slot));
    const approved = clips.some(a => a.favorite);
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'slot' + (clips.length ? ' filled' : '') + (approved ? ' approved' : '') + (filters.tag === slot ? ' on' : '');
    b.innerHTML = `${esc(slot)}<b>${approved ? '★' : clips.length || '–'}</b>`;
    b.title = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'}${approved ? ', approved' : ''}` : 'nothing yet';
    b.onclick = () => { filters.tag = filters.tag === slot ? '' : slot; render(); };
    return b;
  }));
  if (!slots.length) slotsEl.textContent = 'No list yet. Edit list… and add one tag per animation the game needs.';
  const done = slots.filter(slot => inProject.some(a => (a.tags || []).includes(slot) && a.favorite)).length;
  $('#chipBoard').textContent = slots.length ? `Board ${done}/${slots.length}` : 'Board';
}

function visible() {
  return animations.filter(a => {
    if (!!a.trashed !== filters.trash) return false;
    if (!filters.trash && !!a.archived !== filters.archived) return false;
    if (filters.project !== 'all' && (a.project || '') !== filters.project) return false;
    if (filters.project !== 'all' && filters.folder && !inFolder(a.folder, filters.folder)) return false;
    if (filters.favorites && !a.favorite) return false;
    if (filters.tag && !(a.tags || []).includes(filters.tag)) return false;
    if (filters.query) {
      const hay = `${a.name || ''} ${a.prompt} ${a.id} ${a.model || ''} ${a.seed} ${(a.tags || []).join(' ')}`.toLowerCase();
      if (!filters.query.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
}

// --- rendering ---
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtM = v => v >= 10 ? v.toFixed(0) : v.toFixed(1);
function badges(a, isActive = false) {
  const out = [];
  if (isActive) out.push(['on-stage', 'on stage']);
  if (a.takes > 1) out.push(['take', `take ${a.take}/${a.takes}`]);
  if (a.lineage?.keeps?.length) out.push(['take', a.lineage.free ? `iterated · frames ${a.lineage.free[0] + 1}–${a.lineage.free[1] + 1} new` : `iterated · ${a.lineage.keeps.length} keep${a.lineage.keeps.length === 1 ? '' : 's'}`]);
  const m = a.metrics;
  if (m) {
    out.push(['', `${m.seconds.toFixed(1)} s`]);
    if (m.path_m >= 0.3) out.push(['', `${fmtM(m.distance_m)} m · ${m.avg_speed.toFixed(1)} m/s`]);
    else out.push(['', 'in place']);
    const flags = (m.flags || []).filter(f => !(f === 'unsettled_start' && a.starts_moving));
    const clipShort = `${!flags.includes('hand_head') && m.clip_pairs?.some(p => / hand × head$/.test(p.pair)) ? 'hand in head · ' : ''}self-clip ${Math.round(m.self_clip * 100)}%`;
    const clipDetail = m.clip_pairs?.length ? ` (${m.clip_pairs.map(p => `${p.pair} ${Math.round(p.share * 100)}%`).join(', ')})` : m.clip_pair ? ` (${m.clip_pair})` : '';
    const labelOf = (f, full) => ({ skate: `foot slide ${Math.round(m.foot_skate * 100)}%`, floor: `through floor ${Math.round(-m.floor_m * 100)} cm`, jitter: 'jitter', hand_head: `hand in face ${Math.round(m.hand_head * 100) || '<1'}%${full ? ' of frames' : ''}`, hover: `ends in the air ${Math.round((m.hover_m || 0) * 100)} cm`, ballistic: `floaty jump${full ? ` (${Math.round((m.ballistic_m || 0) * 100)} cm off gravity)` : ''}`, clip: clipShort + (full ? clipDetail : ''), unsettled_start: 'starts mid-motion', unsettled_end: 'ends mid-motion', slide: `slides ${Math.round((m.slide_m || 0) * 100)} cm`, pivot: `spins ${Math.round(m.pivot_deg || 0)}°`, action: 'move not performed' }[f] || f.replace(/_/g, ' '));
    if (!flags.length) {
      out.push(['good', isActive ? 'clean' + (a.hand_fixes ? ` · hands kept out of the face on ${a.hand_fixes} frames` : '') + (a.ground_fixes ? ` · hands planted on ${a.ground_fixes} frames` : '') + (a.floor_fixes ? ` · feet grounded on ${a.floor_fixes} frames` : '') : 'clean']);
    } else if (isActive) {
      for (const f of flags) out.push(['warn', labelOf(f, true)]);
    } else if (flags.length === 1) {
      out.push(['warn', labelOf(flags[0], false), labelOf(flags[0], true)]);
    } else {
      out.push(['warn', `${flags.length} issues`, flags.map(f => labelOf(f, true)).join(' · ')]);
    }
  }
  return out.map(([cls, text, tip]) => `<span class="badge ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(text)}</span>`).join('');
}
function meta(a) {
  // people read frames and seconds; seed, steps and model stay on the card's tooltip (agents read them from the API)
  const parts = [a.status === 'ready' ? '' : a.status, `${a.frames} frames`];
  if (filters.project === 'all') parts.push(locationName(a.project || '', a.folder));
  else if (a.folder && a.folder !== filters.folder) parts.push(a.folder);
  if (a.constraints?.length) parts.push(`${a.constraints.length} keyframe${a.constraints.length === 1 ? '' : 's'}`);
  return parts.filter(Boolean).join(' · ');
}
// Rebuild the list only when what it shows has changed; a poll that changes
// nothing must not touch the DOM (it would reset scroll and jump under the user).
let lastSignature = '';
export function render(force = false) {
  renderFolders();
  renderBoard();
  const body = items.closest('.dock-body');
  const itemScroll = items.scrollTop, bodyScroll = body ? body.scrollTop : 0;
  const result = renderList(force);
  if (result === 'rebuilt') {
    items.scrollTop = itemScroll;
    if (body) body.scrollTop = bodyScroll;
  }
}
function renderList(force) {
  chipFavorites.classList.toggle('on', filters.favorites);
  chipArchived.classList.toggle('on', filters.archived); chipTrash.classList.toggle('on', filters.trash);
  const trashed = animations.filter(a => a.trashed).length; chipTrash.textContent = trashed ? `Trash (${trashed})` : 'Trash';
  $('#bulkTrashRestore').hidden = !filters.trash; $('#bulkDeleteForever').hidden = !filters.trash; $('#emptyTrash').hidden = !filters.trash || !trashed; $('#bulkDelete').hidden = filters.trash;
  // takes of one generation together, in take order, where the first of them falls in the list
  const list = (() => { const v = visible(), seen = new Map(), out = [];
    for (const a of v) { const k = a.batch && a.takes > 1 ? a.batch : a.id; if (!seen.has(k)) { seen.set(k, []); out.push(seen.get(k)); } seen.get(k).push(a); }
    return out.flatMap(g => g.length > 1 ? g.sort((x, y) => (x.take || 0) - (y.take || 0)) : g); })();
  const totalInBucket = animations.filter(a => !a.trashed && !!a.archived === filters.archived).length;
  countText.textContent = filters.trash ? `${list.length} in the Trash` : `${list.length === totalInBucket ? `${list.length} clip${list.length === 1 ? '' : 's'}` : `${list.length} of ${totalInBucket}`}${filters.archived ? ' archived' : ''} · newest first`;
  for (const id of [...selection]) if (!list.some(a => a.id === id)) selection.delete(id);
  bulk.hidden = selection.size === 0; bulkCount.textContent = `${selection.size} selected`;
  selectAll.checked = list.length > 0 && list.every(a => selection.has(a.id));
  selectAll.indeterminate = selection.size > 0 && !selectAll.checked;
  $('#bulkArchive').hidden = filters.archived; $('#bulkRestore').hidden = !filters.archived;
  const signature = JSON.stringify([filters, selected?.id, [...selection], list.map(a => [a.id, a.status, a.frames, a.edits, a.name, a.favorite, a.archived, a.project, a.folder, a.tags, a.take, a.takes, a.metrics?.flags, a.metrics?.distance_m, a.error, a.progress, a.trashed, a.edits, a.verdict, (a.hand_track || []).length])]);
  if (!force && signature === lastSignature) return 'kept';
  lastSignature = signature;
  if (!list.length) { items.textContent = filters.archived ? 'Nothing archived.' : animations.length ? 'No clips match.' : 'No clips yet. Describe a motion and generate one.'; return 'rebuilt'; }
  // takes of one generation sit together as one card: the first carries the title, the rest only their take
  const sameBatch = (x, y) => x && y && x.batch && x.batch === y.batch && x.takes > 1;
  items.replaceChildren(...list.map((a, i) => {
    const row = document.createElement('div');
    const follow = sameBatch(list[i - 1], a), lead = !follow && sameBatch(a, list[i + 1]);
    row.className = 'item ' + a.status + (selected?.id === a.id ? ' active' : '') + (selection.has(a.id) ? ' checked' : '') + (follow ? ' take-follow' : '') + (lead ? ' take-lead' : '') + (follow && !sameBatch(a, list[i + 1]) ? ' take-last' : '');
    row.innerHTML = `<label class="pick"><input type="checkbox" ${selection.has(a.id) ? 'checked' : ''}></label>
      <button type="button" class="open" title="${esc(`seed ${a.seed} · ${a.diffusion_steps} steps · ${a.model || ''}`)}" ${a.status !== 'ready' ? 'disabled' : ''}>
        ${a.status === 'ready' && a.kind !== 'blank' ? `<img class="thumb" alt="" loading="lazy" decoding="async" src="/api/animations/${a.id}/thumb.png?v=${a.frames}-${a.edits || 0}">` : ''}
        <p class="title">${esc(titleOf(a))}</p>${a.name ? `<p class="prompt">${esc(a.prompt)}</p>` : ''}
        <span class="status">${esc(meta(a))}</span>${a.error ? `<div class="error">${esc(a.error)}</div>` : ''}
        <div class="badges">${badges(a, selected?.id === a.id)}</div>
        ${a.tags?.length ? `<div class="tags">${a.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      </button>
      <button type="button" class="star ${a.favorite ? 'on' : ''}" title="${a.favorite ? 'Unfavorite' : 'Favorite'}">★</button>
      <button type="button" class="more" title="More">⋯</button>`;
    row.querySelector('.pick input').onchange = e => { e.target.checked ? selection.add(a.id) : selection.delete(a.id); render(); };
    row.querySelector('.open').onclick = () => select(a, { fromList: true });
    row.querySelector('.star').onclick = async () => { try { await patch(a.id, { favorite: !a.favorite }); await refresh(); } catch (e) { setStatus(e.message, 'error'); } };
    row.querySelector('.more').onclick = e => openMenu(a, e.currentTarget);
    return row;
  }));
  return 'rebuilt';
}

// --- per-clip actions ---
async function rename(a) {
  const name = await ask('Name this clip', 'Shown instead of the prompt. Leave empty to clear.', a.name || '');
  if (name === null) return;
  try { await patch(a.id, { name }); await refresh(); } catch (e) { setStatus(e.message, 'error'); }
}
async function move(ids) {
  const options = [{ value: '|', label: 'Inbox' }];
  for (const p of projects) {
    options.push({ value: `${p.id}|`, label: p.name });
    for (const f of p.folders || []) options.push({ value: `${p.id}|${f}`, label: `${p.name} › ${f.replaceAll('/', ' › ')}` });
  }
  const to = await choose('Move to', `${ids.length} clip${ids.length === 1 ? '' : 's'}`, options, `${currentProject()}|${currentFolder()}`);
  if (to === null) return;
  const [project, folder] = to.split('|');
  try { await batch(ids, { patch: { project, folder } }); selection.clear(); await refresh(); } catch (e) { setStatus(e.message, 'error'); }
}
async function archive(ids, archived) {
  try { await batch(ids, { patch: { archived } }); selection.clear(); await refresh(); setStatus(`${ids.length} clip${ids.length === 1 ? '' : 's'} ${archived ? 'archived' : 'restored'}`); }
  catch (e) { setStatus(e.message, 'error'); }
}
// Delete = to the Trash (files kept, restorable). Only the Trash view deletes for good.
async function destroy(ids) {
  const n = ids.length;
  if (n > 1 && !await confirm('Move to Trash', `Move ${n} clips to the Trash? They stay restorable until the Trash is emptied.`, 'Move to Trash')) return;
  try { await batch(ids, { delete: true }); selection.clear(); if (selected && ids.includes(selected.id)) selected = null; await refresh(); setStatus(`${n} clip${n === 1 ? '' : 's'} moved to the Trash.`); }
  catch (e) { setStatus(e.message, 'error'); }
}
async function restoreFromTrash(ids) {
  try { await batch(ids, { patch: { trashed: false } }); selection.clear(); await refresh(); setStatus(`${ids.length} clip${ids.length === 1 ? '' : 's'} restored.`); }
  catch (e) { setStatus(e.message, 'error'); }
}
async function destroyForever(ids) {
  if (!await confirm('Delete forever', `Delete ${ids.length} clip${ids.length === 1 ? '' : 's'} and their files for good? This cannot be undone.`, 'Delete forever', true)) return;
  try { await batch(ids, { delete: true, permanent: true }); selection.clear(); if (selected && ids.includes(selected.id)) selected = null; await refresh(); }
  catch (e) { setStatus(e.message, 'error'); }
}
async function emptyTrash() {
  const n = animations.filter(a => a.trashed).length;
  if (!await confirm('Empty the Trash', `Delete all ${n} clips in the Trash and their files for good?`, 'Empty Trash', true)) return;
  try { await api('POST', '/api/trash/empty', {}); selection.clear(); await refresh(); }
  catch (e) { setStatus(e.message, 'error'); }
}
async function derive(a, body) {
  try { const made = await api('POST', `/api/animations/${a.id}/derive`, body); await refresh(); select(find(made.id)); setStatus(`Made “${titleOf(made)}”.`); }
  catch (e) { setStatus(e.message, 'error'); }
}
function openMenu(a, anchor) {
  const actions = [
    ['Rename', () => rename(a)],
    ['Tags…', async () => { const v = await ask('Tags', 'Comma-separated. Match the coverage board\'s slot names, e.g. idle, walk_forward.', (a.tags || []).join(', ')); if (v !== null) { try { await patch(a.id, { tags: v.split(',').map(x => x.trim()).filter(Boolean) }); await refresh(); } catch (e) { setStatus(e.message, 'error'); } } }],
    ['Move to project…', () => move([a.id])],
    [a.favorite ? 'Unfavorite' : 'Favorite', () => patch(a.id, { favorite: !a.favorite }).then(refresh)],
    [a.archived ? 'Restore' : 'Archive', () => archive([a.id], !a.archived)],
    ...(a.lineage?.parent && find(a.lineage.parent) ? [['Open the clip it was iterated from', () => select(find(a.lineage.parent))]] : []),
    ['Continue from this clip', () => { select(a); setTimeout(() => document.querySelector('#continueFrom').click(), 400); }],
    ['More like this', () => { select(a); setTimeout(() => document.querySelector('#moreLikeThis').click(), 400); }],
    ['Compare with the clip on screen (ghost)', () => window.setGhostClip?.(a)],
    ['Use as an actor…', () => window.sceneAssign?.(a)],
    ['Mirror (left ↔ right)', () => derive(a, { op: 'mirror' })],
    ['Retime…', async () => { const v = await ask('Retime', 'Speed factor: 2 = twice as fast (half the frames), 0.5 = half speed. 0.25–4.', '1.5'); if (v) derive(a, { op: 'retime', speed: Number(v) }); }],
    ['Copy link', () => navigator.clipboard.writeText(`${location.origin}/#a=${a.id}`)],
    ['Share (save a .understudy file)…', () => sharePack(a)],
    ['Browse shared animations', () => window.open('/static/browse.html', '_blank')],
    ...(a.trashed ? [['Restore from Trash', () => restoreFromTrash([a.id])], ['Delete forever', () => destroyForever([a.id]), 'danger']] : [['Move to Trash', () => destroy([a.id]), 'danger']]),
  ];
  menu.replaceChildren(...actions.map(([label, fn, cls]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.onclick = () => { closeMenu(); fn(); }; return b; }));
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
  setTimeout(() => document.addEventListener('pointerdown', closeMenuOutside));
}
function closeMenu() { menu.hidden = true; document.removeEventListener('pointerdown', closeMenuOutside); }
// a press outside the menu closes it; a press on an item must not (closing on any press hid the item before its click
// could fire: with a real mouse no ⋯ item did anything)
function closeMenuOutside(e) { if (!menu.contains(e.target)) closeMenu(); }
// Share: one clip as a .understudy file anyone can open in the Browse page (static/browse.html) and add to their library.
// The server refuses clips from a research-only model (share.go). The author's name is remembered for next time.
export async function sharePack(a) {
  let prev = ''; try { prev = localStorage.getItem('understudy.author') || ''; } catch {}
  const author = await ask('Share this clip', 'Your name or handle, shown on the shared clip (optional).', prev);
  if (author === null) return;
  try { localStorage.setItem('understudy.author', author.trim()); } catch {}
  const r = await fetch(`/api/animations/${a.id}/pack?author=${encodeURIComponent(author.trim())}`);
  if (!r.ok) { setStatus(await r.text(), 'error'); return; }
  const blob = await r.blob(), link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = `${(titleOf(a) || 'clip').replace(/[^\w\- ]+/g, '').trim() || 'clip'}.understudy`; link.click();
  setStatus(`Saved “${link.download}”. Anyone can open it in Browse shared animations (in this menu) and add it to their library.`);
}

// --- bulk bar ---
$('#bulkArchive').onclick = () => archive([...selection], true);
$('#bulkRestore').onclick = () => archive([...selection], false);
$('#bulkMove').onclick = () => move([...selection]);
$('#bulkStar').onclick = () => batch([...selection], { patch: { favorite: true } }).then(() => { selection.clear(); refresh(); });
$('#bulkTag').onclick = async () => { const v = await ask('Tag selected clips', 'Comma-separated tags to set on all of them.'); if (v !== null) { try { await batch([...selection], { patch: { tags: v.split(',').map(x => x.trim()).filter(Boolean) } }); selection.clear(); await refresh(); } catch (e) { setStatus(e.message, 'error'); } } };
$('#bulkDelete').onclick = () => destroy([...selection]);
$('#bulkTrashRestore').onclick = () => restoreFromTrash([...selection]);
$('#bulkDeleteForever').onclick = () => destroyForever([...selection]);
$('#emptyTrash').onclick = emptyTrash;
$('#bulkClear').onclick = () => { selection.clear(); render(); };
const selectAll = $('#selectAll');
selectAll.onchange = () => { if (selectAll.checked) for (const a of visible()) selection.add(a.id); else selection.clear(); render(); };
export function toggleAll() { selectAll.checked = !selectAll.checked; selectAll.onchange(); }
export function clearSelection() { selection.clear(); closeMenu(); render(); }
// nothing on the stage (the cards lose their highlight; callers clear the viewer)
export function deselect() { selected = null; selection.clear(); closeMenu(); render(); }

// --- status / progress ---
let toastTimer = null;
export function setStatus(text, kind = 'readout') {
  status.className = kind; status.textContent = text;
  // float over the stage on errors, progress while generating/editing, or when the left dock (#status) is collapsed
  const t = document.querySelector('#toast'); if (!t) return;
  if (!/error|progress/.test(kind) && !document.querySelector('#dockLeft')?.classList.contains('collapsed')) { t.classList.remove('show'); return; }
  t.textContent = text; t.hidden = false; t.className = 'toast show' + (/error/.test(kind) ? ' error' : /progress/.test(kind) ? ' progress' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.classList.remove('show'); }, /progress/.test(kind) ? 2500 : 4000);
}
// Pick the take that does the move and finishes it, then the one with the fewest warnings, then the earliest seed.
const weight = a => (a.metrics?.flags || []).reduce((n, f) => n + (f === 'action' || f === 'unsettled_end' ? 100 : 1), 0);
export function bestOf(list) {
  const ready = list.filter(a => a.status === 'ready');
  return ready.sort((a, b) => weight(a) - weight(b) || (a.take ?? 0) - (b.take ?? 0))[0] || null;
}
function showProgress() {
  if (!activeRequests.size) return;
  const mine = animations.filter(a => activeRequests.has(a.id));
  const done = mine.filter(a => a.status === 'ready' || a.status === 'failed');
  if (done.length === activeTotal) {
    const failed = done.filter(a => a.status === 'failed');
    const best = bestOf(done);
    activeRequests.clear(); generate.disabled = false;
    if (best) select(best);
    if (failed.length === done.length) setStatus(`Generation failed: ${failed[0].error}`, 'error');
    else setStatus(activeTotal === 1 ? 'Done.' : `${done.length - failed.length} takes ready${failed.length ? `, ${failed.length} failed` : ''}. Showing the cleanest.`);
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - activeStarted) / 1000));
  const running = mine.some(a => a.status === 'running');
  setStatus(activeTotal === 1 ? `${running ? 'Generating' : 'Queued'}… ${seconds}s` : `Take ${done.length + 1} of ${activeTotal}… ${seconds}s`, 'readout progress');
  generate.disabled = true;
}
let lastListText = '';
export async function refresh() {
  const [listResponse, projectList] = await Promise.all([fetch('/api/animations'), api('GET', '/api/projects')]);
  if (!listResponse.ok) throw new Error(await listResponse.text());
  const listText = await listResponse.text();
  // The list is polled every 2.5 s. Unchanged (the usual case), it is not parsed or rendered again: parsing 1.8 MB
  // and rebuilding the board took ~70 ms on the main thread, four dropped frames at 60 Hz, a visible hitch in every
  // clip playing on the stage.
  if (listText === lastListText && JSON.stringify(projectList) === JSON.stringify(projects)) { showProgress(); return; }
  lastListText = listText;
  const list = JSON.parse(listText);
  // Stable order whatever the server does: newest real clips first (parsed timestamp so fractional seconds / offsets never mis-order), untouched blank T-pose last, ties by id.
  const isUntouchedBlank = a => a?.kind === 'blank' && !(a?.edits > 0) && !(a?.layer?.keys?.length > 0);
  const stampOf = a => { const t = Date.parse(a?.created_at || ''); return Number.isFinite(t) ? t : 0; };
  animations = list.sort((a, b) => (isUntouchedBlank(a) - isUntouchedBlank(b)) || (stampOf(b) - stampOf(a)) || (b.created_at > a.created_at) - (b.created_at < a.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (JSON.stringify(projectList) !== JSON.stringify(projects)) { projects = projectList; await loadProjects(); }
  if (selected) selected = animations.find(a => a.id === selected.id) || selected;
  render();
  showProgress();
}
export async function submit(bodies) {
  generate.disabled = true;
  setStatus('Submitting…', 'readout progress');
  activeRequests.clear(); activeTotal = bodies.length; activeStarted = Date.now();
  try {
    for (const body of bodies) { const a = await api('POST', '/api/generate', body); activeRequests.add(a.id); }
    await refresh();
  } catch (e) { setStatus(e.message, 'error'); if (!activeRequests.size) generate.disabled = false; }
}
