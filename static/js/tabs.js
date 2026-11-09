// Dock tabs: each dock shows one page at a time; the choice is remembered.
const KEY = 'understudy.tabs';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }

export function showTab(dock, name) {
  const nav = document.querySelector(`.tabs[data-dock="${dock}"]`); if (!nav) return;
  const aside = nav.closest('.dock');
  if (![...nav.querySelectorAll('button')].some(b => b.dataset.tab === name && !b.hidden)) name = nav.querySelector('button:not([hidden])')?.dataset.tab;   // a removed tab falls back to the first
  if (!name) return;
  for (const b of nav.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const page of aside.querySelectorAll('.page')) page.hidden = page.dataset.page !== name;
  saved[dock] = name;
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {}
  window.dispatchEvent(new CustomEvent('understudy:tab', { detail: { dock, name } }));
}
for (const nav of document.querySelectorAll('.tabs')) {
  const dock = nav.dataset.dock;
  for (const b of nav.querySelectorAll('button')) b.onclick = () => showTab(dock, b.dataset.tab);
  showTab(dock, saved[dock] || nav.querySelector('button').dataset.tab);
}
window.showTab = showTab;
