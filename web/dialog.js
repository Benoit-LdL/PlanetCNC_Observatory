// Material 3 dialogs in place of the browser's confirm(), prompt() and alert(), so the questions
// look like the rest of the app (style.css: .m3-dlg). Each returns a promise:
//   ask({title, text, ok, danger})                -> true / false
//   askText({title, text, label, value, ok})      -> the text, or null when cancelled
//   tell({title, text, danger})                   -> when closed
// `text` may hold several paragraphs, separated by a blank line. With `danger` the main button is
// red, and Cancel has the focus, so Enter can't do something that can't be undone.

function open({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, field = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'm3-dlg ask-dlg' + (danger ? ' danger' : '');
    const head = document.createElement('h2');
    head.textContent = title;
    const body = document.createElement('div');
    body.className = 'ask-body';
    for (const para of String(text).split(/\n\s*\n/)) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.textContent = para.trim();
      body.append(p);
    }
    let input = null;
    if (field) {
      const row = document.createElement('div');
      row.className = 'set-row ask-field';
      const label = document.createElement('label');
      label.textContent = field.label || '';
      input = document.createElement('input');
      input.id = label.htmlFor = 'ask-' + Math.random().toString(36).slice(2);
      input.value = field.value || '';
      input.spellcheck = false;
      input.autocomplete = 'off';
      row.append(label, input);
      body.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'm3-dlg-foot';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'vbtn text';
    no.textContent = cancel;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'vbtn ' + (danger ? 'danger-fill' : 'primary');
    yes.textContent = ok;
    if (cancel) foot.append(no);
    foot.append(yes);
    dlg.append(head, body, foot);
    document.body.append(dlg);

    let answer = field ? null : false;
    const done = (value) => { answer = value; dlg.close(); };
    no.addEventListener('click', () => done(field ? null : false));
    yes.addEventListener('click', () => done(field ? input.value : true));
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); yes.click(); } });
    dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); });   // Esc counts as Cancel
    dlg.showModal();
    if (input) { input.focus(); input.select(); } else (danger && cancel ? no : yes).focus();
  });
}

export const ask = (o) => open(o);
export const askText = (o) => open({ ...o, field: { label: o.label, value: o.value } })
  .then((v) => (v === null ? null : v.trim()));
export const tell = (o) => open({ ok: 'OK', ...o, cancel: '' });
