// Takes: the other takes of the clip on the stage, as a strip of thumbnails
// above the timeline (each take's pose at the current frame; click to switch),
// and the Franken-take dialog that stacks a range from each take into the next
// generation's keeps.
import * as viewer from './viewer.js';
import * as library from './library.js';
import * as compose from './compose.js';
import * as keep from './keep.js';

const $ = s => document.querySelector(s);
const strip = $('#takesStrip');
const THUMB_W = 68, THUMB_H = 48;
let builtKey = '', thumbs = new Map(), streams = new Map();

export function takesOf(a) {
  if (!a?.batch) return [a].filter(Boolean);
  return library.animations.filter(c => c.batch === a.batch && !c.trashed).sort((p, q) => (p.take || 0) - (q.take || 0));
}
const FLAG_WORD = { slide: 'slide', pivot: 'spins', skate: 'slide', floor: 'floor', jitter: 'jitter', clip: 'clip', hand_head: 'hand in face', hover: 'in the air', ballistic: 'floaty', unsettled_start: 'starts moving', unsettled_end: 'ends moving', action: 'missed move', idle: 'idle' };
const flagWords = c => (c.metrics?.flags || []).map(x => FLAG_WORD[x] || x.replace(/_/g, ' '));
const flagText = c => { if (!c.metrics) return ''; const f = flagWords(c); return f.length ? f.join(', ') : 'clean'; };
// on a take card: at most two problems, then "+N" (the card is small; the full list is in its tooltip)
const flagShort = c => { const f = flagWords(c); return !c.metrics ? '' : !f.length ? 'clean' : f.slice(0, 2).join(', ') + (f.length > 2 ? ` +${f.length - 2}` : ''); };

// Joint positions of a take at a frame, straight from its streams (same FK as the stage).
function positionsOf(c, st, f) {
  const parents = viewer.skeleton.parents, offsets = viewer.skeleton.offsets, joints = parents.length;
  if (!st || !joints || st.rotations.length < (f + 1) * joints * 4) return null;
  f = Math.max(0, Math.min(c.frames - 1, f));
  const pos = [], glob = [];
  for (let j = 0; j < joints; j++) {
    const at = (f * joints + j) * 4, q = [st.rotations[at], st.rotations[at + 1], st.rotations[at + 2], st.rotations[at + 3]], p = parents[j];
    if (p < 0) { glob[j] = q; pos[j] = [st.root[f * 3], st.root[f * 3 + 1], st.root[f * 3 + 2]]; }
    else { glob[j] = viewer.multiply(glob[p], q); const o = viewer.rotate(glob[p], offsets[j]); pos[j] = [pos[p][0] + o[0], pos[p][1] + o[1], pos[p][2] + o[2]]; }
  }
  return pos;
}
// A small three-quarter stick figure of the take at the stage's frame, hips centred, feet on the floor line.
function paintThumb(c, canvas) {
  const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  if (canvas.width !== THUMB_W * dpr) { canvas.width = THUMB_W * dpr; canvas.height = THUMB_H * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, THUMB_W, THUMB_H);
  const st = streams.get(`${c.id}:${c.edits || 0}`);
  const pos = st ? positionsOf(c, st, viewer.state.frame) : null;
  const floor = THUMB_H - 5, s = 20; // px per metre
  ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.beginPath(); ctx.moveTo(4, floor + .5); ctx.lineTo(THUMB_W - 4, floor + .5); ctx.stroke();
  if (!pos) { ctx.fillStyle = 'rgba(255,255,255,.3)'; ctx.font = '500 9px "JetBrains Mono", monospace'; ctx.fillText(c.status === 'ready' ? '…' : c.status, 6, 14); return; }
  const cx = (pos[0][0] - pos[0][2]) * .707, parents = viewer.skeleton.parents;
  const P = p => [THUMB_W / 2 + ((p[0] - p[2]) * .707 - cx) * s, floor - p[1] * s];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 1; i < parents.length; i++) { const a = P(pos[i]), b = P(pos[parents[i]]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
  ctx.stroke();
  const head = viewer.skeleton.names.indexOf('Head');
  if (head >= 0) { const h = P(pos[head]); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(h[0], h[1] - 1.5, 2.6, 0, Math.PI * 2); ctx.fill(); }
}
function loadStreams(c) {
  const k = `${c.id}:${c.edits || 0}`;
  if (streams.has(k) || c.status !== 'ready') return;
  streams.set(k, null);
  viewer.streamsOf(c).then(st => { streams.set(k, st); paintAll(); }).catch(() => streams.delete(k));
}
let painting = false;
function paintAll() {
  if (strip.hidden || painting) return;
  painting = true;
  requestAnimationFrame(() => { painting = false; for (const [id, cv] of thumbs) { const c = library.find(id); if (c) paintThumb(c, cv); } });
}

export function render() {
  const a = viewer.state.animation; const takes = a ? takesOf(a) : [];
  strip.hidden = takes.length < 2;
  if (strip.hidden) { builtKey = ''; return; }
  const key = takes.map(c => `${c.id}:${c.status}:${flagText(c)}:${c.edits || 0}`).join('|') + '#' + a.id;
  if (key !== builtKey) {
    builtKey = key; thumbs = new Map();
    strip.replaceChildren(
      Object.assign(document.createElement('span'), { className: 'label', textContent: `${takes.length} takes` }),
      ...takes.map(c => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'take' + (c.id === a.id ? ' on' : '');
        const ft = flagText(c), cv = document.createElement('canvas');
        cv.width = THUMB_W; cv.height = THUMB_H; thumbs.set(c.id, cv);
        const num = document.createElement('span'); num.className = 'num'; num.innerHTML = `<b>Take ${c.take || '?'}</b>`;
        b.append(cv, num);
        const failed = c.status === 'failed' || !!c.error;
        if (c.status !== 'ready') b.append(Object.assign(document.createElement('span'), { className: 'hint' + (failed ? ' bad' : ''), textContent: failed ? 'failed' : c.status }));
        else if (ft) b.append(Object.assign(document.createElement('span'), { className: 'badge ' + (ft === 'clean' ? 'good' : 'warn'), textContent: flagShort(c) }));
        const more = c.error || (c.status !== 'ready' ? c.status : ft && ft !== 'clean' ? ft : '');   // the full text the card shortens
        b.title = [`Take ${c.take} · seed ${c.seed}${c.id === a.id ? ' (on the stage)' : ' · click to view'}`, more].filter(Boolean).join(String.fromCharCode(10));
        b.onclick = () => { if (c.status === 'ready' && c.id !== a.id) library.select(c, { frame: viewer.state.frame }); };
        loadStreams(c);
        return b;
      }),
      Object.assign(document.createElement('button'), { type: 'button', className: 'take franken', textContent: 'Mix takes…', title: 'Build the next clip from the best stretch of each take', onclick: openFranken }),
    );
  }
  paintAll();
}

async function openFranken() {
  const a = viewer.state.animation; if (!a) return;
  const takes = takesOf(a).filter(c => c.status === 'ready');
  const dlg = $('#frankenDialog'), rows = $('#frankenRows');
  rows.replaceChildren(...takes.map(c => {
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<label class="check"><input type="checkbox" data-id="${c.id}"> Take ${c.take || '?'}</label><span class="hint">${flagText(c)} · ${c.frames} f</span><label>from <input type="number" min="1" max="${c.frames}" value="1" data-from></label><label>to <input type="number" min="1" max="${c.frames}" value="${c.frames}" data-to></label><button type="button" class="chip" data-view>View</button>`;
    row.querySelector('[data-view]').onclick = () => library.select(c, { frame: 0 });
    return row;
  }));
  const update = () => { const n = [...rows.querySelectorAll('input[type=checkbox]:checked')].length; $('#frankenHint').textContent = n ? `${n} range${n === 1 ? '' : 's'} will be kept.` : 'Tick at least one take.'; };
  rows.oninput = update; update();
  dlg.querySelector('.cancel').onclick = () => dlg.close();
  dlg.querySelector('.ok').onclick = async () => {
    const picked = [...rows.querySelectorAll('.row')].filter(r => r.querySelector('input[type=checkbox]').checked);
    if (!picked.length) return;
    compose.restore(a);
    let n = 0;
    for (const r of picked) {
      const id = r.querySelector('input[type=checkbox]').dataset.id, c = library.find(id); if (!c) continue;
      const from = Math.max(0, Number(r.querySelector('[data-from]').value) - 1), to = Math.min(c.frames - 1, Number(r.querySelector('[data-to]').value) - 1);
      if (to < from) continue;
      const st = await viewer.streamsOf(c);
      compose.addKeyframe(keep.buildKeep(c, st.root, st.rotations, from, to, 'body', 6)); n++;
    }
    compose.newSeed(); compose.flash(); dlg.close();
    library.setStatus(`${n} range${n === 1 ? '' : 's'} from ${picked.length} take${picked.length === 1 ? '' : 's'} added as keeps. Press Generate.`);
  };
  dlg.showModal();
}
export function onClipChanged() { builtKey = ''; render(); }
viewer.onFrameChange(paintAll);
setInterval(render, 2500);
