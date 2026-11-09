// The left dock's workflow tabs (index.html): Make (Describe it / From poses) and Share (export, Unreal, share packs).
// The chosen tab and Make page are remembered in this browser. The checks and their fixes float on the stage's right
// edge (#stageFixes): shown while a clip with checks is on the stage, foldable to its header.
import * as library from './library.js';
import * as viewer from './viewer.js';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = k => { try { return localStorage.getItem(k); } catch { return null; } };

export function showFlow(name) {
  for (const t of $$('.flow-tab')) { const on = t.dataset.flow === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); }
  for (const p of $$('.flow-page')) p.hidden = p.dataset.flow !== name;
  remember('understudy.flow', name);
  syncTabFixesFold();
}
export function showMake(name) {
  for (const t of $$('.make-opt')) t.classList.toggle('on', t.dataset.make === name);
  for (const p of $$('.make-page')) p.hidden = p.dataset.make !== name;
  remember('understudy.make', name);
  syncTabFixesFold();
}
for (const t of $$('.flow-tab')) t.addEventListener('click', () => showFlow(t.dataset.flow));
for (const t of $$('.make-opt')) t.addEventListener('click', () => showMake(t.dataset.make));

// The checks panel on the stage: assistant.js fills #assistant (.issue items; .issue.good when clean). The header says
// how many problems there are; folded, only the header shows. A clean clip folds it by itself; a clip with problems
// opens it, unless the person folded it on this clip or is working in a tab that needs the stage uncovered.
const assistant = $('#assistant'), panel = $('#stageFixes'), count = $('#fixCount'), toggle = $('#fixToggle');
let folded = recall('understudy.fixesFolded') === '1', foldedFor = null, lastClip = null, lastN = -1;
function rightTab() {
  const btn = document.querySelector('.tabs[data-dock="right"] button.on');
  if (btn) return btn.dataset.tab;
  try { return JSON.parse(localStorage.getItem('understudy.tabs') || '{}').right || 'library'; } catch { return 'library'; }
}
function tabWantsFixesFolded() {
  const flow = document.querySelector('.flow-tab.on')?.dataset.flow || 'make';
  const make = document.querySelector('.make-opt.on')?.dataset.make || 'describe';
  const right = rightTab();
  return flow === 'share' || (flow === 'make' && make === 'poses') || right === 'actors' || right === 'reference';
}
function setFolded(on, byHand) {
  folded = on; panel?.classList.toggle('folded', on); setTimeout(sideRoom, 0);
  if (toggle) { const closed = on || panel?.classList.contains('posing'); toggle.textContent = closed ? '+' : '–'; toggle.title = closed ? 'Show the checks and their fixes' : 'Fold the checks away (they stay one click from here)'; }
  if (byHand) { remember('understudy.fixesFolded', on ? '1' : '0'); foldedFor = on ? library.selected?.id : null; }
}
function syncTabFixesFold() {
  if (!panel || !assistant) return;
  if (tabWantsFixesFolded()) { setFolded(true, false); return; }
  const n = assistant.querySelectorAll('.issue:not(.good)').length;
  const clip = library.selected?.id;
  setFolded(n ? foldedFor === clip : true, false);
}
window.addEventListener('understudy:tab', e => { if (e.detail?.dock === 'right') syncTabFixesFold(); });
showFlow(recall('understudy.flow') === 'share' ? 'share' : 'make');
showMake(recall('understudy.make') === 'poses' ? 'poses' : 'describe');
function sideRoom() {
  // the card floats over the stage's right: on a stage narrower than 1200 px the figure moves left of it
  const view = $('#view'); if (!view || !panel) return;
  const open = !panel.hidden && !panel.classList.contains('folded') && !panel.classList.contains('posing');
  const w = view.getBoundingClientRect().width;
  // a posing-bar menu (More, Guards, Paste) opens right-aligned above the bar: the figure steps left of it too
  const menu = document.querySelector('#stageDock .popover:not([hidden])');
  viewer.setSideRoom(Math.max(open && w < 1200 ? Math.min(170, panel.getBoundingClientRect().width / 2 + 10) : 0, menu ? 200 : 0));
}
function syncExportChecks(n) {
  const nameEl = $('#exportClipName'), checksEl = $('#exportClipChecks'), a = library.selected;
  if (nameEl) {
    nameEl.textContent = a ? `“${library.titleOf(a)}” · ${(a.frames / 30).toFixed(1)} s` : 'No clip on the stage';
    nameEl.title = a ? library.titleOf(a) : '';
  }
  if (checksEl) {
    const show = !!a && a.kind !== 'blank' && !assistant?.hidden && n > 0;
    checksEl.hidden = !show;
    if (show) checksEl.textContent = `Checks: ${n} to fix — see the Checks panel`;
  }
}
$('#exportClipChecks')?.addEventListener('click', () => {
  if (panel?.classList.contains('posing')) panel.classList.remove('posing');
  setFolded(false, true);
});
function updateFixes() {
  if (!panel || !assistant) return;
  panel.hidden = assistant.hidden;
  setTimeout(sideRoom, 0);
  const n = assistant.querySelectorAll('.issue:not(.good)').length;
  if (count) { count.textContent = n ? `${n} to fix` : 'clean'; count.classList.toggle('bad', !!n); }
  syncExportChecks(n);
  // per clip: open when it has problems, folded when clean; decided again when the checks arrive after the clip (they
  // load a moment later), never against a fold made by hand on this clip
  const clip = library.selected?.id, had = lastClip === clip ? lastN : -1;
  if (clip !== lastClip || (had === 0 && n > 0)) setFolded(n && !tabWantsFixesFolded() ? foldedFor === clip : true, false);
  lastClip = clip; lastN = n;
}
toggle?.addEventListener('click', () => { if (panel?.classList.contains('posing')) { panel.classList.remove('posing'); setFolded(false, false); return; } const isFolded = panel?.classList.contains('folded') ?? folded; setFolded(!isFolded, true); });
// while posing with Handles or drawing a Path (or with Keep/Box open) the panel folds to its header, out of the way (+ still opens it)
const handlesButton = $('#handles'), pathButton = $('#pathTool');
// … and while the Keep, Path or Box bar is open (two floating panels over the figure crushed each other)
const stageDock = document.querySelector('#stageDock');
// a posing-bar menu grows upward from the bar: it gets the room between the bar and the view buttons, then scrolls
function fitMenus() {
  const stage = document.querySelector('.stage-canvases'); if (!stage || !stageDock) return;
  for (const pop of stageDock.querySelectorAll('.popover:not([hidden])')) {
    if (pop.parentElement?.closest('#poseMorePanel')) continue;
    const bar = pop.closest('.pose-bar, .handle-bar') || stageDock;
    const mh = Math.max(160, Math.round(bar.getBoundingClientRect().top - stage.getBoundingClientRect().top - 56)) + 'px';
    if (pop.style.maxHeight !== mh) pop.style.maxHeight = mh;
  }
}
window.addEventListener('resize', fitMenus);
const dockBusy = () => !!stageDock && [...stageDock.children].some(el => !el.hidden && el.offsetParent !== null && el.id !== 'handleBar');
const stageToolBusy = () => !!(handlesButton?.classList.contains('on') || pathButton?.classList.contains('on') || dockBusy());
const syncPosingFold = () => {
  if (!panel) return;
  const on = stageToolBusy();
  if (panel.classList.contains('posing') !== on) panel.classList.toggle('posing', on);
  if (toggle) toggle.textContent = on || panel.classList.contains('folded') ? '+' : '–';
  sideRoom();
};
if (stageDock && panel) new MutationObserver(() => { syncPosingFold(); fitMenus(); }).observe(stageDock, { attributes: true, subtree: true, attributeFilter: ['hidden', 'class', 'style', 'open'] });
if (handlesButton && panel) new MutationObserver(syncPosingFold).observe(handlesButton, { attributes: true, attributeFilter: ['class'] });
if (pathButton && panel) new MutationObserver(syncPosingFold).observe(pathButton, { attributes: true, attributeFilter: ['class'] });
if (panel) new MutationObserver(() => { folded = panel.classList.contains('folded'); if (toggle) toggle.textContent = folded || panel.classList.contains('posing') ? '+' : '–'; sideRoom(); }).observe(panel, { attributes: true, attributeFilter: ['class'] });
panel?.querySelector('.sf-head')?.addEventListener('dblclick', () => setFolded(!panel.classList.contains('folded'), true));
if (assistant) new MutationObserver(updateFixes).observe(assistant, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
setFolded(folded || tabWantsFixesFolded(), false); updateFixes();

// Dock scroll cues & auto-reveal when left-panel drawers expand below the fold.
for (const dock of $$('.dock')) {
  const body = dock.querySelector('.dock-body');
  if (!body) continue;
  const itemsEl = dock.id === 'dockRight' ? dock.querySelector('#items') : null;
  const scroller = () => (itemsEl && !itemsEl.closest('.page')?.hidden) ? itemsEl : body;
  const syncScroll = () => {
    if (dock.classList.contains('collapsed')) { dock.classList.remove('can-scroll-up', 'can-scroll-down'); return; }
    const s = scroller();
    dock.classList.toggle('can-scroll-up', s.scrollTop > 6);
    dock.classList.toggle('can-scroll-down', s.scrollHeight - s.scrollTop - s.clientHeight > 6);
  };
  body.addEventListener('scroll', syncScroll, { passive: true });
  itemsEl?.addEventListener('scroll', syncScroll, { passive: true });
  new ResizeObserver(syncScroll).observe(body);
  if (itemsEl) new ResizeObserver(syncScroll).observe(itemsEl);
  new MutationObserver(() => requestAnimationFrame(syncScroll)).observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'class'] });
  new MutationObserver(syncScroll).observe(dock, { attributes: true, attributeFilter: ['class'] });
  requestAnimationFrame(syncScroll);
}

// Left-dock <details class="card"> drawers (#guideCard, #advancedCard, etc.): when opened below the fold,
// scroll #dockLeft .dock-body so the newly opened drawer comes cleanly into view instead of opening off-screen.
{
  const leftBody = document.querySelector('#dockLeft .dock-body');
  if (leftBody) {
    const wasOpen = new WeakMap();
    const revealIfOpened = d => {
      const prev = wasOpen.get(d);
      wasOpen.set(d, d.open);
      if (prev === undefined || prev || !d.open || !d.offsetParent) return;
      requestAnimationFrame(() => {
        if (!d.open || !d.offsetParent) return;
        const br = leftBody.getBoundingClientRect(), dr = d.getBoundingClientRect();
        if (dr.bottom <= br.bottom - 8 && dr.top >= br.top) return;
        const topDelta = dr.top - br.top - 8;
        const bottomDelta = dr.bottom - br.bottom + 12;
        const delta = dr.height > br.height - 20 ? topDelta : Math.max(0, bottomDelta);
        if (Math.abs(delta) > 2) leftBody.scrollTop += delta;
      });
    };
    for (const d of document.querySelectorAll('#dockLeft details.card')) {
      wasOpen.set(d, d.open);
      d.addEventListener('toggle', () => revealIfOpened(d));
      new MutationObserver(() => revealIfOpened(d)).observe(d, { attributes: true, attributeFilter: ['open'] });
    }
  }
}

// Share: the clip on stage as a .understudy file; the Browse page
$('#sharePackButton')?.addEventListener('click', () => {
  const a = library.selected; if (!a) { library.setStatus('Pick a clip in the Library first.', 'error'); return; }
  library.sharePack(a);
});
$('#browseSharedButton')?.addEventListener('click', () => window.open('/static/browse.html', '_blank'));

// A tool bar floating over the bottom of the stage lifts the figure by its height, so the feet stay in view.
{
  const dock = $('#stageDock');
  const view = $('#view');
  const fit = () => {
    const shown = dock && view && [...dock.children].some(b => !b.hidden);
    if (!shown) { viewer.setLift(0); return; }
    // the floor under the figure (78% down the stage) goes to 60 px above the bar's top; no lift when it already is
    const c = view.getBoundingClientRect(), barTop = dock.getBoundingClientRect().top - c.top;
    viewer.setLift(Math.max(0, c.height * .78 - (barTop - 60)));
  };
  if (dock) { new MutationObserver(fit).observe(dock, { subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] }); new ResizeObserver(fit).observe(dock); }
}

window.addEventListener('resize', () => setTimeout(sideRoom, 50));
