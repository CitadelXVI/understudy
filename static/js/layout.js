// Docked panels: drag the dividers to resize, collapse to a strip, remembered per browser.
const layout = document.querySelector('#layout');
const KEY = 'understudy.layout';
const limits = { min: 260, max: 720 };
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }

const docks = {
  left: { el: document.querySelector('#dockLeft'), resizer: document.querySelector('#resizeLeft'), button: document.querySelector('#collapseLeft'), label: 'Compose', open: '‹', closed: '›', sign: 1 },
  right: { el: document.querySelector('#dockRight'), resizer: document.querySelector('#resizeRight'), button: document.querySelector('#collapseRight'), label: 'Library', open: '›', closed: '‹', sign: -1 },
};

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private window */ }
}
function apply(side) {
  const dock = docks[side];
  const collapsed = !!saved[`${side}Collapsed`];
  if (saved[`${side}Width`]) layout.style.setProperty(`--${side}`, `${saved[`${side}Width`]}px`);
  layout.classList.toggle(`${side}-collapsed`, collapsed);
  dock.el.classList.toggle('collapsed', collapsed);
  dock.el.dataset.label = dock.label;
  dock.button.textContent = collapsed ? dock.closed : dock.open;
  dock.button.title = collapsed ? `Expand ${dock.label}` : `Collapse ${dock.label}`;
}

for (const side of Object.keys(docks)) {
  const dock = docks[side];
  dock.button.onclick = () => { saved[`${side}Collapsed`] = !saved[`${side}Collapsed`]; save(); apply(side); };
  dock.resizer.addEventListener('pointerdown', e => {
    if (saved[`${side}Collapsed`]) return;
    e.preventDefault();
    try { dock.resizer.setPointerCapture(e.pointerId); } catch {}
    dock.resizer.classList.add('active'); layout.classList.add('dragging');
    const startX = e.clientX, startWidth = dock.el.getBoundingClientRect().width;
    const move = ev => {
      const width = Math.round(Math.max(limits.min, Math.min(limits.max, startWidth + (ev.clientX - startX) * dock.sign)));
      saved[`${side}Width`] = width; layout.style.setProperty(`--${side}`, `${width}px`);
    };
    const up = () => {
      dock.resizer.removeEventListener('pointermove', move); dock.resizer.removeEventListener('pointerup', up); dock.resizer.removeEventListener('pointercancel', up);
      dock.resizer.classList.remove('active'); layout.classList.remove('dragging'); save();
    };
    dock.resizer.addEventListener('pointermove', move); dock.resizer.addEventListener('pointerup', up); dock.resizer.addEventListener('pointercancel', up);
  });
  // Double-click a divider to return it to the default width.
  dock.resizer.addEventListener('dblclick', () => { delete saved[`${side}Width`]; layout.style.removeProperty(`--${side}`); save(); });
  apply(side);
}
