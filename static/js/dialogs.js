// Small modal prompts: a text answer, a choice from a list, a yes/no.
const dialog = document.querySelector('#promptDialog');
const title = dialog.querySelector('h2'), text = dialog.querySelector('.text'), input = dialog.querySelector('input'), select = dialog.querySelector('select');
const ok = dialog.querySelector('.ok'), cancel = dialog.querySelector('.cancel');

function run(setup) {
  return new Promise(resolve => {
    input.hidden = true; select.hidden = true; ok.classList.remove('danger'); ok.textContent = 'OK';
    setup();
    const finish = value => { dialog.close(); ok.onclick = cancel.onclick = null; dialog.onclose = null; resolve(value); };
    ok.onclick = e => { e.preventDefault(); finish(!input.hidden ? input.value.trim() : !select.hidden ? select.value : true); };
    cancel.onclick = e => { e.preventDefault(); finish(null); };
    dialog.onclose = () => finish(null);
    dialog.showModal();
    if (!input.hidden) { input.focus(); input.select(); }
  });
}

export const ask = (heading, message, value = '') => run(() => { title.textContent = heading; text.textContent = message; input.hidden = false; input.value = value; });
export const choose = (heading, message, options, value = '') => run(() => {
  title.textContent = heading; text.textContent = message; select.hidden = false;
  select.replaceChildren(...options.map(o => { const el = document.createElement('option'); el.value = o.value; el.textContent = o.label; return el; }));
  select.value = value;
});
export const confirm = (heading, message, button = 'OK', danger = false) => run(() => {
  title.textContent = heading; text.textContent = message; ok.textContent = button; ok.classList.toggle('danger', danger);
});
