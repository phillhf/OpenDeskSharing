'use strict';
/* OpenDeskSharing – Client (ohne externe Bibliotheken) */

// ---------------------------------------------------------------- Hilfsfunktionen
const $ = (sel, el = document) => el.querySelector(sel);
const SVGNS = 'http://www.w3.org/2000/svg';

function setAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value' && 'value' in el && el.tagName !== 'BUTTON') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
}
function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
function h(tag, attrs, ...kids) { const el = document.createElement(tag); appendKids(el, kids); setAttrs(el, attrs); return el; }
function s(tag, attrs, ...kids) { const el = document.createElementNS(SVGNS, tag); appendKids(el, kids); setAttrs(el, attrs); return el; }
function fill(el, ...kids) { el.replaceChildren(); appendKids(el, kids); return el; }

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
const fmtDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
const toMin = t => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const addMin = (t, m) => { const x = Math.max(0, toMin(t) + m); return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };
const resName = b => (b.desk_id ? `Platz ${b.desk_name}` : b.room_name);

/** Zustand einer Buchung im Tagesverlauf (Check-in / Check-out) */
function bookingState(b) {
  const t = today(), now = nowHM(), isToday = b.day === t;
  const ended = !!b.checkout || b.day < t || (isToday && b.end <= now);
  const started = b.day < t || (isToday && b.start <= now);
  const running = started && !ended;
  const canCheckin = isToday && !b.checkin && !ended && now >= addMin(b.start, -15);
  let label = '', cls = '';
  if (b.checkout) { label = b.checkin ? `anwesend ${b.checkin}–${b.checkout}` : `freigegeben um ${b.checkout}`; cls = 'done'; }
  else if (b.checkin) { label = ended ? `anwesend ab ${b.checkin}` : `anwesend seit ${b.checkin}`; cls = ended ? 'done' : 'on'; }
  else if (ended) { label = 'nicht eingecheckt'; cls = 'warn'; }
  else if (running) { label = 'noch nicht eingecheckt'; cls = 'warn'; }
  return { isToday, ended, started, running, canCheckin, label, cls };
}
const statusBadge = b => { const st = bookingState(b); return st.label ? h('span', { class: 'badge st ' + st.cls }, st.label) : null; };

/** Buttons „Ich bin da“, „Ich bin nicht mehr da“, „Freigeben“, „Stornieren“ – je nach Zustand */
function bookingActions(b, onDone) {
  const st = bookingState(b);
  const act = (label, cls, fn, title) => h('button', {
    class: 'small ' + cls, title,
    onclick: async ev => {
      ev.stopPropagation();
      const btn = ev.currentTarget; btn.disabled = true;
      try { if (await fn() !== false) onDone(); } catch (e) { fail(e); } finally { btn.disabled = false; }
    },
  }, label);
  const out = [];
  if (st.canCheckin) out.push(act('✓ Ich bin da', 'primary', async () => {
    await api('POST', `/api/bookings/${b.id}/checkin`, {}); toast(`Eingecheckt: ${resName(b)}`, 'ok');
  }, 'Anwesenheit bestätigen'));
  if (st.running && b.checkin) out.push(act('Ich bin nicht mehr da', 'leave', async () => {
    if (!await confirmDialog('Auschecken', `${resName(b)} jetzt verlassen? Die restliche Zeit bis ${b.end} Uhr wird für andere freigegeben.`, 'Auschecken')) return false;
    await api('POST', `/api/bookings/${b.id}/checkout`, {}); toast(`${resName(b)} ist wieder frei`, 'ok');
  }, 'Auschecken – Rest der Buchung wird freigegeben'));
  if (st.running && !b.checkin) out.push(act('Freigeben', 'danger', async () => {
    if (!await confirmDialog('Buchung freigeben', `${resName(b)} ab jetzt freigeben? Die restliche Zeit bis ${b.end} Uhr wird für andere frei.`, 'Freigeben')) return false;
    await api('POST', `/api/bookings/${b.id}/checkout`, {}); toast(`${resName(b)} freigegeben`, 'ok');
  }, 'Sie kommen nicht? Buchung ab jetzt freigeben'));
  if (!st.started) out.push(act('Stornieren', 'danger', async () => {
    if (!await confirmDialog('Buchung stornieren', `${fmtDate(b.day)} ${b.start}–${b.end}, ${resName(b)} wirklich stornieren?`, 'Stornieren')) return false;
    await api('DELETE', '/api/bookings/' + b.id); toast('Storniert', 'ok');
  }));
  return out;
}

async function api(method, url, body) {
  const opt = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opt); } catch { throw new Error('Server nicht erreichbar'); }
  let data = null;
  try { data = await r.json(); } catch { /* leer */ }
  if (!r.ok) {
    if (r.status === 401 && url !== '/api/login' && S.me) { S.me = null; route(); }
    throw new Error((data && data.error) || `Fehler ${r.status}`);
  }
  return data;
}

function toast(msg, type = '') {
  const t = h('div', { class: 'toast ' + type }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3500);
}
const fail = e => toast(e.message || String(e), 'error');

// Jede Ansicht bekommt einen eigenen Container – eine noch ladende, veraltete Ansicht schreibt so ins Leere.
function clearMain() { const c = document.createElement('div'); $('#main').replaceChildren(c); return c; }

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Modaler Dialog. Liefert {dlg, body, foot, err, close, onClose}.
 *  Schließen läuft bewusst synchron über close() – nicht über das native „close“-Ereignis,
 *  das nicht in jeder Browser-Umgebung zuverlässig ausgelöst wird. */
function dialog(title, { wide = false } = {}) {
  const err = h('div', { class: 'err' });
  const body = h('div', { class: 'dlg-body' });
  const foot = h('div', { class: 'dlg-foot' });
  const hooks = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { if (dlg.open) dlg.close(); } catch { /* egal */ }
    dlg.remove();
    for (const f of hooks) f();
  };
  const dlg = h('dialog', { class: 'dlg', style: wide ? { width: 'min(720px, calc(100vw - 32px))' } : null },
    h('div', { class: 'dlg-head' }, h('h2', null, title), h('button', { class: 'x', 'aria-label': 'Schließen', onclick: close }, '×')),
    body, h('div', { style: { padding: '0 20px' } }, err), foot);
  dlg.addEventListener('cancel', ev => { ev.preventDefault(); close(); }); // Esc-Taste
  dlg.addEventListener('close', close);
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, foot, err, close, onClose: f => hooks.push(f) };
}

/** Einfaches Formular im Dialog. fields: [{name,label,type,value,options,required,full,placeholder}] */
function formDialog(title, fields, onSubmit, submitLabel = 'Speichern') {
  const d = dialog(title);
  const form = h('form', { class: 'form-grid' });
  const inputs = {};
  for (const f of fields) {
    let inp;
    if (f.type === 'custom') {
      inputs[f.name] = { custom: f.get };
      form.append(h('div', { class: 'field full' }, f.label, f.el));
      continue;
    }
    if (f.type === 'select') inp = h('select', { name: f.name, value: f.value ?? '' }, f.options.map(([v, l]) => h('option', { value: v }, l)));
    else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', name: f.name, checked: !!f.value });
    else if (f.type === 'textarea') inp = h('textarea', { name: f.name, rows: 3, value: f.value ?? '' });
    else inp = h('input', { type: f.type || 'text', name: f.name, value: f.value ?? '', required: f.required, placeholder: f.placeholder, autocomplete: f.autocomplete || 'off', min: f.min, max: f.max });
    inputs[f.name] = inp;
    form.append(f.type === 'checkbox'
      ? h('label', { class: 'check' + (f.full ? ' full' : '') }, inp, f.label)
      : h('label', { class: 'field' + (f.full ? ' full' : '') }, f.label, inp));
  }
  const submit = h('button', { class: 'primary', type: 'submit' }, submitLabel);
  form.append(h('button', { type: 'submit', class: 'hidden' }));
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const data = {};
    for (const [k, inp] of Object.entries(inputs)) data[k] = inp.custom ? inp.custom() : inp.type === 'checkbox' ? inp.checked : inp.value;
    submit.disabled = true; d.err.textContent = '';
    try { await onSubmit(data); d.close(); } catch (e) { d.err.textContent = e.message; } finally { submit.disabled = false; }
  });
  submit.addEventListener('click', ev => { ev.preventDefault(); form.requestSubmit(); });
  d.body.append(form);
  d.foot.append(h('button', { onclick: () => d.close() }, 'Abbrechen'), submit);
  setTimeout(() => form.querySelector('input,select,textarea')?.focus(), 30);
  return d;
}

/** Auswahl mehrerer Gruppen als Chips. hint(leer?) liefert den Hinweistext. */
function groupPicker(selected, hint, onChange) {
  const set = new Set(selected || []);
  const el = h('div', { class: 'group-pick' });
  const draw = () => fill(el,
    S.groups?.length
      ? h('div', { class: 'feat-bar', style: { margin: 0 } }, S.groups.map(g => h('button', {
        type: 'button', class: 'chip' + (set.has(g.id) ? ' active' : ''), title: g.description || null,
        onclick: () => { if (set.has(g.id)) set.delete(g.id); else set.add(g.id); draw(); onChange?.([...set]); },
      }, g.name)))
      : h('div', { class: 'muted small' }, 'Noch keine Gruppen angelegt – unter „Benutzer → Gruppen“.'),
    hint && h('div', { class: 'muted small', style: { marginTop: '4px' } }, hint(set.size === 0)));
  draw();
  return { el, get: () => [...set] };
}
const groupNames = ids => (ids || []).map(id => S.groups?.find(g => g.id === id)?.name).filter(Boolean);
/** Hinweis für Buchungsrechte: was gilt, wenn auf dieser Ebene keine Gruppe gewählt ist */
function accessHint(parents) {
  return empty => {
    if (!empty) return '🔒 Nur Mitglieder der gewählten Gruppen (und Administratoren) dürfen hier buchen.';
    for (const [label, ids] of parents) if (ids?.length) return `Keine Auswahl = wie ${label}: nur ${groupNames(ids).join(', ')}.`;
    return 'Keine Auswahl = alle dürfen buchen.';
  };
}
const lockBadge = (ids, prefix = '') => ids?.length ? h('span', { class: 'badge lock', title: 'Nur diese Gruppen dürfen buchen' }, `🔒 ${prefix}${groupNames(ids).join(', ')}`) : null;

function confirmDialog(title, text, okLabel = 'Löschen') {
  return new Promise(resolve => {
    const d = dialog(title);
    let ok = false;
    d.body.append(h('p', { style: { margin: 0 } }, text));
    d.foot.append(h('button', { onclick: () => d.close() }, 'Abbrechen'),
      h('button', { class: 'primary', style: { background: 'var(--danger)', borderColor: 'var(--danger)' }, onclick: () => { ok = true; d.close(); } }, okLabel));
    d.onClose(() => resolve(ok));
  });
}

// ---------------------------------------------------------------- Zustand & Router
const S = {
  me: null, settings: {}, buildings: [], floorCache: new Map(), users: null, features: null,
  sel: { b: null, f: null, date: today(), start: null, end: null, zoom: 1, feat: [] },
};
let curHash = null, dirtyFn = null, cleanupFn = null;

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', e => { if (dirtyFn && dirtyFn()) { e.preventDefault(); e.returnValue = ''; } });

async function boot() {
  try { const r = await api('GET', '/api/me'); S.me = r.user; S.settings = r.settings || {}; S.version = r.version; S.login = r.login; } catch (e) { fail(e); }
  route();
}

function route() {
  if (dirtyFn && location.hash !== curHash && dirtyFn()) {
    if (!confirm('Es gibt ungespeicherte Änderungen. Trotzdem verlassen?')) { history.replaceState(null, '', curHash); return; }
  }
  dirtyFn = null;
  if (cleanupFn) { cleanupFn(); cleanupFn = null; }
  hideTip();
  curHash = location.hash;
  renderHeader();
  if (!S.me) return viewLogin();
  if (S.me.must_change_pw) return viewPassword(true);
  const [, name, arg] = (location.hash || '#/meine').split('/');
  const admin = fn => (...a) => S.me.role === 'admin' ? fn(...a) : viewMine();
  const views = {
    buchen: viewBook, meine: viewMine, profil: () => viewPassword(false),
    benutzer: admin(viewUsers), standorte: admin(viewSites), editor: admin(viewEditor),
    buchungen: admin(viewAllBookings), auswertung: admin(viewStats), einstellungen: admin(viewSettings),
  };
  Promise.resolve((views[name] || viewMine)(arg)).catch(fail);
}

function renderHeader() {
  const top = $('#top');
  const name = S.settings.company_name || 'OpenDeskSharing';
  document.title = name;
  const cur = (location.hash || '#/meine').split('/')[1] || 'meine';
  const link = (hash, label) => h('a', { href: '#/' + hash, class: cur === hash ? 'active' : null }, label);
  const kids = [h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), name)];
  if (S.me && !S.me.must_change_pw) {
    const nav = h('nav', null, link('meine', 'Meine Buchungen'), link('buchen', 'Buchen'));
    if (S.me.role === 'admin') nav.append(h('span', { class: 'sep' }), link('standorte', 'Standorte & Pläne'), link('benutzer', 'Benutzer'), link('buchungen', 'Alle Buchungen'), link('auswertung', 'Auswertungen'), link('einstellungen', 'Einstellungen'));
    kids.push(nav);
  }
  if (S.me) {
    kids.push(h('div', { class: 'user' },
      h('span', null, S.me.display_name),
      !S.me.must_change_pw && h('button', { class: 'small', onclick: () => location.hash = '#/profil' }, 'Profil'),
      h('button', { class: 'small', onclick: logout }, 'Abmelden')));
  }
  top.replaceChildren(...kids.filter(Boolean));
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* egal */ }
  S.me = null; S.login = null; S.floorCache.clear(); S.users = null;
  location.hash = '';
  route();
}

// ---------------------------------------------------------------- Login & Passwort
function viewLogin() {
  const main = clearMain();
  const err = h('div', { class: 'err' });
  const user = h('input', { name: 'username', autocomplete: 'username', required: true });
  const pw = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Anmelden');
  const form = h('form', {
    onsubmit: async ev => {
      ev.preventDefault(); btn.disabled = true; err.textContent = '';
      try {
        await api('POST', '/api/login', { username: user.value, password: pw.value });
        const r = await api('GET', '/api/me'); S.me = r.user; S.settings = r.settings || {}; S.version = r.version;
        history.replaceState(null, '', '#/meine'); route();
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    },
  }, h('label', { class: 'field' }, 'Benutzername', user), h('label', { class: 'field' }, 'Passwort', pw), err, btn);
  const adHint = h('div');
  const foot = h('div', { class: 'hint' }, 'Alle Daten werden ausschließlich lokal auf diesem Server gespeichert.');
  main.append(h('div', { class: 'card login' }, h('h1', null, 'Anmelden'), adHint, form, foot));
  user.focus();
  const show = L => {
    if (!L) return;
    if (L.ad) fill(adHint, h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Melden Sie sich mit Ihrem ', h('b', null, 'Windows-Benutzernamen und -Passwort'), ' an',
      L.domain && L.domain !== '.' ? ` (Domäne ${L.domain}).` : '.'));
    if (L.ca) foot.append(h('br'), h('a', { href: '/OpenDeskSharing-Stammzertifikat.cer', class: 'small' }, 'Stammzertifikat herunterladen'),
      h('span', { class: 'muted small' }, ' (für die IT: damit der Browser dieser Seite vertraut)'));
  };
  if (S.login) show(S.login);
  else api('GET', '/api/me').then(r => { S.login = r.login; show(r.login); }).catch(() => {});
}

function viewPassword(forced) {
  const main = clearMain();
  const err = h('div', { class: 'err' });
  const oldPw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const form = h('form', {
    onsubmit: async ev => {
      ev.preventDefault(); err.textContent = '';
      if (n1.value !== n2.value) { err.textContent = 'Die neuen Passwörter stimmen nicht überein'; return; }
      try {
        await api('POST', '/api/me/password', { old_password: oldPw.value, new_password: n1.value });
        S.me.must_change_pw = 0; toast('Passwort geändert', 'ok');
        location.hash = '#/meine'; route();
      } catch (e) { err.textContent = e.message; }
    },
  },
  h('label', { class: 'field' }, 'Aktuelles Passwort', oldPw),
  h('label', { class: 'field' }, 'Neues Passwort (mind. 8 Zeichen)', n1),
  h('label', { class: 'field' }, 'Neues Passwort wiederholen', n2),
  err, h('button', { class: 'primary', type: 'submit' }, 'Passwort ändern'));
  const card = h('div', { class: 'card login' }, h('h1', null, forced ? 'Neues Passwort festlegen' : 'Profil'),
    forced && h('p', { class: 'muted' }, 'Bitte legen Sie vor der ersten Nutzung ein eigenes Passwort fest.'),
    !forced && h('p', { class: 'muted small' }, 'Ihre Gruppen: ', S.me.groups?.length ? h('b', null, S.me.groups.join(', ')) : 'keine'),
    S.me.auth === 'ad'
      ? h('p', { class: 'muted' }, 'Sie melden sich mit Ihrem Windows-Konto ', h('b', null, S.me.username), ' an. Ihr Passwort ändern Sie wie gewohnt in Windows.')
      : form);
  main.append(card);
  if (!forced) {
    card.append(h('hr', { style: { margin: '20px 0', border: 0, borderTop: '1px solid var(--line)' } }),
      h('h3', null, 'Meine Daten (DSGVO-Auskunft)'),
      h('p', { class: 'muted small' }, 'Laden Sie alle zu Ihrer Person gespeicherten Daten als JSON-Datei herunter.'),
      h('button', { onclick: async () => { try { const d = await api('GET', '/api/me/export'); download(`meine-daten-${today()}.json`, JSON.stringify(d, null, 2), 'application/json'); } catch (e) { fail(e); } } }, 'Daten exportieren'));
  }
  oldPw.focus();
}

// ---------------------------------------------------------------- Buchungsansicht
async function getFloor(id, force = false) {
  if (!force && S.floorCache.has(id)) return S.floorCache.get(id);
  const f = await api('GET', '/api/floors/' + id);
  S.floorCache.set(id, f);
  return f;
}

function resStatus(list, start, end, active = true) {
  if (!active) return 'off';
  const ov = list.filter(b => b.start < end && b.end > start);
  if (ov.some(b => b.mine)) return 'mine';
  if (ov.length) return 'busy';
  if (list.length) return 'part';
  return 'free';
}
const STATUS_TXT = { free: 'frei', busy: 'belegt', mine: 'von mir gebucht', part: 'teilweise belegt (im gewählten Zeitraum frei)', off: 'gesperrt' };
const ROOM_KIND_TXT = { work: 'Arbeitsraum', meeting: 'Besprechungsraum', other: 'Sonstiger Raum' };
const ROOM_COLOR = { work: '#eef2ff', meeting: '#fef9c3', other: '#f1f5f9' };

async function loadFeatures(force = false) {
  if (force || !S.features) S.features = await api('GET', '/api/features');
  return S.features;
}
const featNames = ids => [...new Set(ids || [])].map(id => S.features?.find(f => f.id === id)?.name).filter(Boolean);
const featBadges = ids => featNames(ids).map(n => h('span', { class: 'badge feat' }, n));

async function viewBook() {
  const main = clearMain();
  S.buildings = await api('GET', '/api/buildings');
  const withFloors = S.buildings.filter(b => b.floors.length);
  if (!withFloors.length) {
    main.append(h('div', { class: 'card empty' }, h('h2', null, 'Noch keine Standorte vorhanden'),
      S.me.role === 'admin'
        ? h('p', null, 'Legen Sie unter ', h('a', { href: '#/standorte' }, 'Standorte & Pläne'), ' ein Gebäude mit Etagen an und zeichnen Sie den Raumplan.')
        : h('p', null, 'Ein Administrator muss zuerst Gebäude, Etagen und Räume anlegen.')));
    return;
  }
  const sel = S.sel;
  if (!withFloors.some(b => b.id === sel.b)) sel.b = withFloors[0].id;
  const bld = () => S.buildings.find(b => b.id === sel.b);
  if (!bld().floors.some(f => f.id === sel.f)) sel.f = bld().floors[0].id;
  sel.start ||= S.settings.default_start || '08:00';
  sel.end ||= S.settings.default_end || '17:00';
  if (sel.date < today()) sel.date = today();
  await loadFeatures();
  sel.mode ||= 'plan';
  const picked = new Map(); // Auswahl in der Wochenansicht
  let wkShowName = false, wkAtt = 2;

  const bSel = h('select', { value: sel.b, onchange: () => { sel.b = +bSel.value; sel.f = bld().floors[0].id; fillFloors(); refresh(); } },
    withFloors.map(b => h('option', { value: b.id }, b.name)));
  const fSel = h('select', { onchange: () => { sel.f = +fSel.value; refresh(); } });
  const fillFloors = () => { fSel.replaceChildren(...bld().floors.map(f => h('option', { value: f.id }, f.name))); fSel.value = sel.f; };
  fillFloors();
  const maxDay = S.me.role === 'admin' ? null : addDays(today(), +S.settings.max_days_ahead || 30);
  const dInp = h('input', { type: 'date', value: sel.date, min: today(), max: maxDay, onchange: () => { if (dInp.value) { sel.date = dInp.value; refreshBookings(); refreshQuick(); } } });
  const stepDay = n => {
    let nd = addDays(sel.date, sel.mode === 'week' ? n * 7 : n);
    if (nd < today()) { if (sel.date === today()) return; nd = today(); }
    if (maxDay && nd > maxDay) return;
    sel.date = nd; dInp.value = nd; refreshBookings(); refreshQuick();
  };
  const tS = h('input', { type: 'time', step: 900, value: sel.start, onchange: () => { if (tS.value) { sel.start = tS.value; draw(); refreshQuick(); } } });
  const tE = h('input', { type: 'time', step: 900, value: sel.end, onchange: () => { if (tE.value) { sel.end = tE.value; draw(); refreshQuick(); } } });
  const preset = (a, b) => { sel.start = a; sel.end = b; tS.value = a; tE.value = b; draw(); refreshQuick(); };
  const modeSeg = h('div', { class: 'seg', role: 'tablist', style: { alignSelf: 'flex-end' } });
  const renderMode = () => fill(modeSeg, [['plan', 'Raumplan'], ['week', 'Woche']].map(([k, l]) => h('button', {
    role: 'tab', 'aria-selected': String(sel.mode === k), class: sel.mode === k ? 'active' : null,
    onclick: () => { if (sel.mode === k) return; sel.mode = k; renderMode(); refreshBookings(); },
  }, l)));
  renderMode();
  const ds = S.settings.default_start, de = S.settings.default_end;
  const mid = '12:30';

  main.append(h('div', { class: 'toolbar' },
    h('label', { class: 'field' }, 'Gebäude', bSel),
    h('label', { class: 'field' }, 'Etage', fSel),
    modeSeg,
    h('div', { class: 'group' },
      h('button', { title: 'Zurück (Tag bzw. Woche)', onclick: () => stepDay(-1) }, '‹'),
      h('label', { class: 'field' }, 'Datum', dInp),
      h('button', { title: 'Weiter (Tag bzw. Woche)', onclick: () => stepDay(1) }, '›'),
      h('button', { onclick: () => { sel.date = today(); dInp.value = sel.date; refreshBookings(); refreshQuick(); } }, 'Heute')),
    h('div', { class: 'group' },
      h('label', { class: 'field' }, 'Von', tS), h('label', { class: 'field' }, 'Bis', tE),
      h('button', { onclick: () => preset(ds, de) }, 'Ganztags'),
      h('button', { onclick: () => preset(ds, mid < de && mid > ds ? mid : de) }, 'Vormittag'),
      h('button', { onclick: () => preset(mid > ds && mid < de ? mid : ds, de) }, 'Nachmittag')),
    h('div', { class: 'spacer' }),
    h('div', { class: 'legend' },
      h('span', null, h('i', { class: 'free' }), 'frei'), h('span', null, h('i', { class: 'part' }), 'teilw. belegt'),
      h('span', null, h('i', { class: 'busy' }), 'belegt'), h('span', null, h('i', { class: 'mine' }), 'meine Buchung'),
      h('span', null, h('i', { class: 'off' }), 'gesperrt'))));

  const planWrap = h('div', { class: 'plan-wrap' });
  planWrap.style.setProperty('--zoom', sel.zoom);
  const side = h('aside', { class: 'side card' });
  const featBar = h('div', { class: 'feat-bar' });
  const todayBar = h('div');
  const quickBar = h('div');
  const dayBanner = h('div');
  const bookLayout = h('div', { class: 'book-layout' }, planWrap, side);
  const weekWrap = h('div', { class: 'week-wrap hidden' });
  main.prepend(todayBar, quickBar);
  main.append(dayBanner, featBar, bookLayout, weekWrap);

  // Eigene Buchungen von heute mit „Ich bin da“ / „Ich bin nicht mehr da“
  async function refreshToday() {
    let list = [];
    try { list = (await api('GET', '/api/bookings/mine')).filter(b => b.day === today() && !bookingState(b).ended); } catch { /* egal */ }
    if (!list.length) { todayBar.replaceChildren(); return; }
    fill(todayBar, h('div', { class: 'card today-card' }, h('h3', null, 'Meine Buchungen heute'),
      list.map(b => h('div', { class: 'today-row' },
        h('b', null, resName(b)), h('span', { class: 'muted' }, `${b.start}–${b.end} · ${b.building_name} · ${b.floor_name}`),
        statusBadge(b), h('span', { class: 'spacer' }),
        bookingActions(b, () => { refreshToday(); refreshBookings(); })))));
  }
  const onChanged = () => { refreshToday(); refreshBookings(); refreshQuick(); };
  const tick = setInterval(() => { if (todayBar.isConnected) refreshToday(); }, 60000);
  cleanupFn = () => clearInterval(tick);

  let floor = null, bookings = [], closures = [], lastWeek = null;
  const weekDays = () => {
    const d = new Date(sel.date + 'T12:00:00');
    const mon = addDays(sel.date, -((d.getDay() + 6) % 7));
    return [0, 1, 2, 3, 4].map(i => addDays(mon, i));
  };
  const closureOn = ds => closures.find(c => c.day === ds && (c.building_id == null || c.building_id === sel.b));
  const roomOf = d => floor.rooms.find(r => r.id === d.room_id);
  // Platz passt, wenn er (oder sein Raum) alle gewählten Merkmale besitzt
  const matches = (item, room) => sel.feat.every(f => item.features?.includes(f) || room?.features?.includes(f));

  function renderFeatBar() {
    const used = new Set();
    for (const x of [...floor.desks, ...floor.rooms.filter(r => r.kind !== 'other')]) for (const f of x.features || []) used.add(f);
    sel.feat = sel.feat.filter(f => used.has(f));
    const list = S.features.filter(f => used.has(f.id));
    if (!list.length) { featBar.replaceChildren(); return; }
    const toggle = id => { sel.feat = sel.feat.includes(id) ? sel.feat.filter(x => x !== id) : [...sel.feat, id]; draw(); };
    fill(featBar, h('span', { class: 'muted small' }, 'Ausstattung filtern:'),
      list.map(f => h('button', { class: 'chip' + (sel.feat.includes(f.id) ? ' active' : ''), 'aria-pressed': String(sel.feat.includes(f.id)), onclick: () => toggle(f.id) }, f.name)),
      sel.feat.length > 0 && h('button', { class: 'chip clear', onclick: () => { sel.feat = []; draw(); } }, '× Filter aufheben'));
  }
  async function refresh() {
    try { floor = await getFloor(sel.f); picked.clear(); await refreshBookings(); } catch (e) { fail(e); }
  }
  async function refreshBookings() {
    try {
      const wd = weekDays();
      const from = wd[0] < sel.date ? wd[0] : sel.date, to = wd[4] > sel.date ? wd[4] : sel.date;
      if (lastWeek !== wd[0]) { picked.clear(); lastWeek = wd[0]; }
      const [bk, cl] = await Promise.all([
        api('GET', sel.mode === 'week' ? `/api/floors/${sel.f}/bookings?from=${wd[0]}&to=${wd[4]}` : `/api/floors/${sel.f}/bookings?date=${sel.date}`),
        api('GET', `/api/closures?from=${from}&to=${to}&building=${sel.b}`)]);
      bookings = bk; closures = cl;
      draw();
    } catch (e) { fail(e); }
  }
  const byDesk = id => bookings.filter(b => b.desk_id === id);
  const byRoom = id => bookings.filter(b => b.room_id === id);

  function open(kind, item) {
    const accRoom = kind === 'desk' ? floor.rooms.find(r => r.id === item.room_id) : item;
    if (item.allowed === false) {
      const d = dialog(kind === 'desk' ? `Arbeitsplatz ${item.name}` : item.name);
      d.body.append(h('p', { style: { marginTop: 0 } }, '🔒 ', kind === 'desk' ? 'Dieser Platz' : 'Dieser Raum', ' ist nur für bestimmte Gruppen buchbar: ',
        h('b', null, (accRoom?.access_names || []).join(', ')), '.'),
        h('p', { class: 'muted small' }, 'Sie sind in keiner dieser Gruppen. Wenden Sie sich bei Bedarf an die Verwaltung.'));
      d.foot.append(h('button', { onclick: () => d.close() }, 'Schließen'));
      return;
    }
    const cl = closureOn(sel.date);
    if (cl) { toast(`${cl.kind === 'holiday' ? 'Feiertag' : 'Geschlossen'}: ${cl.name} – an diesem Tag sind keine Buchungen möglich`, 'error'); return; }
    const room = kind === 'desk' ? floor.rooms.find(r => r.id === item.room_id) : item;
    bookingDialog({ kind, item, room, floor, list: kind === 'desk' ? byDesk(item.id) : byRoom(item.id), onDone: onChanged });
  }

  function draw() {
    if (!floor) return;
    renderFeatBar();
    renderBanner();
    const week = sel.mode === 'week';
    bookLayout.classList.toggle('hidden', week);
    weekWrap.classList.toggle('hidden', !week);
    if (week) { drawWeek(); return; }
    planWrap.classList.toggle('closed-day', !!closureOn(sel.date));
    const W = floor.width, H = floor.height;
    const svg = s('svg', { class: 'plan', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Raumplan' });
    if (innerWidth < 760) svg.style.minWidth = Math.round(W * 0.8 * sel.zoom) + 'px';
    svg.append(floor.plan_image
      ? s('image', { href: floor.plan_image, x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' })
      : s('rect', { class: 'plan-bg', x: 0, y: 0, width: W, height: H }));
    const rooms = [...floor.rooms].sort((a, b) => b.w * b.h - a.w * a.h);
    for (const r of rooms) {
      const meeting = r.kind === 'meeting';
      const st = meeting ? resStatus(byRoom(r.id), sel.start, sel.end) : null;
      const g = s('g', { class: `room kind-${r.kind}` + (meeting ? ` st-${st} clickable` : '') + (meeting && !matches(r) ? ' dim' : '') + (r.allowed === false ? ' denied' : ''), tabindex: meeting ? 0 : null });
      const rect = s('rect', { class: 'body', x: r.x, y: r.y, width: r.w, height: r.h, rx: 3 });
      if (!meeting) { rect.style.fill = r.color || ROOM_COLOR[r.kind]; rect.style.fillOpacity = floor.plan_image ? .55 : 1; }
      g.append(rect,
        s('text', { class: 'label', x: r.x + 8, y: r.y + 19 }, (r.allowed === false ? '🔒 ' : '') + r.name),
        meeting && s('text', { class: 'sub', x: r.x + 8, y: r.y + 34 }, `Besprechung · ${r.capacity || '?'} Pers. · ${STATUS_TXT[st]}`),
        s('title', null, roomTitle(r, st)));
      if (meeting) {
        g.addEventListener('click', () => open('room', r));
        g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open('room', r); } });
      }
      svg.append(g);
    }
    for (const d of floor.desks) {
      const list = byDesk(d.id);
      const st = resStatus(list, sel.start, sel.end, !!d.active);
      const g = s('g', { class: `desk st-${st}` + (d.active ? ' clickable' : '') + (matches(d, roomOf(d)) ? '' : ' dim') + (d.allowed === false ? ' denied' : ''), tabindex: d.active ? 0 : null, 'data-id': d.id });
      g.append(s('rect', { x: d.x - 22, y: d.y - 13, width: 44, height: 26, rx: 5 }),
        s('text', { x: d.x, y: d.y }, d.name.length > 7 ? d.name.slice(0, 6) + '…' : d.name),
        s('title', null, deskTitle(d, list, st)));
      if (d.active) {
        g.addEventListener('click', () => open('desk', d));
        g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open('desk', d); } });
      }
      svg.append(g);
    }
    const zoom = z => { sel.zoom = Math.min(4, Math.max(.5, z)); planWrap.style.setProperty('--zoom', sel.zoom); };
    planWrap.replaceChildren(
      h('div', { class: 'zoom-ctl' },
        h('button', { title: 'Vergrößern', onclick: () => zoom(sel.zoom * 1.25) }, '+'),
        h('button', { title: 'Verkleinern', onclick: () => zoom(sel.zoom / 1.25) }, '−'),
        h('button', { title: 'Einpassen', onclick: () => zoom(1) }, '⤢')),
      svg);
    if (!floor.rooms.length) planWrap.append(h('div', { class: 'empty' }, 'Für diese Etage wurde noch kein Raumplan angelegt.'));
    drawSide();
  }

  function drawSide() {
    const desks = floor.desks.filter(d => matches(d, roomOf(d)));
    const sts = desks.filter(d => d.allowed !== false).map(d => resStatus(byDesk(d.id), sel.start, sel.end, !!d.active));
    const free = sts.filter(x => x === 'free' || x === 'part').length;
    const busy = sts.filter(x => x === 'busy' || x === 'mine').length;
    const list = h('ul', { class: 'res-list' });
    const rooms = [...floor.rooms].sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
    for (const r of rooms) {
      const rd = desks.filter(d => d.room_id === r.id).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
      if (r.kind === 'meeting') {
        if (!matches(r)) continue;
        const st = resStatus(byRoom(r.id), sel.start, sel.end);
        list.append(h('li', { class: r.allowed === false ? 'denied' : null, onclick: () => open('room', r), title: roomTitle(r, st) }, h('span', { class: 'dot ' + st }),
          h('span', null, r.allowed === false ? '🔒 ' : '', r.name, ' ', h('span', { class: 'badge meeting' }, 'Besprechung')), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `${r.capacity || '?'} P.`)));
        continue;
      }
      if (!rd.length) continue;
      list.append(h('li', { class: 'grp' }, r.allowed === false ? `🔒 ${r.name} – nur ${r.access_names.join(', ')}` : r.name));
      for (const d of rd) {
        const bl = byDesk(d.id);
        const st = resStatus(bl, sel.start, sel.end, !!d.active);
        const who = bl.filter(b => b.start < sel.end && b.end > sel.start).map(b => b.user_name || 'belegt').join(', ');
        list.append(h('li', {
          class: d.allowed === false ? 'denied' : null,
          onclick: d.active ? () => open('desk', d) : null, title: deskTitle(d, bl, st),
          onmouseenter: () => $(`svg.plan .desk[data-id="${d.id}"]`)?.classList.add('hl'),
          onmouseleave: () => $(`svg.plan .desk[data-id="${d.id}"]`)?.classList.remove('hl'),
        }, h('span', { class: 'dot ' + st }), h('span', null, d.name), h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, st === 'off' ? 'gesperrt' : who || d.equipment)));
      }
    }
    side.replaceChildren(
      h('h3', null, `${fmtDate(sel.date)}, ${sel.start}–${sel.end}`),
      h('div', { class: 'stats' }, h('div', null, h('b', { style: { color: 'var(--free)' } }, free), 'frei'),
        h('div', null, h('b', { style: { color: 'var(--busy)' } }, busy), 'belegt'), h('div', null, h('b', null, sts.length), 'für Sie buchbar')),
      list.children.length ? list : h('p', { class: 'muted' }, 'Keine buchbaren Plätze auf dieser Etage.'));
  }

  function deskTitle(d, list, st) {
    const lines = [`Arbeitsplatz ${d.name}: ${STATUS_TXT[st]}`];
    if (d.allowed === false) lines.push(`🔒 Nur buchbar für: ${(roomOf(d)?.access_names || []).join(', ')}`);
    const fn = featNames([...(d.features || []), ...(roomOf(d)?.features || [])]);
    if (fn.length) lines.push(`Ausstattung: ${fn.join(', ')}`);
    if (d.equipment) lines.push(d.equipment);
    for (const b of list) lines.push(`${b.start}–${b.end}: ${b.mine ? 'Ich' : b.user_name || 'belegt'}${b.checkin && !b.checkout ? ' (anwesend)' : ''}`);
    return lines.join('\n');
  }
  function roomTitle(r, st) {
    const lines = [`${r.name} (${ROOM_KIND_TXT[r.kind]})` + (st ? `: ${STATUS_TXT[st]}` : '')];
    if (r.access_names?.length) lines.push(`🔒 Nur buchbar für: ${r.access_names.join(', ')}${r.allowed === false ? '' : ' (Sie gehören dazu)'}`);
    if (r.capacity) lines.push(`Kapazität: ${r.capacity} Personen`);
    const fn = featNames(r.features);
    if (fn.length) lines.push(`Ausstattung: ${fn.join(', ')}`);
    if (r.equipment) lines.push(r.equipment);
    if (r.kind === 'meeting') for (const b of byRoom(r.id)) lines.push(`${b.start}–${b.end}: ${b.mine ? 'Ich' : b.user_name || 'belegt'}${b.attendees ? ` · ${b.attendees} Pers.` : ''}${b.checkin && !b.checkout ? ' (anwesend)' : ''}`);
    return lines.join('\n');
  }

  // ------------------------------------------------ Feiertage / Schließtage
  function renderBanner() {
    const days = sel.mode === 'week' ? weekDays() : [sel.date];
    const cls = days.map(closureOn).filter(Boolean);
    if (!cls.length) { dayBanner.replaceChildren(); return; }
    fill(dayBanner, h('div', { class: 'closure-banner' },
      sel.mode === 'week'
        ? cls.map(c => `${fmtDate(c.day).replace(/\d{4}$/, '')} ${c.name}`).join(' · ') + ' – an diesen Tagen sind keine Buchungen möglich.'
        : `${cls[0].kind === 'holiday' ? 'Feiertag' : 'Geschlossen'}: ${cls[0].name} – an diesem Tag sind keine Buchungen möglich.`));
  }

  // ------------------------------------------------ Schnell buchen: Favoriten & Vorschlag
  async function refreshQuick() {
    let favs = [];
    try { favs = await api('GET', `/api/favorites?date=${sel.date}&start=${sel.start}&end=${sel.end}`); } catch { /* egal */ }
    S.favs = favs;
    const FS = { free: 'frei', busy: 'belegt', mine: 'von mir gebucht', off: 'gesperrt', denied: '🔒 keine Berechtigung' };
    fill(quickBar, h('div', { class: 'card quick-card' },
      h('div', { class: 'row' },
        h('h3', { style: { margin: 0 } }, 'Schnell buchen'),
        h('span', { class: 'muted small' }, `${fmtDate(sel.date)} · ${sel.start}–${sel.end} Uhr`),
        h('span', { class: 'spacer' }),
        h('button', { title: 'Keinen passenden Platz oder Raum gefunden? Hier melden, was gefehlt hat.',
          onclick: () => demandDialog({ date: sel.date, start: sel.start, end: sel.end, building_id: sel.b, features: sel.feat }) }, 'Nichts gefunden? Melden'),
        h('button', { class: 'primary', onclick: suggestDialog }, 'Freien Platz vorschlagen')),
      favs.length
        ? h('div', { class: 'fav-list' }, favs.map(f => {
          const isDesk = !!f.desk_id;
          const label = isDesk ? `Platz ${f.desk_name}` : f.room_name;
          const action = f.status === 'free'
            ? h('button', { class: 'small primary', title: isDesk ? 'Sofort buchen' : 'Raum öffnen und Teilnehmerzahl angeben', onclick: () => (isDesk ? quickBook(f) : jumpTo(f, true)) }, isDesk ? 'Buchen' : 'Buchen …')
            : h('span', { class: 'muted small' }, f.status === 'closed' ? f.closure : FS[f.status]);
          return h('div', { class: 'fav' },
            h('span', { class: 'dot ' + (f.status === 'closed' || f.status === 'denied' ? 'off' : f.status) }),
            h('button', { class: 'linkish', title: 'Im Raumplan zeigen', onclick: () => jumpTo(f, false) }, h('b', null, '★ ', label)),
            h('span', { class: 'muted small' }, `${f.floor_name}${S.buildings.length > 1 ? ` · ${f.building_name}` : ''}`),
            action);
        }))
        : h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Tipp: Einen Platz oder Raum im Buchungsdialog mit „☆ Als Favorit merken“ markieren – dann ist er hier mit einem Klick buchbar.')));
  }

  async function quickBook(f) {
    try {
      await api('POST', '/api/bookings', { desk_id: f.desk_id, date: sel.date, start: sel.start, end: sel.end, show_name: false });
      toast(`Gebucht: Platz ${f.desk_name}, ${fmtDate(sel.date)} ${sel.start}–${sel.end}`, 'ok');
      onChanged();
    } catch (e) { fail(e); }
  }

  // Zu einem Platz/Raum im Raumplan springen (bei Räumen optional gleich den Buchungsdialog öffnen)
  async function jumpTo(f, openRoom) {
    sel.b = f.building_id; sel.f = f.floor_id; sel.mode = 'plan';
    bSel.value = sel.b; fillFloors(); renderMode();
    await refresh();
    if (openRoom && f.room_id) {
      const r = floor.rooms.find(x => x.id === f.room_id);
      if (r) open('room', r);
    } else if (f.desk_id) {
      const el = $(`svg.plan .desk[data-id="${f.desk_id}"]`);
      el?.classList.add('hl');
      setTimeout(() => el?.classList.remove('hl'), 3000);
    }
  }

  async function suggestDialog() {
    const d = dialog('Freien Platz vorschlagen', { wide: true });
    let wanted = [...sel.feat], scope = 'building';
    const deskFeats = S.features.filter(f => f.scope !== 'room');
    const chips = h('div', { class: 'feat-bar', style: { margin: 0 } });
    const scopeSel = h('select', { onchange: () => { scope = scopeSel.value; load(); } },
      h('option', { value: 'building' }, `Nur ${bld().name}`), S.buildings.length > 1 && h('option', { value: 'all' }, 'Alle Gebäude'));
    const results = h('div');
    const renderChips = () => fill(chips, h('span', { class: 'muted small' }, 'Gewünschte Ausstattung:'),
      deskFeats.map(f => h('button', {
        class: 'chip' + (wanted.includes(f.id) ? ' active' : ''),
        onclick: () => { wanted = wanted.includes(f.id) ? wanted.filter(x => x !== f.id) : [...wanted, f.id]; renderChips(); load(); },
      }, f.name)));
    d.body.append(h('div', { class: 'muted' }, `${fmtDate(sel.date)}, ${sel.start}–${sel.end} Uhr – Favoriten und von Ihnen oft genutzte Plätze zuerst`),
      h('label', { class: 'field' }, 'Suchen in', scopeSel), chips, results);
    renderChips();
    async function load() {
      fill(results, h('p', { class: 'muted' }, 'Suche …'));
      try {
        const qs = new URLSearchParams({ date: sel.date, start: sel.start, end: sel.end, floor: sel.f, limit: 8 });
        if (wanted.length) qs.set('features', wanted.join(','));
        if (scope === 'building') qs.set('building', sel.b);
        const r = await api('GET', '/api/suggest?' + qs);
        if (!r.items.length) {
          fill(results, h('p', { class: 'muted' }, r.info || 'Kein passender freier Platz gefunden – weniger Ausstattung wählen oder in allen Gebäuden suchen.'),
            !r.info && h('div', { class: 'demand-hint' },
              h('div', null, h('b', null, 'Nichts Passendes dabei?'), h('div', { class: 'muted small' }, 'Melden Sie, was Sie gebraucht hätten – das hilft bei der Planung, ob mehr Plätze nötig sind.')),
              h('button', { class: 'primary', onclick: report }, 'Bedarf melden')));
          return;
        }
        fill(results, h('p', { class: 'muted small' }, `${r.total_free} passende freie ${r.total_free === 1 ? 'Platz' : 'Plätze'} – die besten Vorschläge:`),
          h('ul', { class: 'suggest-list' }, r.items.map((x, i) => h('li', null,
            h('div', null,
              h('b', null, `Platz ${x.desk_name}`), h('span', { class: 'muted' }, ` · ${x.room_name} · ${x.floor_name}${S.buildings.length > 1 ? ` · ${x.building_name}` : ''}`),
              h('div', { class: 'row', style: { marginTop: '4px', gap: '4px' } }, x.why.map(w => h('span', { class: 'badge why' }, w)), featBadges(x.features))),
            h('span', { class: 'spacer' }),
            h('button', { class: 'small', onclick: () => { d.close(); jumpTo(x, false); } }, 'Im Plan'),
            h('button', {
              class: 'small' + (i === 0 ? ' primary' : ''),
              onclick: async () => {
                try {
                  await api('POST', '/api/bookings', { desk_id: x.desk_id, date: sel.date, start: sel.start, end: sel.end, show_name: false });
                  toast(`Gebucht: Platz ${x.desk_name} (${x.floor_name}), ${fmtDate(sel.date)} ${sel.start}–${sel.end}`, 'ok');
                  d.close(); await jumpTo(x, false); onChanged();
                } catch (e) { d.err.textContent = e.message; }
              },
            }, 'Buchen')))));
      } catch (e) { fill(results, h('p', { class: 'err' }, e.message)); }
    }
    function report() {
      d.close();
      demandDialog({ kind: 'desk', date: sel.date, start: sel.start, end: sel.end, building_id: scope === 'building' ? sel.b : null, features: wanted });
    }
    d.foot.append(h('button', { class: 'link-btn', onclick: report }, 'Nichts Passendes? Bedarf melden'), h('span', { class: 'spacer' }),
      h('button', { onclick: () => d.close() }, 'Schließen'));
    load();
  }

  // ------------------------------------------------ Wochenansicht (Mo–Fr, mehrere Felder auswählen und gemeinsam buchen)
  function drawWeek() {
    const days = weekDays(), t = today(), now = nowHM();
    const nameSort = (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true });
    const rows = [];
    for (const r of floor.rooms.filter(x => x.kind !== 'meeting').sort(nameSort))
      for (const d of floor.desks.filter(x => x.room_id === r.id && matches(x, r)).sort(nameSort)) rows.push({ kind: 'desk', item: d, group: r.name });
    for (const r of floor.rooms.filter(x => x.kind === 'meeting' && matches(x)).sort(nameSort)) rows.push({ kind: 'room', item: r, group: 'Besprechungsräume' });
    const label = row => (row.kind === 'desk' ? `Platz ${row.item.name}` : row.item.name);
    const key = (row, ds) => `${row.kind}:${row.item.id}:${ds}`;
    const cell = (row, ds) => {
      if (closureOn(ds)) return { st: 'closed' };
      if (row.kind === 'desk' && !row.item.active) return { st: 'off' };
      if (row.item.allowed === false) return { st: 'denied' };
      if (ds < t || (ds === t && sel.end <= now)) return { st: 'past' };
      if (maxDay && ds > maxDay) return { st: 'far' };
      const list = bookings.filter(b => b.day === ds && (row.kind === 'desk' ? b.desk_id === row.item.id : b.room_id === row.item.id));
      const ov = list.filter(b => b.start < sel.end && b.end > sel.start);
      return { st: resStatus(list, sel.start, sel.end), list, who: ov.map(b => (b.mine ? 'Ich' : b.user_name || 'belegt')).join(', ') };
    };
    const selectable = c => c.st === 'free' || c.st === 'part';
    const put = (row, ds) => picked.set(key(row, ds), { kind: row.kind, id: row.item.id, day: ds, name: label(row) });
    const toggle = (row, ds) => { const k = key(row, ds); if (picked.has(k)) picked.delete(k); else put(row, ds); drawWeek(); };
    const TXT = { mine: 'meine Buchung', part: 'teilw. belegt', off: 'gesperrt', far: 'noch nicht buchbar', free: 'frei', closed: '', past: '', denied: '🔒' };

    const thead = h('thead', null, h('tr', null, h('th', { class: 'wk-name' }, 'Platz / Raum'),
      days.map(ds => {
        const cl = closureOn(ds);
        return h('th', { class: (ds === t ? 'today' : '') + (cl ? ' closed' : '') }, fmtDate(ds).replace(/\d{4}$/, ''), cl && h('div', { class: 'small' }, cl.name));
      })));
    const tbody = h('tbody');
    let grp = null;
    for (const row of rows) {
      if (row.group !== grp) { grp = row.group; tbody.append(h('tr', { class: 'wk-grp' }, h('td', { colspan: days.length + 1 }, grp))); }
      const cells = days.map(ds => ({ ds, c: cell(row, ds) }));
      const freeDays = cells.filter(x => selectable(x.c));
      tbody.append(h('tr', null,
        h('th', { class: 'wk-name' },
          h('span', null, row.item.name, row.kind === 'room' && h('span', { class: 'muted small' }, ` (${row.item.capacity || '?'} P.)`)),
          freeDays.length > 1 && h('button', {
            class: 'linkish small', title: 'Alle freien Tage dieser Woche auswählen bzw. abwählen',
            onclick: () => {
              const all = freeDays.every(x => picked.has(key(row, x.ds)));
              for (const x of freeDays) { if (all) picked.delete(key(row, x.ds)); else put(row, x.ds); }
              drawWeek();
            },
          }, 'ganze Woche')),
        cells.map(({ ds, c }) => {
          const on = picked.has(key(row, ds));
          const title = (c.list || []).map(b => `${b.start}–${b.end}: ${b.mine ? 'Ich' : b.user_name || 'belegt'}${b.attendees ? ` (${b.attendees} Pers.)` : ''}`).join('\n');
          return h('td', {
            class: `wk st-${c.st}` + (on ? ' sel' : '') + (selectable(c) ? ' pick' : ''), title: title || null,
            tabindex: selectable(c) ? 0 : null, role: selectable(c) ? 'button' : null, 'aria-pressed': selectable(c) ? String(on) : null,
            onclick: selectable(c) ? () => toggle(row, ds) : null,
            onkeydown: selectable(c) ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(row, ds); } } : null,
          }, on ? '✓ ausgewählt' : c.st === 'busy' ? c.who : TXT[c.st]);
        })));
    }

    const n = picked.size;
    const hasRoom = [...picked.values()].some(x => x.kind === 'room');
    const showName = h('input', { type: 'checkbox', checked: wkShowName, onchange: e => { wkShowName = e.target.checked; } });
    const att = hasRoom ? h('input', { type: 'number', min: 1, max: 999, value: wkAtt, style: { width: '70px' }, onchange: e => { wkAtt = +e.target.value || 1; } }) : null;
    const bookBtn = h('button', { class: 'primary', disabled: !n }, n ? `${n} ${n === 1 ? 'Buchung' : 'Buchungen'} anlegen` : 'Felder auswählen');
    bookBtn.addEventListener('click', async () => {
      bookBtn.disabled = true;
      try {
        const items = [...picked.values()].map(x => ({ [x.kind === 'desk' ? 'desk_id' : 'room_id']: x.id, date: x.day }));
        const r = await api('POST', '/api/bookings/batch', { items, start: sel.start, end: sel.end, show_name: wkShowName, attendees: hasRoom ? wkAtt : undefined });
        toast(`${r.created.length} ${r.created.length === 1 ? 'Buchung' : 'Buchungen'} angelegt`, 'ok');
        if (r.skipped.length) toast(`${r.skipped.length} nicht möglich: ` + r.skipped.slice(0, 3).map(x => `${fmtDate(x.date).slice(0, 3)} (${x.reason})`).join('; '), 'error');
        picked.clear(); onChanged();
      } catch (e) { fail(e); bookBtn.disabled = false; }
    });
    const summary = [...picked.values()].sort((a, b) => a.day.localeCompare(b.day));
    fill(weekWrap,
      h('div', { class: 'row week-head' },
        h('b', null, `Woche ${fmtDate(days[0]).replace(/\d{4}$/, '')} – ${fmtDate(days[4])}`),
        h('span', { class: 'muted small' }, `Zeitfenster ${sel.start}–${sel.end} Uhr · freie Felder anklicken und unten gemeinsam buchen`)),
      rows.length ? h('div', { class: 'tbl-wrap week-scroll' }, h('table', { class: 'tbl week' }, thead, tbody))
        : h('div', { class: 'card empty' }, 'Keine passenden Plätze auf dieser Etage.'),
      h('div', { class: 'week-bar' },
        h('span', { class: 'muted small' }, n ? summary.slice(0, 4).map(x => `${x.name} ${fmtDate(x.day).slice(0, 3)}`).join(', ') + (n > 4 ? ` … (+${n - 4})` : '') : 'Noch nichts ausgewählt'),
        h('span', { class: 'spacer' }),
        h('label', { class: 'check' }, showName, 'Namen anzeigen'),
        att && h('label', { class: 'check' }, 'Teilnehmer', att),
        n > 0 && h('button', { onclick: () => { picked.clear(); drawWeek(); } }, 'Auswahl leeren'),
        bookBtn));
  }

  refreshToday();
  refreshQuick();
  await refresh();
}

/** „Nichts Passendes gefunden“ melden – anonym, für die Bedarfsplanung. p: {kind, date, start, end, building_id, features, attendees} */
function demandDialog(p = {}) {
  const d = dialog('Nichts Passendes gefunden? Bedarf melden');
  let kind = p.kind || 'desk', feats = [...(p.features || [])];
  const date = h('input', { type: 'date', value: p.date || today(), min: today(), required: true });
  const start = h('input', { type: 'time', step: 900, value: p.start || S.settings.default_start, required: true });
  const end = h('input', { type: 'time', step: 900, value: p.end || S.settings.default_end, required: true });
  const bsel = h('select', { value: p.building_id ? String(p.building_id) : '' },
    h('option', { value: '' }, 'Egal / alle Gebäude'), S.buildings.map(b => h('option', { value: String(b.id) }, b.name)));
  const att = h('input', { type: 'number', min: 1, max: 500, value: p.attendees || '', placeholder: 'z. B. 8' });
  const attLbl = h('label', { class: 'field' }, 'Anzahl Personen', att);
  const note = h('textarea', { rows: 3, maxlength: 500, placeholder: 'z. B. „Ruhiger Platz mit 2 Monitoren“ oder „Raum für 12 Personen mit Videokonferenz“' });
  const kindSeg = h('div', { class: 'seg' });
  const chips = h('div', { class: 'feat-bar', style: { margin: 0 } });
  const render = () => {
    fill(kindSeg, [['desk', 'Arbeitsplatz'], ['room', 'Besprechungsraum']].map(([k, l]) => h('button', {
      type: 'button', class: kind === k ? 'active' : null, onclick: () => { kind = k; feats = feats.filter(id => okFeat(id)); render(); },
    }, l)));
    const list = S.features.filter(f => f.scope === 'both' || f.scope === kind);
    fill(chips, h('span', { class: 'muted small' }, 'Benötigte Ausstattung:'), list.map(f => h('button', {
      type: 'button', class: 'chip' + (feats.includes(f.id) ? ' active' : ''),
      onclick: () => { feats = feats.includes(f.id) ? feats.filter(x => x !== f.id) : [...feats, f.id]; render(); },
    }, f.name)));
    attLbl.style.display = kind === 'room' ? '' : 'none';
  };
  const okFeat = id => S.features.some(f => f.id === id && (f.scope === 'both' || f.scope === kind));
  d.body.append(
    h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Beschreiben Sie kurz, was Sie gebraucht hätten. Die Meldung wird ', h('b', null, 'anonym'),
      ' gespeichert (ohne Ihren Namen) und fließt in die Auswertungen ein – so sieht die Verwaltung, ob mehr Plätze oder Räume nötig sind.'),
    h('div', { class: 'field' }, 'Was hat gefehlt?', kindSeg),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Datum', date), h('label', { class: 'field' }, 'Gebäude', bsel),
      h('label', { class: 'field' }, 'Von', start), h('label', { class: 'field' }, 'Bis', end), attLbl),
    chips,
    h('label', { class: 'field', style: { marginTop: '10px' } }, 'Was hätten Sie gebraucht? (optional)', note));
  render();
  const send = h('button', {
    class: 'primary', onclick: async () => {
      send.disabled = true; d.err.textContent = '';
      try {
        await api('POST', '/api/demand', { kind, date: date.value, start: start.value, end: end.value, building_id: bsel.value ? +bsel.value : null,
          attendees: kind === 'room' && att.value ? +att.value : null, features: feats, note: note.value });
        d.close(); toast('Danke! Ihre Meldung wurde gespeichert.', 'ok');
      } catch (e) { d.err.textContent = e.message; } finally { send.disabled = false; }
    },
  }, 'Meldung senden');
  d.foot.append(h('button', { onclick: () => d.close() }, 'Abbrechen'), send);
}

async function bookingDialog({ kind, item, room, floor, list, onDone }) {
  const sel = S.sel, st = S.settings;
  const bld = S.buildings.find(b => b.id === floor.building_id);
  const title = kind === 'desk' ? `Arbeitsplatz ${item.name}` : item.name;
  const d = dialog(title);
  // Favorit (Stern)
  const favKey = kind === 'desk' ? 'desk_id' : 'room_id';
  const favOf = () => (S.favs || []).find(f => f[favKey] === item.id);
  const favBtn = h('button', { class: 'small fav-btn' });
  let favChanged = false;
  const renderFav = () => {
    const on = !!favOf();
    favBtn.textContent = on ? '★ Favorit' : '☆ Als Favorit merken';
    favBtn.classList.toggle('on', on);
    favBtn.title = on ? 'Aus den Favoriten entfernen' : 'Zu den Favoriten – dann oben unter „Schnell buchen“ mit einem Klick buchbar';
  };
  favBtn.addEventListener('click', async () => {
    try {
      const f = favOf();
      if (f) { await api('DELETE', '/api/favorites/' + f.id); S.favs = S.favs.filter(x => x !== f); }
      else { const r = await api('POST', '/api/favorites', { [favKey]: item.id }); (S.favs ||= []).push({ id: r.id, [favKey]: item.id }); }
      favChanged = true; renderFav();
    } catch (e) { fail(e); }
  });
  renderFav();
  d.onClose(() => { if (favChanged) onDone(); });
  d.body.append(h('div', { class: 'row' }, h('span', { class: 'muted' },
    [bld?.name, floor.name, kind === 'desk' ? room?.name : ROOM_KIND_TXT[item.kind]].filter(Boolean).join(' · ')), h('span', { class: 'spacer' }), favBtn));
  const eq = [item.capacity ? `${item.capacity} Personen` : null, item.equipment || null, kind === 'desk' && room?.equipment ? `Raum: ${room.equipment}` : null].filter(Boolean);
  const fl = [...(item.features || []), ...(kind === 'desk' ? room?.features || [] : [])];
  if (fl.length) d.body.append(h('div', { class: 'row' }, featBadges(fl)));
  if (eq.length) d.body.append(h('div', null, h('b', null, 'Hinweise: '), eq.join(' · ')));

  // Zeitleiste des Tages
  const ds = toMin(st.day_start), de = toMin(st.day_end), span = de - ds;
  const pct = t => `${Math.max(0, Math.min(100, (toMin(t) - ds) / span * 100))}%`;
  const tl = h('div', { class: 'timeline', title: 'Rot = belegt, Blau = meine Buchung' });
  for (const b of list) {
    const seg = h('div', { class: 'seg' + (b.mine ? ' mine' : ''), title: `${b.start}–${b.end} ${b.mine ? 'Ich' : b.user_name || 'belegt'}` });
    seg.style.left = pct(b.start); seg.style.width = `calc(${pct(b.end)} - ${pct(b.start)})`;
    tl.append(seg);
  }
  const win = h('div', { class: 'win' });
  tl.append(win);
  const hours = [];
  for (let m = Math.ceil(ds / 60) * 60; m <= de; m += 120) hours.push(h('span', null, `${pad(m / 60 | 0)}:00`));
  d.body.append(h('div', null, h('div', { class: 'small muted', style: { marginBottom: '4px' } }, `Belegung am ${fmtDate(sel.date)}`), tl, h('div', { class: 'tl-scale' }, hours)));

  if (list.length) {
    const ul = h('ul', { class: 'blist' });
    for (const b of list) {
      ul.append(h('li', null, h('b', null, `${b.start}–${b.end}`), h('span', null, b.mine ? 'Meine Buchung' : b.user_name || 'belegt'),
        b.attendees && h('span', { class: 'muted small' }, `${b.attendees} Pers.`),
        b.note && h('span', { class: 'muted small' }, `„${b.note}“`),
        (b.mine || S.me.role === 'admin') && statusBadge(b), h('span', { class: 'spacer' }),
        b.mine && bookingActions(b, () => { d.close(); onDone(); }),
        !b.mine && S.me.role === 'admin' && h('button', {
          class: 'small danger', title: 'Als Administrator löschen', onclick: async () => {
            if (!await confirmDialog('Buchung löschen', `Buchung von ${b.user_name} (${b.start}–${b.end}) löschen?`)) return;
            try { await api('DELETE', '/api/bookings/' + b.id); toast('Buchung gelöscht', 'ok'); d.close(); onDone(); } catch (e) { fail(e); }
          },
        }, 'Löschen')));
    }
    d.body.append(ul);
  }

  // Formular
  const tS = h('input', { type: 'time', step: 900, value: sel.start, min: st.day_start, max: st.day_end });
  const tE = h('input', { type: 'time', step: 900, value: sel.end, min: st.day_start, max: st.day_end });
  const until = h('input', { type: 'date', min: addDays(sel.date, 1), max: addDays(sel.date, 92) });
  const note = h('input', { maxlength: 300, placeholder: kind === 'room' ? 'z. B. Teammeeting' : 'optional' });
  const updWin = () => { if (tS.value && tE.value) { win.style.left = pct(tS.value); win.style.width = `calc(${pct(tE.value)} - ${pct(tS.value)})`; } };
  tS.addEventListener('input', updWin); tE.addEventListener('input', updWin); updWin();
  const att = kind === 'room' ? h('input', { type: 'number', min: 1, max: item.capacity || 999, value: Math.min(2, item.capacity || 2), required: true }) : null;
  const form = h('div', { class: 'form-grid' },
    h('label', { class: 'field' }, 'Von', tS), h('label', { class: 'field' }, 'Bis', tE),
    att && h('label', { class: 'field' }, `Teilnehmer *${item.capacity ? ` (max. ${item.capacity})` : ''}`, att),
    (st.allow_series === '1' || S.me.role === 'admin') && h('label', { class: 'field' }, 'Wiederholen bis (Mo–Fr, optional)', until),
    h('label', { class: 'field full' }, kind === 'room' ? 'Titel / Notiz' : 'Notiz', note));
  let userSel = null;
  if (S.me.role === 'admin') {
    try {
      S.users ||= await api('GET', '/api/users');
      userSel = h('select', { value: S.me.id }, S.users.filter(u => u.active).map(u => h('option', { value: u.id }, `${u.display_name} (${u.username})`)));
      form.append(h('label', { class: 'field full' }, 'Buchen für', userSel));
    } catch (e) { fail(e); }
  }
  const showName = h('input', { type: 'checkbox' }); // bewusst standardmäßig NICHT gesetzt
  const nameLbl = h('span', null, userSel ? 'Namen der gebuchten Person am Platz/Raum für andere anzeigen' : `Meinen Namen am ${kind === 'desk' ? 'Platz' : 'Raum'} für andere anzeigen`);
  if (userSel) userSel.addEventListener('change', () => { nameLbl.textContent = +userSel.value === S.me.id ? `Meinen Namen am ${kind === 'desk' ? 'Platz' : 'Raum'} für andere anzeigen` : 'Namen der gebuchten Person am Platz/Raum für andere anzeigen'; });
  form.append(h('div', { class: 'full' }, h('label', { class: 'check' }, showName, nameLbl),
    h('div', { class: 'muted small', style: { marginLeft: '24px' } }, 'Ohne Haken sehen andere nur „belegt“.')));
  d.body.append(h('h3', { style: { margin: '6px 0 0' } }, `Neue Buchung am ${fmtDate(sel.date)}`), form);
  const btn = h('button', { class: 'primary' }, 'Jetzt buchen');
  btn.addEventListener('click', async () => {
    d.err.textContent = ''; btn.disabled = true;
    try {
      const body = { date: sel.date, start: tS.value, end: tE.value, note: note.value, until: until.value || null, show_name: showName.checked, attendees: att ? +att.value : undefined };
      body[kind === 'desk' ? 'desk_id' : 'room_id'] = item.id;
      if (userSel && +userSel.value !== S.me.id) body.user_id = +userSel.value;
      const r = await api('POST', '/api/bookings', body);
      toast(r.created.length > 1 ? `${r.created.length} Buchungen angelegt` : 'Gebucht!', 'ok');
      if (r.skipped.length) toast(`${r.skipped.length} Tag(e) übersprungen: ` + r.skipped.slice(0, 3).map(x => `${fmtDate(x.date)} (${x.reason})`).join('; '), 'error');
      d.close(); onDone();
    } catch (e) { d.err.textContent = e.message; } finally { btn.disabled = false; }
  });
  d.foot.append(h('button', { onclick: () => d.close() }, 'Schließen'), btn);
}

// ---------------------------------------------------------------- Meine Buchungen
async function viewMine() {
  const main = clearMain();
  let past = false;
  const wrap = h('div');
  const tgl = h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: e => { past = e.target.checked; load(); } }), 'Letzte 30 Tage anzeigen');
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Meine Buchungen'), h('span', { class: 'spacer' }), tgl,
    h('button', { class: 'primary', onclick: () => location.hash = '#/buchen' }, '+ Neue Buchung')), wrap);
  async function load() {
    const list = await api('GET', '/api/bookings/mine' + (past ? '?past=1' : ''));
    if (!list.length) { wrap.replaceChildren(h('div', { class: 'card empty' }, 'Keine Buchungen vorhanden. ', h('a', { href: '#/buchen' }, 'Jetzt buchen'))); return; }
    wrap.replaceChildren(bookingTable(list, false, load));
  }
  await load();
}

function bookingTable(list, admin, reload) {
  const t = today();
  const tbody = h('tbody');
  for (const b of list) {
    const where = [b.building_name, b.floor_name, b.room_name].join(' · ');
    const nameChk = !admin && h('input', {
      type: 'checkbox', checked: !!b.show_name, title: 'Namen für andere sichtbar',
      onchange: async ev => {
        try { await api('PUT', '/api/bookings/' + b.id, { show_name: ev.target.checked }); b.show_name = ev.target.checked ? 1 : 0; toast(ev.target.checked ? 'Name wird angezeigt' : 'Name wird nicht angezeigt', 'ok'); }
        catch (e) { ev.target.checked = !ev.target.checked; fail(e); }
      },
    });
    tbody.append(h('tr', { style: b.day < t ? { opacity: .6 } : null },
      h('td', null, fmtDate(b.day)),
      h('td', null, `${b.start}–${b.end}`, b.orig_end && h('div', { class: 'muted small' }, `gebucht bis ${b.orig_end}`)),
      admin && h('td', null, b.user_name),
      h('td', null, b.desk_id ? `Platz ${b.desk_name}` : h('span', null, b.room_name, ' ', h('span', { class: 'badge meeting' }, 'Raum'),
        b.attendees ? h('span', { class: 'muted small' }, ` ${b.attendees} Pers.`) : null)),
      h('td', null, where),
      h('td', null, statusBadge(b)),
      !admin && h('td', { style: { textAlign: 'center' } }, nameChk),
      h('td', { class: 'muted' }, b.note),
      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        h('button', { class: 'small', title: 'Im Plan zeigen', onclick: () => { Object.assign(S.sel, { b: b.building_id, f: b.floor_id, date: b.day < t ? t : b.day, start: b.start, end: b.end }); location.hash = '#/buchen'; } }, 'Plan'), ' ',
        admin ? h('button', {
          class: 'small danger', onclick: async () => {
            if (!await confirmDialog('Buchung löschen', `${fmtDate(b.day)} ${b.start}–${b.end}, ${resName(b)} (${b.user_name}) endgültig löschen? Sie fehlt dann auch in der Auswertung.`)) return;
            try { await api('DELETE', '/api/bookings/' + b.id); toast('Gelöscht', 'ok'); reload(); } catch (e) { fail(e); }
          },
        }, 'Löschen') : bookingActions(b, reload))));
  }
  const labels = ['Datum', 'Zeit', ...(admin ? ['Person'] : []), 'Platz / Raum', 'Ort', 'Status', ...(admin ? [] : ['Name sichtbar']), 'Notiz', ''];
  for (const tr of tbody.children) [...tr.children].forEach((td, i) => { if (labels[i]) td.dataset.label = labels[i]; });
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl cards' },
    h('thead', null, h('tr', null, h('th', null, 'Datum'), h('th', null, 'Zeit'), admin && h('th', null, 'Person'), h('th', null, 'Platz / Raum'), h('th', null, 'Ort'),
      h('th', null, 'Status'), !admin && h('th', { title: 'Namen für andere am Platz/Raum anzeigen' }, 'Name sichtbar'), h('th', null, 'Notiz'), h('th'))),
    tbody));
}

// ---------------------------------------------------------------- Admin: Benutzer
async function viewUsers(tab) {
  if (tab === 'gruppen') return viewGroups();
  const main = clearMain();
  const [users, groups] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/groups')]);
  S.users = users; S.groups = groups;
  const filter = h('input', { placeholder: 'Suchen …', oninput: () => draw() });
  const wrap = h('div');
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Benutzer'), userTabs('benutzer'), h('span', { class: 'muted' }, `${users.length} insgesamt`), h('span', { class: 'spacer' }), filter,
    h('button', { class: 'primary', onclick: () => userDialog(null) }, '+ Neuer Benutzer')), wrap);
  function draw() {
    const q = filter.value.toLowerCase();
    const rows = users.filter(u => !q || [u.username, u.display_name, u.email, u.department, ...groupNames(u.groups)].join(' ').toLowerCase().includes(q));
    wrap.replaceChildren(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['Name', 'Benutzername', 'Anmeldung', 'E-Mail', 'Abteilung', 'Gruppen', 'Rolle', 'Status', ''].map(x => h('th', null, x)))),
      h('tbody', null, rows.map(u => h('tr', null,
        h('td', null, h('b', null, u.display_name)), h('td', null, u.username),
        h('td', null, u.auth === 'ad' ? h('span', { class: 'badge', title: 'Anmeldung mit Windows-/AD-Konto' }, 'Windows') : h('span', { class: 'muted small' }, 'Passwort')),
        h('td', null, u.email), h('td', null, u.department),
        h('td', null, groupNames(u.groups).map(n => h('span', { class: 'badge' }, n))),
        h('td', null, h('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : '') }, u.role === 'admin' ? 'Administrator' : 'Benutzer')),
        h('td', null, u.active ? (u.must_change_pw && u.auth !== 'ad' ? h('span', { class: 'muted small' }, 'Erstanmeldung offen') : 'aktiv') : h('span', { class: 'badge off' }, 'deaktiviert')),
        h('td', { style: { textAlign: 'right' } },
          h('button', { class: 'small', onclick: () => userDialog(u) }, 'Bearbeiten'), ' ',
          u.id !== S.me.id && h('button', {
            class: 'small danger', onclick: async () => {
              if (!await confirmDialog('Benutzer löschen', `„${u.display_name}“ und alle zugehörigen Buchungen endgültig löschen?`)) return;
              try { await api('DELETE', '/api/users/' + u.id); toast('Benutzer gelöscht', 'ok'); viewUsers(); } catch (e) { fail(e); }
            },
          }, 'Löschen'))))))));
  }
  draw();

  function userDialog(u) {
    const isNew = !u;
    const adOn = S.settings.ad_enabled === '1';
    const d = formDialog(isNew ? 'Neuer Benutzer' : `Benutzer bearbeiten: ${u.username}`, [
      (isNew || adOn || u.auth === 'ad') && { name: 'auth', label: 'Anmeldung', type: 'select', value: u?.auth || (adOn ? 'ad' : 'local'), full: true,
        options: [['ad', 'Windows-/AD-Konto (Windows-Passwort)'], ['local', 'Eigenes OpenDeskSharing-Passwort']] },
      isNew && { name: 'username', label: 'Benutzername *', required: true },
      { name: 'display_name', label: 'Anzeigename *', value: u?.display_name, required: true },
      { name: 'email', label: 'E-Mail', type: 'email', value: u?.email },
      { name: 'department', label: 'Abteilung', value: u?.department },
      { name: 'role', label: 'Rolle', type: 'select', value: u?.role || 'user', options: [['user', 'Benutzer'], ['admin', 'Administrator (darf alles buchen)']] },
      (() => { const gp = groupPicker(u?.groups, null); return { name: 'groups', label: 'Gruppen', type: 'custom', el: gp.el, get: gp.get }; })(),
      { name: 'password', label: isNew ? 'Startpasswort * (mind. 8 Zeichen)' : 'Neues Passwort (leer = unverändert)', type: 'text', autocomplete: 'new-password', required: isNew, value: isNew ? genPw() : '' },
      { name: 'active', label: 'Konto aktiv', type: 'checkbox', value: u ? !!u.active : true, full: true },
    ].filter(Boolean), async data => {
      if (data.auth === 'ad') delete data.password;
      if (isNew) await api('POST', '/api/users', data);
      else await api('PUT', '/api/users/' + u.id, data);
      toast(data.password && (isNew || u.auth === 'ad') ? `Gespeichert – Startpasswort: ${data.password}` : 'Gespeichert', 'ok');
      if (!isNew && u.id === S.me.id) { const r = await api('GET', '/api/me'); S.me = r.user; }
      viewUsers();
    });
    // Passwortfeld nur bei eigenem OpenDeskSharing-Passwort
    const authSel = d.body.querySelector('[name=auth]'), pwIn = d.body.querySelector('[name=password]');
    const nameLbl = isNew && d.body.querySelector('[name=username]').closest('label');
    const sync = () => {
      const ad = authSel && authSel.value === 'ad';
      const switchToLocal = !ad && !isNew && u.auth === 'ad';
      pwIn.closest('label').style.display = ad ? 'none' : '';
      pwIn.required = !ad && (isNew || switchToLocal);
      if (!ad && (isNew || switchToLocal) && !pwIn.value) pwIn.value = genPw();
      pwIn.closest('label').firstChild.textContent = isNew || switchToLocal ? 'Startpasswort * (mind. 8 Zeichen)' : 'Neues Passwort (leer = unverändert)';
      if (nameLbl) nameLbl.firstChild.textContent = ad ? 'Windows-Anmeldename * (ohne Domäne, z. B. mmustermann)' : 'Benutzername *';
    };
    if (authSel) authSel.addEventListener('change', sync);
    if (authSel && isNew && authSel.value === 'ad') pwIn.value = '';
    sync();
  }
}
function userTabs(cur) {
  return h('div', { class: 'seg' }, [['benutzer', 'Benutzer'], ['gruppen', 'Gruppen']].map(([k, l]) =>
    h('button', { class: cur === k ? 'active' : null, onclick: () => { location.hash = k === 'benutzer' ? '#/benutzer' : '#/benutzer/gruppen'; } }, l)));
}

async function viewGroups() {
  const main = clearMain();
  const [users, groups] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/groups')]);
  S.users = users; S.groups = groups;
  const adOn = S.settings.ad_enabled === '1';
  main.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Benutzer'), userTabs('gruppen'), h('span', { class: 'muted' }, `${groups.length} ${groups.length === 1 ? 'Gruppe' : 'Gruppen'}`), h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => groupDialog(null) }, '+ Neue Gruppe')),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Mit Gruppen legen Sie fest, wer welche Gebäude, Etagen oder Räume buchen darf – unter „Standorte & Pläne“ (Gebäude/Etage) bzw. im Raumplan-Editor (Raum). Ohne Festlegung darf jeder buchen. Administratoren dürfen immer alles buchen.'),
    groups.length
      ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Gruppe', 'Beschreibung', 'Mitglieder', adOn || groups.some(g => g.ad_group) ? 'AD-Gruppe' : null, 'Buchungsrecht für', ''].filter(x => x !== null).map(x => h('th', null, x)))),
        h('tbody', null, groups.map(g => h('tr', null,
          h('td', null, h('b', null, g.name)), h('td', null, g.description),
          h('td', { title: g.members.map(id => users.find(u => u.id === id)?.display_name).filter(Boolean).join(', ') }, String(g.members.length)),
          (adOn || groups.some(x => x.ad_group)) && h('td', null, g.ad_group || h('span', { class: 'muted' }, '–')),
          h('td', { class: 'small', style: { whiteSpace: 'normal' } }, g.used_by.length ? g.used_by.join(', ') : h('span', { class: 'muted' }, 'noch nirgends')),
          h('td', { style: { textAlign: 'right' } },
            h('button', { class: 'small', onclick: () => groupDialog(g) }, 'Bearbeiten'), ' ',
            h('button', {
              class: 'small danger', onclick: async () => {
                const extra = g.used_by.length ? ` Sie wird aus den Buchungsrechten entfernt (${g.used_by.join(', ')}); ist dort danach keine Gruppe mehr eingetragen, darf dort wieder jeder buchen.` : '';
                if (!await confirmDialog('Gruppe löschen', `Gruppe „${g.name}“ löschen?${extra}`)) return;
                try { await api('DELETE', '/api/groups/' + g.id); S.floorCache.clear(); viewGroups(); } catch (e) { fail(e); }
              },
            }, 'Löschen')))))))
      : h('div', { class: 'card empty' }, 'Noch keine Gruppen. Legen Sie z. B. „Geschäftsleitung“ oder „Vertrieb“ an.'));

  function groupDialog(g) {
    const members = new Set(g?.members || []);
    const search = h('input', { placeholder: 'Benutzer suchen …', oninput: () => drawList() });
    const list = h('div', { class: 'member-list' });
    const count = h('span', { class: 'muted small' });
    const drawList = () => {
      const q = search.value.toLowerCase();
      fill(list, users.filter(u => !q || `${u.display_name} ${u.username} ${u.department}`.toLowerCase().includes(q)).map(u => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: members.has(u.id), onchange: e => { if (e.target.checked) members.add(u.id); else members.delete(u.id); count.textContent = `${members.size} ausgewählt`; } }),
        u.display_name, h('span', { class: 'muted small' }, ` ${u.username}${u.department ? ' · ' + u.department : ''}`))));
      count.textContent = `${members.size} ausgewählt`;
    };
    drawList();
    formDialog(g ? `Gruppe bearbeiten: ${g.name}` : 'Neue Gruppe', [
      { name: 'name', label: 'Name *', value: g?.name, required: true, placeholder: 'z. B. Geschäftsleitung' },
      { name: 'description', label: 'Beschreibung', value: g?.description },
      { name: 'ad_group', label: 'Verknüpfte AD-Gruppe (optional – nur bei Windows-Anmeldung)', value: g?.ad_group, full: true, placeholder: 'z. B. GL-Mitglieder' },
      { name: 'members', label: 'Mitglieder', type: 'custom', el: h('div', null, h('div', { class: 'row' }, search, count), list), get: () => [...members] },
    ], async data => {
      if (g) await api('PUT', '/api/groups/' + g.id, data); else await api('POST', '/api/groups', data);
      S.floorCache.clear(); toast('Gruppe gespeichert', 'ok'); viewGroups();
    });
  }
}

function genPw() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(r, x => a[x % a.length]).join('');
}

// ---------------------------------------------------------------- Admin: Standorte
async function viewSites() {
  const main = clearMain();
  const [bs, groups] = await Promise.all([api('GET', '/api/buildings'), api('GET', '/api/groups')]);
  S.buildings = bs; S.groups = groups;
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Standorte & Raumpläne'), h('span', { class: 'spacer' }),
    h('button', { class: 'primary', onclick: () => buildingDlg(null) }, '+ Gebäude')));
  if (!bs.length) main.append(h('div', { class: 'card empty' }, h('h2', null, 'Willkommen!'),
    h('p', null, 'So richten Sie das System ein:'),
    h('ol', { style: { textAlign: 'left', display: 'inline-block' } },
      h('li', null, 'Gebäude anlegen'), h('li', null, 'Etagen zum Gebäude hinzufügen'),
      h('li', null, 'Im Raumplan-Editor optional einen Grundriss (Bild) hinterlegen'),
      h('li', null, 'Räume einzeichnen und Arbeitsplätze setzen'), h('li', null, 'Benutzer anlegen – fertig!')),
    h('p', null, h('button', { class: 'primary', onclick: () => buildingDlg(null) }, 'Erstes Gebäude anlegen'))));
  for (const b of bs) {
    const card = h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, b.name), b.address && h('span', { class: 'muted' }, b.address),
        b.state && h('span', { class: 'badge', title: 'Bundesland für gesetzliche Feiertage' }, (GERMAN_STATES.find(x => x[0] === b.state) || ['', b.state])[1]),
        lockBadge(b.access, 'nur '),
        h('span', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => floorDlg(b, null) }, '+ Etage'),
        h('button', { class: 'small', onclick: () => buildingDlg(b) }, 'Bearbeiten'),
        h('button', {
          class: 'small danger', onclick: async () => {
            if (!await confirmDialog('Gebäude löschen', `„${b.name}“ mit allen Etagen, Räumen, Plätzen und Buchungen endgültig löschen?`)) return;
            try { await api('DELETE', '/api/buildings/' + b.id); S.floorCache.clear(); viewSites(); } catch (e) { fail(e); }
          },
        }, 'Löschen')));
    const fl = h('div', { style: { marginTop: '12px' } });
    if (!b.floors.length) fl.append(h('p', { class: 'muted' }, 'Noch keine Etagen. ', h('a', { href: '#', onclick: e => { e.preventDefault(); floorDlg(b, null); } }, 'Etage hinzufügen')));
    for (const f of b.floors) {
      fl.append(h('div', { class: 'site-floor' },
        h('span', { class: 'name' }, f.name),
        h('span', { class: 'muted small' }, `${f.room_count} Räume · ${f.desk_count} Arbeitsplätze${f.has_plan ? ' · Grundriss hinterlegt' : ''}`),
        lockBadge(f.access, 'nur '),
        h('span', { class: 'spacer' }),
        h('button', { class: 'small primary', onclick: () => location.hash = '#/editor/' + f.id }, 'Raumplan bearbeiten'),
        h('button', { class: 'small', onclick: () => floorDlg(b, f) }, 'Bearbeiten'),
        h('button', {
          class: 'small danger', onclick: async () => {
            if (!await confirmDialog('Etage löschen', `Etage „${f.name}“ mit allen Räumen, Plätzen und Buchungen endgültig löschen?`)) return;
            try { await api('DELETE', '/api/floors/' + f.id); S.floorCache.delete(f.id); viewSites(); } catch (e) { fail(e); }
          },
        }, 'Löschen')));
    }
    card.append(fl);
    main.append(card);
  }

  function buildingDlg(b) {
    formDialog(b ? 'Gebäude bearbeiten' : 'Neues Gebäude', [
      { name: 'name', label: 'Name *', value: b?.name, required: true, placeholder: 'z. B. Hauptgebäude' },
      { name: 'address', label: 'Adresse', value: b?.address },
      { name: 'sort', label: 'Sortierung', type: 'number', value: b?.sort ?? 0 },
      { name: 'state', label: 'Bundesland (für gesetzliche Feiertage)', type: 'select', value: b?.state || '', full: true,
        options: [['', `Standard aus den Einstellungen${S.settings.holiday_state ? ' (' + (GERMAN_STATES.find(x => x[0] === S.settings.holiday_state) || ['', ''])[1] + ')' : ''}`], ...GERMAN_STATES] },
      (() => { const gp = groupPicker(b?.access, accessHint([])); return { name: 'access', label: 'Wer darf in diesem Gebäude buchen?', type: 'custom', el: gp.el, get: gp.get }; })(),
    ], async data => { if (b) await api('PUT', '/api/buildings/' + b.id, data); else await api('POST', '/api/buildings', data); S.floorCache.clear(); viewSites(); });
  }
  function floorDlg(b, f) {
    const gp = groupPicker(f?.access, accessHint([['das Gebäude', b.access]]));
    formDialog(f ? 'Etage bearbeiten' : `Neue Etage in ${b.name}`, [
      { name: 'name', label: 'Name *', value: f?.name, required: true, placeholder: 'z. B. 1. OG' },
      { name: 'sort', label: 'Sortierung', type: 'number', value: f?.sort ?? b.floors.length },
      { name: 'access', label: 'Wer darf auf dieser Etage buchen?', type: 'custom', el: gp.el, get: gp.get },
    ], async data => {
      if (f) { await api('PUT', '/api/floors/' + f.id, data); S.floorCache.delete(f.id); viewSites(); }
      else { const r = await api('POST', '/api/floors', { ...data, building_id: b.id }); location.hash = '#/editor/' + r.id; }
    });
  }
}

// ---------------------------------------------------------------- Admin: Raumplan-Editor
async function viewEditor(fid) {
  fid = +fid;
  const main = clearMain();
  const floor = await api('GET', '/api/floors/' + fid);
  await loadFeatures(true);
  const bs = S.buildings = await api('GET', '/api/buildings');
  S.groups = await api('GET', '/api/groups');
  const bld = bs.find(b => b.id === floor.building_id);
  const E = {
    W: floor.width, H: floor.height, img: floor.plan_image, imgDirty: false,
    rooms: floor.rooms.map(r => ({ ...r })), desks: floor.desks.map(d => ({ ...d, room: d.room_id })),
    tool: 'select', sel: null, dirty: false, n: 0, drag: null, grid: true,
  };
  dirtyFn = () => E.dirty;
  const snap = v => E.grid ? Math.round(v / 10) * 10 : Math.round(v);
  const findRoom = id => E.rooms.find(r => String(r.id) === String(id));
  const findDesk = id => E.desks.find(d => String(d.id) === String(id));
  const roomAt = (x, y) => E.rooms.filter(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h).sort((a, b) => a.w * a.h - b.w * b.h)[0];
  const markDirty = () => { if (!E.dirty) { E.dirty = true; updTitle(); } };

  // Werkzeugleiste
  const toolBtns = {};
  const tool = (id, label, tip) => (toolBtns[id] = h('button', { title: tip, onclick: () => setTool(id) }, label));
  const setTool = t => { E.tool = t; for (const [k, b] of Object.entries(toolBtns)) b.classList.toggle('active', k === t); svg.setAttribute('class', `plan editor tool-${t}`); };
  const fileInp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden', onchange: () => loadImage(fileInp.files[0]) });
  const wInp = h('input', { type: 'number', min: 200, max: 10000, step: 10, value: E.W, style: { width: '80px' }, onchange: () => { E.W = Math.max(200, +wInp.value || 1200); markDirty(); render(); } });
  const hInp = h('input', { type: 'number', min: 200, max: 10000, step: 10, value: E.H, style: { width: '80px' }, onchange: () => { E.H = Math.max(200, +hInp.value || 800); markDirty(); render(); } });
  const imgBtn = h('button', { onclick: () => fileInp.click() });
  const rmImgBtn = h('button', { onclick: () => { E.img = null; E.imgDirty = true; markDirty(); render(); } }, 'Grundriss entfernen');
  const titleEl = h('h1');
  const updTitle = () => titleEl.replaceChildren(`Raumplan: ${bld?.name || ''} · ${floor.name} `, ...(E.dirty ? [h('span', { class: 'dirty-dot', title: 'Ungespeichert' }, '●')] : []));
  updTitle();
  const saveBtn = h('button', { class: 'primary', onclick: save }, 'Speichern');
  const gridChk = h('input', { type: 'checkbox', checked: E.grid, onchange: () => { E.grid = gridChk.checked; render(); } });

  main.append(
    h('div', { class: 'page-head' }, h('button', { onclick: () => location.hash = '#/standorte' }, '← Zurück'), titleEl, h('span', { class: 'spacer' }),
      h('button', { onclick: () => { Object.assign(S.sel, { b: floor.building_id, f: fid }); location.hash = '#/buchen'; } }, 'Buchungsansicht'), saveBtn),
    innerWidth < 760 ? h('div', { class: 'closure-banner' }, 'Der Raumplan-Editor ist für die Bedienung am PC mit Maus gedacht. Auf dem Smartphone bitte nur kleine Änderungen vornehmen.') : '',
    h('div', { class: 'toolbar' },
      h('div', { class: 'tools' },
        tool('select', '⬚ Auswählen / Verschieben', 'Räume und Plätze auswählen, verschieben, Größe ändern (V)'),
        tool('room', '▭ Raum zeichnen', 'Mit gedrückter Maustaste ein Rechteck aufziehen (R)'),
        tool('desk', '▪ Arbeitsplatz setzen', 'In einen Raum klicken, um einen Platz zu setzen (P)')),
      h('div', { class: 'group' },
        imgBtn, rmImgBtn, fileInp),
      h('div', { class: 'group' }, h('label', { class: 'field' }, 'Planbreite', wInp), h('label', { class: 'field' }, 'Planhöhe', hInp)),
      h('label', { class: 'check' }, gridChk, 'Am Raster ausrichten')));

  const svg = s('svg', { class: 'plan editor tool-select' });
  const planWrap = h('div', { class: 'plan-wrap' }, svg);
  const props = h('aside', { class: 'card props' });
  main.append(h('div', { class: 'book-layout' }, planWrap, props));
  setTool('select');

  function render() {
    svg.setAttribute('viewBox', `0 0 ${E.W} ${E.H}`);
    imgBtn.textContent = E.img ? 'Grundriss ersetzen' : 'Grundriss-Bild laden';
    rmImgBtn.classList.toggle('hidden', !E.img);
    const kids = [s('defs', null, s('pattern', { id: 'grid', width: 20, height: 20, patternUnits: 'userSpaceOnUse' },
      s('path', { d: 'M 20 0 L 0 0 0 20', fill: 'none', stroke: '#e2e8f0', 'stroke-width': 1 })))];
    kids.push(E.img ? s('image', { href: E.img, x: 0, y: 0, width: E.W, height: E.H, preserveAspectRatio: 'none' })
      : s('rect', { class: 'plan-bg', x: 0, y: 0, width: E.W, height: E.H }));
    if (E.grid) kids.push(s('rect', { x: 0, y: 0, width: E.W, height: E.H, fill: 'url(#grid)', opacity: E.img ? .5 : 1, 'pointer-events': 'none' }));
    const sorted = [...E.rooms].sort((a, b) => b.w * b.h - a.w * a.h);
    for (const r of sorted) {
      const isSel = E.sel?.t === 'room' && E.sel.o === r;
      const rect = s('rect', { class: 'body', x: r.x, y: r.y, width: r.w, height: r.h, rx: 3 });
      rect.style.fill = r.color || ROOM_COLOR[r.kind];
      const cnt = E.desks.filter(d => d.room === r.id).length;
      kids.push(s('g', { class: `room kind-${r.kind}` + (isSel ? ' sel' : ''), 'data-t': 'room', 'data-id': r.id }, rect,
        s('text', { class: 'label', x: r.x + 8, y: r.y + 19 }, r.name),
        s('text', { class: 'sub', x: r.x + 8, y: r.y + 34 }, r.kind === 'meeting' ? `Besprechung · ${r.capacity || 0} P.` : r.kind === 'work' ? `${cnt} Plätze` : ROOM_KIND_TXT[r.kind])));
    }
    for (const d of E.desks) {
      const isSel = E.sel?.t === 'desk' && E.sel.o === d;
      kids.push(s('g', { class: 'desk' + (isSel ? ' sel' : '') + (d.active ? '' : ' inactive'), 'data-t': 'desk', 'data-id': d.id },
        s('rect', { x: d.x - 22, y: d.y - 13, width: 44, height: 26, rx: 5 }),
        s('text', { x: d.x, y: d.y }, d.name.length > 7 ? d.name.slice(0, 6) + '…' : d.name)));
    }
    if (E.sel?.t === 'room') {
      const r = E.sel.o;
      kids.push(s('rect', { class: 'handle', 'data-t': 'handle', 'data-id': r.id, x: r.x + r.w - 7, y: r.y + r.h - 7, width: 14, height: 14, rx: 3 }));
    }
    if (E.drag?.mode === 'new') {
      const q = E.drag.rect;
      kids.push(s('rect', { class: 'draft', x: q.x, y: q.y, width: q.w, height: q.h }));
    }
    svg.replaceChildren(...kids);
  }

  function pt(ev) {
    const p = svg.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY;
    const q = p.matrixTransform(svg.getScreenCTM().inverse());
    return { x: Math.max(0, Math.min(E.W, q.x)), y: Math.max(0, Math.min(E.H, q.y)) };
  }
  function select(t, o) { E.sel = o ? { t, o } : null; render(); renderProps(); }
  function nextDeskName() {
    const nums = E.desks.map(d => +(String(d.name).match(/(\d+)\s*$/) || [0, 0])[1]);
    return 'P' + (Math.max(0, ...nums) + 1);
  }

  svg.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    const p = pt(ev);
    const t = ev.target.closest('[data-t]');
    if (E.tool === 'room') {
      E.drag = { mode: 'new', x0: snap(p.x), y0: snap(p.y), rect: { x: snap(p.x), y: snap(p.y), w: 0, h: 0 } };
    } else if (E.tool === 'desk') {
      const room = roomAt(p.x, p.y);
      if (!room) { toast('Arbeitsplätze müssen innerhalb eines Raums liegen – bitte zuerst einen Raum zeichnen.', 'error'); return; }
      if (room.kind !== 'work') toast(`Hinweis: „${room.name}“ ist kein Arbeitsraum. Plätze sind trotzdem einzeln buchbar.`);
      const d = { id: 'n' + (++E.n), room: room.id, name: nextDeskName(), equipment: '', active: 1, features: [], x: snap(p.x), y: snap(p.y) };
      E.desks.push(d); markDirty(); select('desk', d);
      return;
    } else {
      if (!t) { select(null, null); return; }
      const kind = t.dataset.t, id = t.dataset.id;
      if (kind === 'handle') {
        const r = findRoom(id);
        E.drag = { mode: 'resize', r, p0: p, w0: r.w, h0: r.h };
      } else if (kind === 'room') {
        const r = findRoom(id);
        E.drag = { mode: 'moveRoom', r, p0: p, x0: r.x, y0: r.y, desks: E.desks.filter(d => d.room === r.id).map(d => ({ d, x: d.x, y: d.y })) };
        select('room', r);
      } else if (kind === 'desk') {
        const d = findDesk(id);
        E.drag = { mode: 'moveDesk', d, p0: p, x0: d.x, y0: d.y };
        select('desk', d);
      }
    }
    svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  svg.addEventListener('pointermove', ev => {
    const D = E.drag; if (!D) return;
    const p = pt(ev);
    if (D.mode === 'new') {
      const x = snap(p.x), y = snap(p.y);
      D.rect = { x: Math.min(x, D.x0), y: Math.min(y, D.y0), w: Math.abs(x - D.x0), h: Math.abs(y - D.y0) };
    } else {
      const dx = p.x - D.p0.x, dy = p.y - D.p0.y;
      if (!D.moved && Math.hypot(dx, dy) < 3) return;
      D.moved = true;
      if (D.mode === 'resize') { D.r.w = Math.max(20, snap(D.w0 + dx)); D.r.h = Math.max(20, snap(D.h0 + dy)); }
      else if (D.mode === 'moveRoom') {
        const nx = snap(D.x0 + dx), ny = snap(D.y0 + dy);
        const ox = nx - D.x0, oy = ny - D.y0;
        D.r.x = nx; D.r.y = ny;
        for (const q of D.desks) { q.d.x = q.x + ox; q.d.y = q.y + oy; }
      } else if (D.mode === 'moveDesk') { D.d.x = snap(D.x0 + dx); D.d.y = snap(D.y0 + dy); }
    }
    render();
  });
  const endDrag = () => {
    const D = E.drag; if (!D) return;
    E.drag = null;
    if (D.mode === 'new') {
      const q = D.rect;
      if (q.w >= 30 && q.h >= 30) {
        const n = E.rooms.length + 1;
        const r = { id: 'n' + (++E.n), name: `Raum ${n}`, kind: 'work', capacity: 0, equipment: '', color: '', features: [], ...q };
        E.rooms.push(r); markDirty(); setTool('select'); select('room', r);
        return;
      }
    } else if (D.moved) {
      if (D.mode === 'moveDesk') {
        const room = roomAt(D.d.x, D.d.y);
        if (!room) { D.d.x = D.x0; D.d.y = D.y0; toast('Ein Arbeitsplatz muss in einem Raum liegen.', 'error'); }
        else D.d.room = room.id;
      }
      markDirty(); renderProps();
    }
    render();
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  const onKey = ev => {
    if (ev.target.closest('input,textarea,select') || document.querySelector('dialog[open]')) return;
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && E.sel) { ev.preventDefault(); deleteSel(); }
    else if (ev.key === 'Escape') { setTool('select'); select(null, null); }
    else if (ev.key.toLowerCase() === 'v') setTool('select');
    else if (ev.key.toLowerCase() === 'r') setTool('room');
    else if (ev.key.toLowerCase() === 'p') setTool('desk');
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    else if (E.sel && ev.key.startsWith('Arrow')) {
      ev.preventDefault();
      const st = ev.shiftKey ? 10 : 1;
      const dx = ev.key === 'ArrowLeft' ? -st : ev.key === 'ArrowRight' ? st : 0;
      const dy = ev.key === 'ArrowUp' ? -st : ev.key === 'ArrowDown' ? st : 0;
      const o = E.sel.o; o.x += dx; o.y += dy;
      if (E.sel.t === 'room') for (const d of E.desks) if (d.room === o.id) { d.x += dx; d.y += dy; }
      markDirty(); render();
    }
  };
  document.addEventListener('keydown', onKey);
  cleanupFn = () => document.removeEventListener('keydown', onKey);

  async function deleteSel() {
    if (!E.sel) return;
    if (E.sel.t === 'room') {
      const r = E.sel.o;
      const cnt = E.desks.filter(d => d.room === r.id).length;
      if (cnt && !await confirmDialog('Raum löschen', `Raum „${r.name}“ enthält ${cnt} Arbeitsplätze. Raum und Plätze (inkl. deren Buchungen, beim Speichern) löschen?`)) return;
      E.rooms = E.rooms.filter(x => x !== r);
      E.desks = E.desks.filter(d => d.room !== r.id);
    } else {
      E.desks = E.desks.filter(x => x !== E.sel.o);
    }
    markDirty(); select(null, null);
  }

  function featureChecks(o, scope) {
    const list = S.features.filter(f => f.scope === scope || f.scope === 'both');
    if (!list.length) return h('div', { class: 'muted small' }, 'Keine Ausstattungsmerkmale definiert (Einstellungen).');
    return h('fieldset', { class: 'feat-checks' }, h('legend', null, 'Ausstattung'),
      list.map(f => h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: (o.features || []).includes(f.id),
        onchange: ev => { o.features = ev.target.checked ? [...(o.features || []), f.id] : (o.features || []).filter(x => x !== f.id); markDirty(); render(); },
      }), f.name)));
  }

  function renderProps() {
    const sel = E.sel;
    if (!sel) {
      const work = E.rooms.filter(r => r.kind === 'work').length, meet = E.rooms.filter(r => r.kind === 'meeting').length;
      fill(props, 
        h('h2', null, 'Etage'),
        h('div', { class: 'stats row' }, h('span', { class: 'badge' }, `${work} Arbeitsräume`), h('span', { class: 'badge meeting' }, `${meet} Besprechungsräume`), h('span', { class: 'badge' }, `${E.desks.length} Plätze`)),
        h('div', { class: 'muted small' },
          h('p', null, h('b', null, 'So geht’s:')),
          h('ol', { style: { paddingLeft: '18px', margin: 0 } },
            h('li', null, 'Optional einen Grundriss (PNG/JPG, z. B. Export aus CAD oder Scan) laden.'),
            h('li', null, '„Raum zeichnen“ wählen und Rechtecke über die Räume ziehen.'),
            h('li', null, 'Raum anklicken, um Name und Typ festzulegen. Besprechungsräume werden als Ganzes gebucht.'),
            h('li', null, 'Mit „Arbeitsplatz setzen“ in einen Raum klicken – oder im Raum „Plätze im Raster anlegen“ nutzen.'),
            h('li', null, 'Speichern nicht vergessen (Strg+S).')),
          h('p', null, 'Tastatur: V/R/P = Werkzeug, Entf = löschen, Pfeiltasten = verschieben (Umschalt = 10er-Schritte), Esc = Auswahl aufheben.')));
      return;
    }
    const o = sel.o;
    const upd = (k, conv = v => v) => ev => { o[k] = conv(ev.target.type === 'checkbox' ? (ev.target.checked ? 1 : 0) : ev.target.value); markDirty(); render(); };
    if (sel.t === 'room') {
      const cnt = h('input', { type: 'number', min: 1, max: 200, value: 4, style: { width: '70px' } });
      const colors = [['', 'Standard'], ['#dbeafe', 'Blau'], ['#dcfce7', 'Grün'], ['#fef9c3', 'Gelb'], ['#fee2e2', 'Rot'], ['#ede9fe', 'Violett'], ['#e5e7eb', 'Grau'], ['#ffffff', 'Weiß']];
      fill(props, 
        h('h2', null, 'Raum'),
        h('label', { class: 'field' }, 'Name', h('input', { value: o.name, maxlength: 100, oninput: upd('name') })),
        h('label', { class: 'field' }, 'Typ', h('select', { value: o.kind, onchange: ev => { upd('kind')(ev); renderProps(); } },
          h('option', { value: 'work' }, 'Arbeitsraum (Plätze einzeln buchbar)'),
          h('option', { value: 'meeting' }, 'Besprechungsraum (als Ganzes buchbar)'),
          h('option', { value: 'other' }, 'Sonstiges (nicht buchbar, z. B. Küche)'))),
        o.kind === 'meeting' && h('label', { class: 'field' }, 'Kapazität (Personen)', h('input', { type: 'number', min: 0, max: 10000, value: o.capacity, oninput: upd('capacity', v => +v || 0) })),
        featureChecks(o, 'room'),
        o.kind !== 'other' && h('div', { class: 'field' }, o.kind === 'meeting' ? 'Wer darf diesen Raum buchen?' : 'Wer darf die Plätze in diesem Raum buchen?',
          groupPicker(o.access, accessHint([['die Etage', floor.access], ['das Gebäude', floor.building_access]]), v => { o.access = v; markDirty(); render(); }).el),
        h('label', { class: 'field' }, 'Weitere Hinweise (Freitext)', h('input', { value: o.equipment, maxlength: 300, placeholder: 'z. B. Schlüssel am Empfang', oninput: upd('equipment') })),
        h('label', { class: 'field' }, 'Farbe', h('select', { value: o.color, onchange: upd('color') }, colors.map(([v, l]) => h('option', { value: v }, l)))),
        h('div', { class: 'muted small' }, `Position ${Math.round(o.x)}, ${Math.round(o.y)} · Größe ${Math.round(o.w)} × ${Math.round(o.h)}`),
        o.kind !== 'meeting' && h('div', { class: 'card', style: { padding: '10px', background: '#f8fafc' } },
          h('div', { class: 'row' }, cnt, h('button', { onclick: () => gridDesks(o, +cnt.value) }, 'Plätze im Raster anlegen')),
          h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Ersetzt vorhandene Plätze dieses Raums.')),
        h('div', { class: 'actions' }, h('button', { class: 'danger', onclick: deleteSel }, 'Raum löschen')));
    } else {
      const room = E.rooms.find(r => r.id === o.room);
      fill(props, 
        h('h2', null, 'Arbeitsplatz'),
        h('div', { class: 'muted' }, 'in ', room?.name || '–'),
        h('label', { class: 'field' }, 'Bezeichnung', h('input', { value: o.name, maxlength: 60, oninput: upd('name') })),
        featureChecks(o, 'desk'),
        h('label', { class: 'field' }, 'Weitere Hinweise (Freitext)', h('input', { value: o.equipment, maxlength: 300, placeholder: 'z. B. USB-C-Kabel vorhanden', oninput: upd('equipment') })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!o.active, onchange: upd('active') }), 'Buchbar (aktiv)'),
        h('div', { class: 'actions' },
          h('button', {
            title: 'Ausstattung und Hinweise dieses Platzes auf alle anderen Plätze im selben Raum kopieren',
            onclick: () => {
              const others = E.desks.filter(x => x.room === o.room && x !== o);
              for (const x of others) { x.features = [...(o.features || [])]; x.equipment = o.equipment; }
              markDirty(); render(); toast(`Ausstattung auf ${others.length} weitere Plätze übertragen`, 'ok');
            },
          }, 'Auf alle Plätze im Raum übertragen'),
          h('button', { class: 'danger', onclick: deleteSel }, 'Platz löschen')));
    }
  }

  async function gridDesks(r, n) {
    if (!(n > 0)) return;
    const existing = E.desks.filter(d => d.room === r.id);
    if (existing.length && !await confirmDialog('Plätze ersetzen', `Die ${existing.length} vorhandenen Plätze in „${r.name}“ werden ersetzt.`, 'Ersetzen')) return;
    E.desks = E.desks.filter(d => d.room !== r.id);
    const cols = Math.max(1, Math.round(Math.sqrt(n * r.w / r.h)));
    const rows = Math.ceil(n / cols);
    const top = 40; // Platz für Beschriftung
    const ih = Math.max(10, r.h - top);
    let k = 0;
    for (let i = 0; i < rows && k < n; i++) {
      for (let j = 0; j < cols && k < n; j++, k++) {
        E.desks.push({ id: 'n' + (++E.n), room: r.id, name: nextDeskName(), equipment: '', active: 1, features: [],
          x: Math.round(r.x + (j + .5) * r.w / cols), y: Math.round(r.y + top + (i + .5) * ih / rows) });
      }
    }
    markDirty(); render();
    toast(`${n} Plätze angelegt`, 'ok');
  }

  function loadImage(file) {
    fileInp.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('Datei zu groß (max. 25 MB)', 'error'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        let url = rd.result;
        const MAXW = 2400;
        // große Bilder verkleinern, damit die Datenbank schlank bleibt
        if (img.naturalWidth > MAXW || file.size > 3 * 1024 * 1024) {
          const sc = Math.min(1, MAXW / img.naturalWidth);
          const c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
          const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(img, 0, 0, c.width, c.height);
          url = c.toDataURL('image/jpeg', .88);
        }
        if (url.length > 11 * 1024 * 1024) { toast('Bild ist auch nach Verkleinerung zu groß', 'error'); return; }
        const oldW = E.W, oldH = E.H;
        E.W = 1200; E.H = Math.round(1200 * img.naturalHeight / img.naturalWidth);
        // vorhandene Räume/Plätze mitskalieren
        if (E.rooms.length) {
          const sx = E.W / oldW, sy = E.H / oldH;
          for (const r of E.rooms) { r.x *= sx; r.y *= sy; r.w *= sx; r.h *= sy; }
          for (const d of E.desks) { d.x *= sx; d.y *= sy; }
        }
        wInp.value = E.W; hInp.value = E.H;
        E.img = url; E.imgDirty = true; markDirty(); render();
        toast('Grundriss geladen – jetzt Räume darüber zeichnen.', 'ok');
      };
      img.onerror = () => toast('Bild konnte nicht gelesen werden', 'error');
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  }

  async function save() {
    saveBtn.disabled = true;
    try {
      const body = {
        width: Math.round(E.W), height: Math.round(E.H),
        rooms: E.rooms.map(({ id, name, kind, capacity, equipment, color, features, access, x, y, w, h: hh }) => ({ id, name, kind, capacity, equipment, color, features, access: access || [], x, y, w, h: hh })),
        desks: E.desks.map(({ id, room, name, equipment, active, features, x, y }) => ({ id, room, name, equipment, active, features, x, y })),
      };
      if (E.imgDirty) body.plan_image = E.img;
      const f = await api('PUT', `/api/floors/${fid}/layout`, body);
      S.floorCache.set(fid, f);
      E.rooms = f.rooms.map(r => ({ ...r })); E.desks = f.desks.map(d => ({ ...d, room: d.room_id }));
      E.W = f.width; E.H = f.height; E.imgDirty = false; E.dirty = false; E.sel = null;
      updTitle(); render(); renderProps();
      toast('Raumplan gespeichert', 'ok');
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  }

  render(); renderProps();
}

// ---------------------------------------------------------------- Admin: Alle Buchungen
async function viewAllBookings() {
  const main = clearMain();
  const from = h('input', { type: 'date', value: today() });
  const to = h('input', { type: 'date', value: addDays(today(), 30) });
  const q = h('input', { placeholder: 'Person, Raum, Platz …', oninput: () => draw() });
  const wrap = h('div');
  let list = [];
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Alle Buchungen')),
    h('div', { class: 'toolbar' }, h('label', { class: 'field' }, 'Von', from), h('label', { class: 'field' }, 'Bis', to),
      h('button', { onclick: () => load() }, 'Anzeigen'), h('label', { class: 'field' }, 'Filter', q), h('span', { class: 'spacer' }),
      h('button', { onclick: exportCsv }, 'CSV-Export')), wrap);
  const filtered = () => { const t = q.value.toLowerCase(); return list.filter(b => !t || [b.user_name, b.username, b.room_name, b.desk_name, b.building_name, b.floor_name, b.note].join(' ').toLowerCase().includes(t)); };
  function draw() {
    const l = filtered();
    wrap.replaceChildren(h('p', { class: 'muted' }, `${l.length} Buchungen`), l.length ? bookingTable(l, true, load) : h('div', { class: 'card empty' }, 'Keine Buchungen im Zeitraum.'));
  }
  async function load() { try { list = await api('GET', `/api/bookings?from=${from.value}&to=${to.value}`); draw(); } catch (e) { fail(e); } }
  function exportCsv() {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Datum', 'Von', 'Bis', 'Person', 'Benutzername', 'Gebäude', 'Etage', 'Raum', 'Platz', 'Notiz']]
      .concat(filtered().map(b => [b.day, b.start, b.end, b.user_name, b.username, b.building_name, b.floor_name, b.room_name, b.desk_name || '', b.note]));
    download(`buchungen_${from.value}_${to.value}.csv`, '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  await load();
}

// ---------------------------------------------------------------- Admin: Einstellungen
async function viewSettings() {
  const main = clearMain();
  const st = await api('GET', '/api/settings');
  const f = {};
  const inp = (k, attrs) => (f[k] = h('input', { value: st[k], ...attrs }));
  const chk = k => (f[k] = h('input', { type: 'checkbox', checked: st[k] === '1' }));
  const err = h('div', { class: 'err' });
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Einstellungen')),
    h('div', { class: 'card' }, h('h2', null, 'Allgemein'), h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Name der Anwendung', inp('company_name', { maxlength: 80 })),
      h('label', { class: 'field' }, 'Max. Tage im Voraus buchbar', inp('max_days_ahead', { type: 'number', min: 0, max: 365 })))),
    h('div', { class: 'card' }, h('h2', null, 'Buchungszeiten'), h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Buchbar ab', inp('day_start', { type: 'time', step: 900 })),
      h('label', { class: 'field' }, 'Buchbar bis', inp('day_end', { type: 'time', step: 900 })),
      h('label', { class: 'field' }, 'Standard-Beginn', inp('default_start', { type: 'time', step: 900 })),
      h('label', { class: 'field' }, 'Standard-Ende', inp('default_end', { type: 'time', step: 900 })),
      h('label', { class: 'check full' }, chk('allow_series'), 'Serienbuchungen (wiederkehrend Mo–Fr) für alle Benutzer erlauben'),
      h('label', { class: 'check full' }, chk('one_desk_per_user'), 'Pro Person nur ein Arbeitsplatz gleichzeitig'))),
    adCard(st, inp, chk),
    h('div', { class: 'card' }, h('h2', null, 'Datenschutz'),
      h('p', { class: 'muted small', style: { margin: 0 } }, 'Alle Daten liegen ausschließlich lokal in der SQLite-Datei data/opendesksharing.db. Es werden keine externen Dienste, Schriftarten, CDNs, Tracking oder Analyse-Tools verwendet. Der Server protokolliert standardmäßig keine IP-Adressen. Buchungen werden nicht automatisch gelöscht. Namen erscheinen am Platz/Raum nur, wenn die Person das bei der Buchung ausdrücklich angehakt hat. Die Auswertungen enthalten keine Personendaten. Jede Person kann ihre gespeicherten Daten unter „Profil“ exportieren (Art. 15 DSGVO); beim Löschen eines Benutzers werden seine Buchungen entfernt und nur anonym (Platz/Raum, Datum, Uhrzeit) für die Auswertung behalten.')),
    h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', {
      class: 'primary', onclick: async () => {
        err.textContent = '';
        const data = {};
        for (const [k, el] of Object.entries(f)) data[k] = el.type === 'checkbox' ? el.checked : el.value;
        try { S.settings = await api('PUT', '/api/settings', data); S.sel.start = S.sel.end = null; renderHeader(); toast('Einstellungen gespeichert', 'ok'); } catch (e) { err.textContent = e.message; }
      },
    }, 'Speichern'), err));
  main.append(await closureAdmin());
  main.append(await featureAdmin());
  main.append(await tlsCard());
  main.append(h('div', { class: 'card', style: { marginTop: '24px' } }, h('h2', null, 'System'),
    h('div', { class: 'muted' }, `Programmversion: `, h('b', { style: { color: 'var(--text)' } }, S.version || '–')),
    updateBox()));
}

// Updates von GitHub (Einstellungen → System). GitHub wird nur auf Knopfdruck kontaktiert.
function updateBox() {
  const out = h('div', { class: 'update-box' });
  const btn = h('button', {
    onclick: async () => {
      btn.disabled = true; fill(out, h('span', { class: 'muted' }, 'Frage GitHub nach der neuesten Version …'));
      try { show(await api('GET', '/api/update/check')); } catch (e) { fill(out, h('div', { class: 'ad-bad' }, '✗ ', e.message)); } finally { btn.disabled = false; }
    },
  }, 'Nach Updates suchen');
  function show(r) {
    if (!r.newer) { fill(out, h('div', { class: 'ad-ok' }, `✓ Version ${r.current} ist aktuell.`)); return; }
    const inst = h('button', {
      class: 'primary', disabled: !r.can_install, onclick: async () => {
        if (!await confirmDialog('Update installieren', `Version ${r.latest} jetzt von GitHub laden und installieren? OpenDeskSharing ist dabei etwa 1 Minute nicht erreichbar. Programm und Datenbank werden vorher gesichert; bei Problemen wird automatisch die bisherige Version wiederhergestellt.`, 'Jetzt installieren')) return;
        inst.disabled = true; btn.disabled = true;
        try {
          const res = await api('POST', '/api/update/install', {});
          wait(r.latest, res.log);
        } catch (e) { fill(out, h('div', { class: 'ad-bad' }, '✗ ', e.message)); btn.disabled = false; }
      },
    }, `Version ${r.latest} installieren`);
    fill(out,
      h('div', null, h('b', null, `Neue Version ${r.latest} verfügbar`), ` (installiert: ${r.current}${r.published ? ', veröffentlicht am ' + new Date(r.published).toLocaleDateString('de-DE') : ''})`),
      r.notes && h('pre', { class: 'release-notes' }, r.notes),
      r.can_install ? null : h('div', { class: 'ad-bad' }, r.reason),
      h('div', { class: 'row' }, inst, h('a', { href: r.page, target: '_blank', rel: 'noopener' }, 'Auf GitHub ansehen')));
  }
  function wait(target, log) {
    const t0 = Date.now();
    fill(out, h('div', null, h('b', null, `Update auf ${target} läuft …`), h('div', { class: 'muted small' }, 'Paket geladen und geprüft. Der Server wird jetzt neu gestartet – diese Seite lädt automatisch neu, sobald er wieder da ist.')));
    const tick = async () => {
      try {
        const r = await fetch('/api/version', { cache: 'no-store' }).then(x => x.json());
        if (r.version === target) { toast(`Update auf ${target} erfolgreich`, 'ok'); setTimeout(() => location.reload(), 1200); return; }
      } catch { /* Server startet gerade neu */ }
      if (Date.now() - t0 > 240000) {
        fill(out, h('div', { class: 'ad-bad' }, `Die neue Version meldet sich nach 4 Minuten nicht. Bitte am Server das Protokoll ${log} prüfen – bei einem Fehler wurde die bisherige Version automatisch wiederhergestellt.`));
        return;
      }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 8000);
  }
  return h('div', { style: { marginTop: '12px' } },
    h('div', { class: 'row' }, btn, h('span', { class: 'muted small' }, 'Fragt GitHub (github.com/phillhf/OpenDeskSharing) nach einer neuen Version – nur bei Klick, sonst arbeitet OpenDeskSharing komplett offline.')),
    out,
    h('p', { class: 'muted small', style: { marginBottom: 0 } }, 'Ohne Internet: Paket (ZIP) von GitHub herunterladen und am Server mit „Installieren.bat“ einspielen. Programm und Datenbank werden vor jedem Update automatisch gesichert.'));
}

// Anmeldung mit Windows-/AD-Konto (Einstellungen)
function adCard(st, inp, chk) {
  const tUser = h('input', { autocomplete: 'off', placeholder: 'z. B. mmustermann' });
  const tPw = h('input', { type: 'password', autocomplete: 'new-password' });
  const out = h('div', { class: 'ad-result' });
  const btn = h('button', {
    type: 'button', onclick: async () => {
      btn.disabled = true; fill(out, h('span', { class: 'muted' }, 'Prüfe …'));
      try {
        const val = k => document.querySelector(`[data-ad="${k}"]`).value.trim();
        const r = await api('POST', '/api/ad/test', { username: tUser.value, password: tPw.value, ad_domain: val('ad_domain'), ad_user_group: val('ad_user_group'), ad_admin_group: val('ad_admin_group') });
        tPw.value = '';
        if (!r.ok) { fill(out, h('div', { class: 'ad-bad' }, '✗ ', r.error)); return; }
        const grp = (k, name) => name && h('li', null, `Gruppe „${name}“: `, r.group_errors[k] ? h('b', { class: 'ad-bad' }, r.group_errors[k]) : r.member[k] ? h('b', null, 'Mitglied') : 'kein Mitglied');
        fill(out,
          h('div', { class: 'ad-ok' }, '✓ Windows-Anmeldung erfolgreich'),
          h('ul', null,
            h('li', null, 'Konto: ', h('b', null, `${r.domain}\\${r.username}`)),
            h('li', null, 'Anzeigename: ', h('b', null, r.display_name)),
            grp('user', val('ad_user_group')), grp('admin', val('ad_admin_group'))),
          Object.keys(r.group_errors).length ? h('div', { class: 'ad-bad' }, '✗ Bitte den Gruppennamen prüfen – so würde niemand hereinkommen.')
            : r.access ? h('div', null, '→ Zugang: ', h('b', null, 'ja'), ', als ', h('b', null, r.role === 'admin' ? 'Administrator' : 'Benutzer'),
              r.role_from_group ? ' (laut Admin-Gruppe)' : r.existing ? ' (wie in der Benutzerverwaltung)' : '',
              r.existing ? '' : ' – wird beim ersten Anmelden automatisch angelegt.')
              : h('div', { class: 'ad-bad' }, '→ Kein Zugang: ', r.reason));
      } catch (e) { fill(out, h('div', { class: 'ad-bad' }, '✗ ', e.message)); } finally { btn.disabled = false; }
    },
  }, 'Anmeldung testen');
  const field = (k, label, ph) => { const el = inp(k, { placeholder: ph, maxlength: 150 }); el.dataset.ad = k; return h('label', { class: 'field' }, label, el); };
  return h('div', { class: 'card' }, h('h2', null, 'Anmeldung mit Windows-Konto (Active Directory)'),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Mitarbeiter melden sich mit ihrem Windows-Benutzernamen und -Passwort an. Das Passwort prüft Windows – OpenDeskSharing speichert es nicht. Beim ersten Anmelden wird der Benutzer automatisch angelegt. Voraussetzung: Der Server ist Mitglied der Domäne. Konten mit eigenem OpenDeskSharing-Passwort (z. B. „admin“) funktionieren weiterhin.'),
    h('div', { class: 'form-grid' },
      h('label', { class: 'check full' }, chk('ad_enabled'), 'Anmeldung mit Windows-Konto einschalten'),
      field('ad_domain', 'Domäne *', 'z. B. FIRMA oder firma.local'),
      h('span'),
      field('ad_user_group', 'Gruppe mit Zugang (leer = alle Konten der Domäne)', 'z. B. OpenDeskSharing-Benutzer'),
      field('ad_admin_group', 'Gruppe der Administratoren (leer = Rolle von Hand vergeben)', 'z. B. OpenDeskSharing-Admins')),
    h('h3', { style: { marginBottom: '4px' } }, 'Einstellungen testen'),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, 'Prüft ein Windows-Konto mit den oben eingetragenen (auch noch nicht gespeicherten) Werten. Es wird dabei nichts angelegt oder geändert.'),
    h('div', { class: 'row', style: { alignItems: 'flex-end', flexWrap: 'wrap', gap: '8px' } },
      h('label', { class: 'field', style: { margin: 0 } }, 'Windows-Benutzername', tUser),
      h('label', { class: 'field', style: { margin: 0 } }, 'Passwort', tPw), btn),
    out);
}

// HTTPS-Status (Einstellungen)
async function tlsCard() {
  const t = await api('GET', '/api/tls');
  const card = h('div', { class: 'card', style: { marginTop: '24px' } }, h('h2', null, 'Verschlüsselung (HTTPS)'));
  if (!t.enabled) {
    card.append(h('p', { class: 'ad-bad', style: { margin: 0 } }, 'HTTPS ist ausgeschaltet – Passwörter werden unverschlüsselt übertragen. Beim Einspielen eines Updates mit „Installieren.bat“ wird HTTPS eingeschaltet.'));
    return card;
  }
  if (t.mode === 'own') {
    card.append(h('p', { style: { margin: 0 } }, '✓ HTTPS aktiv mit eigenem Zertifikat: ', h('code', null, t.file)));
    return card;
  }
  card.append(
    h('p', { style: { marginTop: 0 } }, '✓ HTTPS aktiv. Das Zertifikat hat OpenDeskSharing selbst erstellt; es wird automatisch erneuert.'),
    h('ul', { class: 'small' },
      h('li', null, 'Gültig für: ', h('b', null, (t.names || []).join(', '))),
      h('li', null, 'Serverzertifikat gültig bis: ', t.not_after ? new Date(t.not_after).toLocaleDateString('de-DE') : '–'),
      h('li', null, 'Fingerabdruck des Stammzertifikats (SHA1): ', h('code', null, t.ca_fingerprint))),
    h('p', { class: 'muted small' }, 'Damit die Browser an den Arbeitsplätzen keine Warnung zeigen, muss das Stammzertifikat dort als vertrauenswürdig eingetragen werden – am einfachsten per Gruppenrichtlinie: Computerkonfiguration → Richtlinien → Windows-Einstellungen → Sicherheitseinstellungen → Richtlinien für öffentliche Schlüssel → Vertrauenswürdige Stammzertifizierungsstellen → Importieren.'),
    h('a', { class: 'btn', href: '/OpenDeskSharing-Stammzertifikat.cer' }, 'Stammzertifikat herunterladen'));
  return card;
}

// Feiertage & Schließtage (Einstellungen)
const GERMAN_STATES = [['BW', 'Baden-Württemberg'], ['BY', 'Bayern'], ['BE', 'Berlin'], ['BB', 'Brandenburg'], ['HB', 'Bremen'], ['HH', 'Hamburg'],
  ['HE', 'Hessen'], ['MV', 'Mecklenburg-Vorpommern'], ['NI', 'Niedersachsen'], ['NW', 'Nordrhein-Westfalen'], ['RP', 'Rheinland-Pfalz'],
  ['SL', 'Saarland'], ['SN', 'Sachsen'], ['ST', 'Sachsen-Anhalt'], ['SH', 'Schleswig-Holstein'], ['TH', 'Thüringen']];

async function closureAdmin() {
  const card = h('div', { class: 'card', style: { marginTop: '24px' } });
  const act = async (fn, msg, type = 'ok') => { try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg, typeof type === 'function' ? type(r) : type); await draw(); } catch (e) { fail(e); } };
  const KIND = { closed: ['Schließtag', ''], holiday: ['Feiertag (manuell)', ' meeting'], open: ['Ausnahme – kein Feiertag', ' feat'] };
  async function draw() {
    const [pv, list, blds] = await Promise.all([api('GET', '/api/holidays/preview'), api('GET', '/api/closures/manual'), api('GET', '/api/buildings')]);
    const bldOpts = () => [h('option', { value: '' }, 'Alle Gebäude'), ...blds.map(b => h('option', { value: b.id }, b.name))];

    // --- Gesetzliche Feiertage: automatisch
    const stateSel = h('select', {
      value: pv.default_state || '',
      onchange: () => act(() => api('PUT', '/api/settings', { holiday_state: stateSel.value }).then(r => { S.settings = r; }),
        stateSel.value ? 'Bundesland gespeichert – die Feiertage gelten ab sofort automatisch' : 'Automatische Feiertage ausgeschaltet'),
    }, h('option', { value: '' }, '– keine automatischen Feiertage –'), GERMAN_STATES.map(([k, l]) => h('option', { value: k }, l)));
    const preview = pv.states.map(g => h('div', { class: 'sub-card' },
      h('h3', null, g.state_name, g.buildings.length ? h('span', { class: 'muted small', style: { fontWeight: 400 } }, ` – ${g.buildings.join(', ')}`) : null),
      h('table', { class: 'tbl compact' }, h('tbody', null, g.holidays.map(x => h('tr', { style: x.exception_id ? { opacity: 0.55 } : null },
        h('td', { style: { whiteSpace: 'nowrap' } }, fmtDate(x.day)),
        h('td', null, x.exception_id ? h('s', null, x.name) : x.name, x.exception_id ? h('span', { class: 'muted small' }, ' – ausgenommen') : null),
        h('td', { style: { textAlign: 'right' } }, x.exception_id
          ? h('button', { class: 'small', onclick: () => act(() => api('DELETE', '/api/closures/' + x.exception_id), `${x.name} gilt wieder als Feiertag`) }, 'Wieder aktivieren')
          : h('button', {
            class: 'small', title: 'Falls an diesem Tag gearbeitet wird oder sich die Rechtslage geändert hat',
            onclick: () => act(() => api('POST', '/api/closures/exception', { day: x.day, name: `Ausnahme: ${x.name}` }), `${x.name} ausgenommen – an diesem Tag kann gebucht werden`),
          }, 'Ausnehmen'))))))));

    // --- Manuelle Einträge (Rückfallebene)
    const from = h('input', { type: 'date', value: today() });
    const to = h('input', { type: 'date', value: today() });
    const name = h('input', { placeholder: 'z. B. Betriebsurlaub', maxlength: 100 });
    const kind = h('select', null, h('option', { value: 'closed' }, 'Schließtag / Betriebsurlaub'), h('option', { value: 'holiday' }, 'Zusätzlicher Feiertag'));
    const cb = h('select', null, bldOpts());
    const addBtn = h('button', {
      class: 'primary', style: { marginTop: '10px' },
      onclick: () => act(() => api('POST', '/api/closures', { from: from.value, to: to.value || from.value, name: name.value, kind: kind.value, building_id: cb.value || null }),
        r => `${r.created} Tag(e) eingetragen` + (r.affected_bookings ? ` – Achtung: an diesen Tagen gibt es bereits ${r.affected_bookings} Buchung(en); bitte ggf. unter „Alle Buchungen“ stornieren.` : ''),
        r => (r.affected_bookings ? 'error' : 'ok')),
    }, 'Eintragen');

    fill(card, h('h2', null, 'Feiertage & Schließtage'),
      h('p', { class: 'muted small' }, 'An Feiertagen und Schließtagen ist keine Buchung möglich; in den Auswertungen zählen sie nicht als buchbare Tage.'),
      h('h3', null, 'Gesetzliche Feiertage – automatisch'),
      h('div', { class: 'row', style: { alignItems: 'flex-end' } },
        h('label', { class: 'field' }, 'Standard-Bundesland', stateSel),
        h('span', { class: 'muted small', style: { maxWidth: '520px' } }, 'Die Feiertage werden für jedes Jahr automatisch berechnet – kein jährliches Eintragen nötig. Gebäude in einem anderen Bundesland: unter „Standorte & Pläne“ beim Gebäude einstellen.')),
      !pv.states.length && h('div', { class: 'closure-banner', style: { marginTop: '12px' } }, 'Noch kein Bundesland gewählt – gesetzliche Feiertage werden derzeit nicht berücksichtigt.'),
      pv.buildings_without_state.length > 0 && pv.states.length > 0 && h('p', { class: 'muted small' }, `Ohne Feiertage (kein Bundesland): ${pv.buildings_without_state.join(', ')}`),
      pv.states.length > 0 && h('p', { class: 'muted small', style: { margin: '12px 0 6px' } }, 'Vorschau der nächsten 12 Monate:'),
      h('div', { class: 'closure-forms' }, preview),
      h('h3', { style: { marginTop: '22px' } }, 'Manuelle Einträge (Rückfallebene)'),
      h('p', { class: 'muted small' }, 'Für Betriebsurlaub und Schließtage – oder falls ein Feiertag neu hinzukommt. Bei einem Zeitraum werden nur Werktage (Mo–Fr) eingetragen.'),
      h('div', { class: 'sub-card' }, h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, 'Von', from), h('label', { class: 'field' }, 'Bis', to), h('label', { class: 'field' }, 'Bezeichnung', name),
        h('label', { class: 'field' }, 'Art', kind), h('label', { class: 'field' }, 'Gilt für', cb)), addBtn),
      list.length
        ? h('div', { class: 'tbl-wrap', style: { marginTop: '14px', maxHeight: '340px', overflow: 'auto' } }, h('table', { class: 'tbl' },
          h('thead', null, h('tr', null, h('th', null, 'Datum'), h('th', null, 'Bezeichnung'), h('th', null, 'Art'), h('th', null, 'Gilt für'), h('th'))),
          h('tbody', null, list.map(c => h('tr', { style: c.day < today() ? { opacity: 0.5 } : null },
            h('td', null, fmtDate(c.day)), h('td', null, c.name),
            h('td', null, h('span', { class: 'badge' + (KIND[c.kind] || KIND.closed)[1] }, (KIND[c.kind] || KIND.closed)[0])),
            h('td', null, c.building_name || 'Alle Gebäude'),
            h('td', { style: { textAlign: 'right' } }, h('button', { class: 'small danger', onclick: () => act(() => api('DELETE', '/api/closures/' + c.id), 'Eintrag entfernt') }, 'Entfernen')))))))
        : h('p', { class: 'muted small', style: { marginTop: '10px' } }, 'Keine manuellen Einträge.'));
  }
  await draw();
  return card;
}

async function featureAdmin() {
  const card = h('div', { class: 'card', style: { marginTop: '24px' } });
  const SC = [['desk', 'Arbeitsplätze'], ['room', 'Räume'], ['both', 'Plätze & Räume']];
  const scopeSel = v => h('select', { value: v }, SC.map(([k, l]) => h('option', { value: k }, l)));
  async function draw() {
    const list = await loadFeatures(true);
    const name = h('input', { placeholder: 'z. B. Curved Monitor', maxlength: 60 });
    const scope = scopeSel('desk');
    const add = async () => {
      try { await api('POST', '/api/features', { name: name.value, scope: scope.value, sort: list.length }); await draw(); } catch (e) { fail(e); }
    };
    name.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    fill(card, h('h2', null, 'Ausstattungsmerkmale'),
      h('p', { class: 'muted small' }, 'Merkmale werden im Raumplan-Editor Arbeitsplätzen und Räumen per Häkchen zugeordnet und sind beim Buchen und in den Auswertungen als Filter verfügbar. Änderungen hier werden sofort gespeichert.'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, 'Bezeichnung'), h('th', null, 'Gilt für'), h('th'))),
        h('tbody', null, list.map(f => {
          const n = h('input', { value: f.name, maxlength: 60 });
          const sc = scopeSel(f.scope);
          const save = async () => {
            try { await api('PUT', '/api/features/' + f.id, { name: n.value, scope: sc.value, sort: f.sort }); await loadFeatures(true); toast('Gespeichert', 'ok'); } catch (e) { fail(e); }
          };
          n.addEventListener('change', save); sc.addEventListener('change', save);
          return h('tr', null, h('td', null, n), h('td', null, sc), h('td', { style: { textAlign: 'right' } }, h('button', {
            class: 'small danger', onclick: async () => {
              if (!await confirmDialog('Merkmal löschen', `„${f.name}“ löschen? Die Zuordnung zu allen Plätzen und Räumen wird entfernt.`)) return;
              try { await api('DELETE', '/api/features/' + f.id); S.floorCache.clear(); await draw(); } catch (e) { fail(e); }
            },
          }, 'Löschen')));
        })))),
      h('div', { class: 'row', style: { marginTop: '12px' } }, name, scope, h('button', { class: 'primary', onclick: add }, '+ Hinzufügen')));
  }
  await draw();
  return card;
}

// ---------------------------------------------------------------- Admin: Auswertungen
// Sequenzielle Farbskala (ein Farbton, hell → dunkel) für Heatmap und Matrix
const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];
const fmtPct = (v, d = 0) => (v * 100).toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d }) + ' %';
const fmtNum = (v, d = 1) => Number(v || 0).toLocaleString('de-DE', { maximumFractionDigits: d });
const rampIdx = t => Math.min(RAMP.length - 1, Math.floor(t * RAMP.length));
const rampColor = t => (t > 0 ? RAMP[rampIdx(t)] : 'var(--cell-empty)');
const inkOn = t => (t > 0 && rampIdx(t) >= 6 ? '#fff' : 'var(--text)');

let tipEl = null;
function showTip(ev, lines) {
  tipEl ||= document.body.appendChild(h('div', { class: 'viz-tip', role: 'tooltip' }));
  fill(tipEl, lines.filter(Boolean).map((l, i) => h('div', { class: i ? null : 'tt' }, l)));
  tipEl.style.display = 'block';
  const x = Math.min(ev.clientX + 14, innerWidth - tipEl.offsetWidth - 8);
  const y = ev.clientY - tipEl.offsetHeight - 12;
  tipEl.style.left = x + 'px';
  tipEl.style.top = (y < 8 ? ev.clientY + 18 : y) + 'px';
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

const niceMax = v => (v <= 0 ? 0.1 : [0.05, 0.1, 0.2, 0.25, 0.4, 0.5, 0.6, 0.8, 1].find(x => x >= v) ?? Math.ceil(v * 10) / 10);
const roundTop = (x, y, w, hh, r) => `M${x},${y + hh}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh}Z`;

/** Säulendiagramm (Auslastung in %), zeichnet sich bei Größenänderung neu. */
function barChart(host, rows, { value, label, tip, height = 220 }) {
  const draw = () => {
    const W = Math.max(260, host.clientWidth), H = height, m = { l: 46, r: 8, t: 10, b: 26 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const top = niceMax(Math.max(0, ...rows.map(value)));
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img' });
    const nt = Math.round(top * 100) % 4 === 0 ? 4 : 5; // glatte Prozentschritte
    for (let i = 0; i <= nt; i++) {
      const v = top * i / nt, y = m.t + ih - ih * v / top;
      svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: i ? 'grid' : 'axis' }),
        s('text', { x: m.l - 6, y, class: 'tick', 'text-anchor': 'end', 'dominant-baseline': 'central' }, fmtPct(v)));
    }
    const n = Math.max(1, rows.length), step = iw / n;
    const bw = Math.max(1, Math.min(48, step - Math.max(2, step * 0.25)));
    const every = Math.ceil(n / Math.max(1, Math.floor(iw / 52)));
    rows.forEach((r, i) => {
      const v = value(r), bh = ih * v / top, x = m.l + i * step + (step - bw) / 2;
      const bar = bh > 0 ? s('path', { d: roundTop(x, m.t + ih - bh, bw, bh, Math.min(4, bw / 2, bh)), class: 'bar' }) : null;
      if (bar) svg.append(bar);
      if (i % every === 0) svg.append(s('text', { x: x + bw / 2, y: H - 8, class: 'tick', 'text-anchor': 'middle' }, label(r)));
      const hit = s('rect', { x: m.l + i * step, y: m.t, width: step, height: ih, class: 'hit' });
      hit.addEventListener('pointermove', ev => { bar?.classList.add('hover'); showTip(ev, tip(r)); });
      hit.addEventListener('pointerleave', () => { bar?.classList.remove('hover'); hideTip(); });
      svg.append(hit);
    });
    host.replaceChildren(svg);
  };
  draw();
  let lastW = host.clientWidth;
  new ResizeObserver(() => { if (host.isConnected && host.clientWidth !== lastW) { lastW = host.clientWidth; draw(); } }).observe(host);
}

/** Heatmap Wochentag × Uhrzeit */
function heatmap(host, heat) {
  const max = Math.max(0, ...heat.flatMap(r => r.cells.map(c => c.util)));
  const hours = heat[0]?.cells.map(c => c.hour) || [];
  const grid = h('div', { class: 'heat' });
  grid.style.gridTemplateColumns = `34px repeat(${hours.length}, minmax(30px, 1fr))`;
  grid.append(h('div'), ...hours.map(x => h('div', { class: 'hh' }, pad(x))));
  for (const row of heat) {
    grid.append(h('div', { class: 'hd' }, row.label));
    for (const c of row.cells) {
      const t = max ? c.util / max : 0;
      const cell = h('div', { class: 'hc' }, c.util > 0 ? Math.round(c.util * 100) : '');
      cell.style.background = rampColor(t); cell.style.color = inkOn(t);
      cell.addEventListener('pointermove', ev => showTip(ev, [`${row.label}, ${pad(c.hour)}:00–${pad(c.hour + 1)}:00 Uhr`, `Auslastung: ${fmtPct(c.util, 1)}`, `Belegt: ${fmtNum(c.hours)} Std.`]));
      cell.addEventListener('pointerleave', hideTip);
      grid.append(cell);
    }
  }
  const ramp = h('span', { class: 'ramp' });
  ramp.style.background = `linear-gradient(90deg, ${RAMP.join(',')})`;
  fill(host, h('div', { class: 'heat-scroll' }, grid),
    h('div', { class: 'heat-legend' }, 'Zellwerte = Auslastung in %', h('span', { class: 'spacer' }), 'niedrig', ramp, `hoch (${fmtPct(max)})`));
}

async function viewStats() {
  const main = clearMain();
  await loadFeatures();
  S.buildings = await api('GET', '/api/buildings');
  const F = S.statsF ||= { preset: '30', from: addDays(today(), -29), to: today(), kind: 'desk', building: '', floor: '', room: '', resource: '', feat: '', weekends: false, gran: 'auto' };
  F.basis ||= 'booked';
  const GR = { day: 'Tag', week: 'Woche', month: 'Monat', year: 'Jahr' };
  const PRESETS = [['7', 'Letzte 7 Tage'], ['30', 'Letzte 30 Tage'], ['90', 'Letzte 90 Tage'], ['365', 'Letzte 12 Monate'],
    ['month', 'Dieser Monat'], ['lastmonth', 'Letzter Monat'], ['quarter', 'Dieses Quartal'], ['year', 'Dieses Jahr'], ['lastyear', 'Letztes Jahr'], ['custom', 'Benutzerdefiniert']];
  const applyPreset = p => {
    const t = new Date(), y = t.getFullYear(), mo = t.getMonth();
    if (/^\d+$/.test(p)) { F.from = addDays(today(), -(+p - 1)); F.to = today(); }
    else if (p === 'month') { F.from = isoDate(new Date(y, mo, 1)); F.to = isoDate(new Date(y, mo + 1, 0)); }
    else if (p === 'lastmonth') { F.from = isoDate(new Date(y, mo - 1, 1)); F.to = isoDate(new Date(y, mo, 0)); }
    else if (p === 'quarter') { const q = mo - mo % 3; F.from = isoDate(new Date(y, q, 1)); F.to = isoDate(new Date(y, q + 3, 0)); }
    else if (p === 'year') { F.from = `${y}-01-01`; F.to = `${y}-12-31`; }
    else if (p === 'lastyear') { F.from = `${y - 1}-01-01`; F.to = `${y - 1}-12-31`; }
  };
  const autoGran = () => { const d = (new Date(F.to) - new Date(F.from)) / 864e5 + 1; return d <= 31 ? 'day' : d <= 186 ? 'week' : d <= 1100 ? 'month' : 'year'; };

  const filterRow = h('div', { class: 'toolbar' });
  const content = h('div');
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const renderTabs = () => fill(tabs, [['desk', 'Arbeitsplätze'], ['room', 'Besprechungsräume']].map(([k, l]) => h('button', {
    role: 'tab', 'aria-selected': String(F.kind === k), class: F.kind === k ? 'active' : null,
    onclick: () => { if (F.kind === k) return; F.kind = k; F.room = ''; F.resource = ''; F.feat = ''; renderTabs(); renderFilters(); load(); },
  }, l)));
  renderTabs();
  main.append(h('div', { class: 'page-head' }, h('h1', null, 'Auswertungen'), tabs,
    h('span', { class: 'muted small' }, 'ohne Personenbezug')), filterRow, content);

  async function renderFilters() {
    const sel = (key, opts, onchange) => h('select', { value: F[key], onchange: ev => { F[key] = ev.target.value; onchange?.(); load(); } }, opts.map(([v, l]) => h('option', { value: v }, l)));
    const bld = S.buildings.find(b => String(b.id) === String(F.building));
    let rooms = [];
    if (F.floor) { try { rooms = (await getFloor(+F.floor)).rooms.filter(r => r.kind !== 'other' && r.kind !== 'meeting'); } catch { /* egal */ } }
    const fromI = h('input', { type: 'date', value: F.from, onchange: ev => { if (ev.target.value) { F.from = ev.target.value; F.preset = 'custom'; renderFilters(); load(); } } });
    const toI = h('input', { type: 'date', value: F.to, onchange: ev => { if (ev.target.value) { F.to = ev.target.value; F.preset = 'custom'; renderFilters(); load(); } } });
    fill(filterRow,
      h('label', { class: 'field' }, 'Zeitraum', sel('preset', PRESETS, () => { applyPreset(F.preset); renderFilters(); })),
      h('label', { class: 'field' }, 'Von', fromI), h('label', { class: 'field' }, 'Bis', toI),
      h('label', { class: 'field' }, 'Grundlage', sel('basis', [['booked', 'Gebuchte Zeit'], ['used', 'Tatsächlich genutzt (Check-in)']])),
      h('label', { class: 'field' }, 'Gebäude', sel('building', [['', 'Alle'], ...S.buildings.map(b => [String(b.id), b.name])], () => { F.floor = ''; F.room = ''; F.resource = ''; renderFilters(); })),
      h('label', { class: 'field' }, 'Etage', sel('floor', [['', 'Alle'], ...(bld ? bld.floors.map(f => [String(f.id), f.name]) : [])], () => { F.room = ''; F.resource = ''; renderFilters(); })),
      F.kind === 'desk' && F.floor && h('label', { class: 'field' }, 'Raum', sel('room', [['', 'Alle'], ...rooms.map(r => [String(r.id), r.name])], () => { F.resource = ''; })),
      h('label', { class: 'field' }, 'Ausstattung', sel('feat', [['', 'Beliebig'], ...S.features.filter(f => f.scope === 'both' || f.scope === F.kind).map(f => [String(f.id), f.name])], () => { F.resource = ''; })),
      h('label', { class: 'field' }, 'Verlauf je', sel('gran', [['auto', `Automatisch (${GR[autoGran()]})`], ['day', 'Tag'], ['week', 'Woche'], ['month', 'Monat'], ['year', 'Jahr']])),
      h('label', { class: 'check', style: { alignSelf: 'center', marginTop: '16px' } },
        h('input', { type: 'checkbox', checked: F.weekends, onchange: ev => { F.weekends = ev.target.checked; load(); } }), 'Wochenenden einbeziehen'));
  }

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const gran = F.gran === 'auto' ? autoGran() : F.gran;
    const qs = new URLSearchParams({ from: F.from, to: F.to, kind: F.kind, gran, weekends: F.weekends ? '1' : '0' });
    for (const k of ['building', 'floor', 'room', 'resource']) if (F[k]) qs.set(k, F[k]);
    if (F.kind === 'room') qs.delete('room');
    if (F.feat) qs.set('features', F.feat);
    qs.set('basis', F.basis);
    content.style.opacity = '.5';
    try {
      const dq = new URLSearchParams({ from: F.from, to: F.to, kind: F.kind });
      if (F.building) dq.set('building', F.building);
      const [R, D] = await Promise.all([api('GET', '/api/stats?' + qs), api('GET', '/api/demand?' + dq)]);
      R.demand = D;
      if (seq === loadSeq) render(R);
    } catch (e) { fail(e); } finally { if (seq === loadSeq) content.style.opacity = ''; }
  }

  function render(R) {
    const T = R.totals;
    const unit = R.kind === 'desk' ? 'Arbeitsplätze' : 'Besprechungsräume';
    const one = R.kind === 'desk' ? 'Platz' : 'Raum';
    const days = `${R.weekends ? 'Mo–So' : 'Mo–Fr'}, ${R.day_start}–${R.day_end} Uhr`;
    if (!T.resources) {
      fill(content, h('div', { class: 'card empty' }, `Keine passenden ${unit} für diese Filter gefunden.`), h('div', { class: 'chart-grid' }, demandCard(R, unit)));
      return;
    }
    const kpi = (label, val, sub) => h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, label), h('div', { class: 'k-val' }, val), h('div', { class: 'k-sub' }, sub));
    const chartCard = (title, sub, full) => {
      const host = h('div');
      return { host, card: h('div', { class: 'card' + (full ? ' full' : '') }, h('h2', null, title, sub && h('small', null, sub)), host) };
    };
    const selected = F.resource && R.resources[0];
    const A = R.attendees;
    const hasAtt = !!(A && A.count);

    const basisTxt = R.basis === 'used' ? 'tatsächlich genutzt' : 'gebucht';
    const series = chartCard(`Auslastung im Verlauf – je ${GR[R.gran]}`, `${basisTxt} · ${days}`, true);
    const conc = chartCard(`Wie viele ${unit} waren gleichzeitig belegt?`, 'Anteil der buchbaren Zeit');
    const groups = hasAtt ? chartCard('Gruppengrößen – Personen je Besprechung', `${A.count} Besprechungen mit Teilnehmerangabe`) : null;
    const hourly = chartCard('Tagesprofil – Auslastung nach Uhrzeit', 'Durchschnitt über den Zeitraum');
    const weekly = chartCard('Auslastung nach Wochentag', 'Durchschnitt über den Zeitraum');
    const heat = chartCard('Spitzenzeiten – Wochentag × Uhrzeit', 'Durchschnittliche Auslastung je Stunde', true);
    const slotList = (title, list) => h('div', null, h('h3', null, title),
      list.length ? h('ul', { class: 'slot-list' }, list.map(x => h('li', null, h('span', null, `${x.wd}, ${pad(x.hour)}:00–${pad(x.hour + 1)}:00`), h('b', null, fmtPct(x.util, 1)))))
        : h('p', { class: 'muted small' }, 'Keine Daten'));

    fill(content,
      selected && h('div', { class: 'feat-bar' }, h('span', { class: 'muted small' }, 'Einzelauswertung:'),
        h('button', { class: 'chip active', onclick: () => { F.resource = ''; load(); } }, `${selected.name} (${selected.room_name}) ×`)),
      h('div', { class: 'kpis' },
        kpi('Ø Auslastung', fmtPct(T.util, 1), `${fmtNum(T.hours)} von ${fmtNum(T.capacity_hours, 0)} buchbaren Std.`),
        kpi('Belegte Stunden', fmtNum(T.hours), `${fmtNum(T.bookings, 0)} Buchungen an ${T.days} Tagen`),
        kpi(`Ø Std. je ${one} und Tag`, fmtNum(T.hours / T.resources / Math.max(1, T.days), 2), `von ${fmtNum(R.open_hours)} möglichen Std.`),
        kpi('Spitzenbelegung', `${T.peak.value} von ${T.resources}`, T.peak.day ? `gleichzeitig am ${fmtDate(T.peak.day)}, ${T.peak.time} Uhr` : 'keine Buchungen'),
        kpi('Ø Tagesspitze', fmtNum(T.avg_daily_peak), `${unit} gleichzeitig belegt (Ø je Tag)`),
        kpi('Nie gebucht', `${T.resources - T.used_resources} von ${T.resources}`, unit + ' im Zeitraum'),
        kpi('Vollbelegung', fmtPct(T.full_share, 1), `der Zeit waren alle ${T.resources} ${unit} gleichzeitig belegt (${fmtNum(T.full_hours)} Std.)`),
        hasAtt && kpi('Ø Teilnehmer', fmtNum(A.avg, 1), `Personen je Besprechung (${A.count} mit Angabe)`),
        hasAtt && kpi('Ø Sitzplatz-Auslastung', A.seat_util == null ? '–' : fmtPct(A.seat_util, 0), 'Teilnehmer ÷ Sitzplätze des Raums')),
      checkinCard(R, unit),
      h('div', { class: 'chart-grid' }, assessCard(R, unit), conc.card, groups && groups.card, demandCard(R, unit), series.card, hourly.card, weekly.card, heat.card,
        h('div', { class: 'card full' }, h('h2', null, `${unit} im Vergleich`, h('small', null, 'Zeile anklicken für Einzelauswertung')), resTable(R)),
        h('div', { class: 'card full' }, h('h2', null, `Belegte Stunden je ${one} und ${GR[R.gran]}`, h('small', null, 'Farbe = Auslastung des Abschnitts')), matrixTable(R))),
      h('p', { class: 'muted small' }, `Grundlage sind Buchungen (nicht die tatsächliche Anwesenheit). Auslastung = gebuchte Stunden ÷ buchbare Stunden (${days}). Stornierte Buchungen zählen nicht.${R.closed_days ? ` ${R.closed_days} Feiertag(e)/Schließtag(e) sind nicht als buchbare Tage mitgezählt.` : ''}`));

    barChart(series.host, R.series, {
      value: r => r.util, label: r => R.gran === 'day' ? r.label.slice(3) : r.label,
      tip: r => [r.label, `Auslastung: ${fmtPct(r.util, 1)}`, `Belegt: ${fmtNum(r.hours)} Std.`, `Spitze: ${r.peak} gleichzeitig`],
    });
    barChart(hourly.host, R.by_hour, {
      value: r => r.util, label: r => pad(r.hour),
      tip: r => [`${pad(r.hour)}:00–${pad(r.hour + 1)}:00 Uhr`, `Auslastung: ${fmtPct(r.util, 1)}`, `Belegt: ${fmtNum(r.hours)} Std. gesamt`],
    });
    barChart(weekly.host, R.by_weekday, {
      value: r => r.util, label: r => r.label,
      tip: r => [r.label, `Auslastung: ${fmtPct(r.util, 1)}`, `Belegt: ${fmtNum(r.hours)} Std. gesamt`],
    });
    heatmap(heat.host, R.heat);
    barChart(conc.host, R.concurrency, {
      value: r => r.share, label: r => String(r.k),
      tip: r => [`${r.k} von ${T.resources} ${unit} gleichzeitig belegt`, `${fmtPct(r.share, 1)} der buchbaren Zeit`, `${fmtNum(r.hours)} Std.`],
    });
    if (groups) barChart(groups.host, A.dist, {
      value: r => r.share, label: r => r.label,
      tip: r => [`${r.label} ${r.label === '1' ? 'Person' : 'Personen'}`, `${r.count} Besprechungen`, `${fmtPct(r.share, 1)} aller Besprechungen`],
    });
    heat.card.append(h('div', { class: 'slot-cols' }, slotList('Stärkste Zeiten', R.busiest), slotList('Ruhigste Zeiten', R.quietest)));
  }

  // Einschätzung: reicht die Anzahl an Plätzen/Räumen?
  function assessCard(R, unit) {
    const T = R.totals, n = T.resources, notes = [];
    let cum = 0, k95 = n;
    for (const c of R.concurrency) { cum += c.share; if (cum >= 0.95) { k95 = c.k; break; } }
    if (T.bookings === 0) notes.push('Im gewählten Zeitraum gibt es keine Buchungen.');
    else {
      notes.push(k95 === 0 ? `In mindestens 95 % der buchbaren Zeit war keiner der ${n} ${unit} belegt.` : `In 95 % der buchbaren Zeit waren höchstens ${k95} von ${n} ${unit} gleichzeitig belegt.`);
      if (T.peak.value < n) notes.push(`Es waren nie mehr als ${T.peak.value} ${unit} gleichzeitig belegt – ${n - T.peak.value} wurden im Zeitraum nie gleichzeitig benötigt.`);
      if (T.full_share >= 0.05) notes.push(`⚠ In ${fmtPct(T.full_share, 1)} der Zeit waren alle ${unit} belegt – das deutet auf einen Engpass hin.`);
      else if (T.peak.value >= n) notes.push(`Vollbelegung kam vor, aber selten (${fmtPct(T.full_share, 1)} der Zeit).`);
      if (T.util < 0.2) notes.push(`Die durchschnittliche Auslastung ist mit ${fmtPct(T.util, 1)} niedrig.`);
      else if (T.util > 0.7) notes.push(`Die durchschnittliche Auslastung ist mit ${fmtPct(T.util, 1)} hoch.`);
      const A = R.attendees;
      if (A && A.count) {
        const small = A.dist.slice(0, 3).reduce((sum, x) => sum + x.share, 0);
        notes.push(`${fmtPct(small, 0)} der Besprechungen haben höchstens 4 Teilnehmer (im Schnitt ${fmtNum(A.avg, 1)} Personen).`);
        for (const r of R.resources) {
          if (!r.capacity || r.att_count < 3 || r.seat_util == null) continue;
          if (r.seat_util < 0.4) notes.push(`„${r.name}“ (${r.capacity} Plätze) wird im Schnitt mit ${fmtNum(r.avg_attendees, 1)} Personen genutzt (${fmtPct(r.seat_util, 0)} der Plätze) – meist zu groß.`);
          else if (r.seat_util > 0.85) notes.push(`„${r.name}“ (${r.capacity} Plätze) ist meist voll besetzt (Ø ${fmtNum(r.avg_attendees, 1)} Personen) – eher zu klein.`);
        }
      } else if (R.kind === 'room') notes.push('Teilnehmerzahlen gibt es erst für Buchungen ab Version 1.2.0 (dort Pflichtangabe).');
      const ci = R.checkin;
      if (R.basis === 'booked' && ci.since && ci.noshow) notes.push(`${ci.noshow} ${ci.noshow === 1 ? 'Buchung' : 'Buchungen'} ohne Check-in (${fmtNum(ci.noshow_hours)} Std.) – gebucht, aber vermutlich nicht genutzt. Mit „Grundlage: Tatsächlich genutzt“ sehen Sie die echte Nutzung.`);
    }
    const D = R.demand;
    if (D && D.count) notes.push(`⚠ ${D.count}× wurde gemeldet, dass kein passender ${R.kind === 'desk' ? 'Arbeitsplatz' : 'Besprechungsraum'} frei war (an ${D.days} ${D.days === 1 ? 'Tag' : 'Tagen'}) – siehe „Nicht erfüllter Bedarf“.`);
    if (R.to > today()) notes.push('Hinweis: Der Zeitraum enthält zukünftige Tage – dort zählen nur bereits vorhandene Buchungen.');
    return h('div', { class: 'card' }, h('h2', null, 'Einschätzung', h('small', null, 'automatisch aus den Daten')), h('ul', { class: 'assess' }, notes.map(x => h('li', null, x))));
  }

  // Meldungen „nichts Passendes gefunden“ – anonym
  function demandCard(R, unit) {
    const D = R.demand;
    const card = h('div', { class: 'card full' }, h('h2', null, 'Nicht erfüllter Bedarf',
      h('small', null, `Meldungen „nichts Passendes gefunden“ · ${unit} · anonym`)));
    if (!D || !D.count) {
      card.append(h('p', { class: 'muted', style: { margin: 0 } }, 'Im Zeitraum wurde kein fehlender ' + (R.kind === 'desk' ? 'Arbeitsplatz' : 'Besprechungsraum') + ' gemeldet.'));
      return card;
    }
    const kpi = (label, val, sub) => h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, label), h('div', { class: 'k-val' }, val), h('div', { class: 'k-sub' }, sub));
    const A = D.attendees, maxAtt = A.length ? Math.max(...A) : 0;
    const big = R.kind === 'room' && A.length ? A.filter(x => x > Math.max(0, ...R.resources.map(r => r.capacity || 0))).length : 0;
    const kpis = h('div', { class: 'kpis', style: { marginBottom: '12px' } },
      kpi('Meldungen', fmtNum(D.count, 0), `an ${D.days} ${D.days === 1 ? 'Tag' : 'Tagen'}`),
      kpi('Am häufigsten gefragt', D.features[0] ? D.features[0].name : '–', D.features[0] ? `${D.features[0].count}× als Ausstattung gewünscht` : 'keine Ausstattung angegeben'),
      R.kind === 'room' && A.length && kpi('Gewünschte Gruppengröße', `Ø ${fmtNum(A.reduce((a, b) => a + b, 0) / A.length, 1)}`, `bis ${maxAtt} Personen${big ? ` – ${big}× größer als der größte Raum` : ''}`));
    const first = +R.day_start.slice(0, 2), last = +R.day_end.slice(0, 2) - (R.day_end.endsWith(':00') ? 1 : 0);
    const hours = [];
    for (let hh = first; hh <= last; hh++) hours.push({ hour: hh, n: D.by_hour[hh] });
    const hourHost = h('div');
    const wdNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    const wdHost = h('div');
    const tbl = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['Benötigt am', 'Zeit', 'Gebäude', R.kind === 'room' ? 'Personen' : null, 'Ausstattung', 'Bemerkung', 'Gemeldet', ''].filter(x => x !== null).map(x => h('th', null, x)))),
      h('tbody', null, D.items.map(x => h('tr', null,
        h('td', null, fmtDate(x.day)), h('td', null, `${x.start}–${x.end}`), h('td', null, x.building_name || h('span', { class: 'muted' }, 'egal')),
        R.kind === 'room' && h('td', null, x.attendees ?? '–'),
        h('td', null, x.features.map(n => h('span', { class: 'badge feat' }, n))),
        h('td', { style: { maxWidth: '360px', whiteSpace: 'normal' } }, x.note),
        h('td', { class: 'muted small' }, fmtDate(x.created.slice(0, 10))),
        h('td', null, h('button', {
          class: 'small danger', title: 'Meldung löschen (z. B. doppelt oder versehentlich)', onclick: async () => {
            if (!await confirmDialog('Meldung löschen', 'Diese Meldung aus der Auswertung entfernen?')) return;
            try { await api('DELETE', '/api/demand/' + x.id); load(); } catch (e) { fail(e); }
          },
        }, '×')))))));
    appendKids(card, [kpis,
      h('div', { class: 'chart-grid', style: { marginTop: 0 } },
        h('div', null, h('h3', null, 'Wann fehlte etwas?', h('small', { class: 'muted' }, ' Anteil der Meldungen je Uhrzeit')), hourHost),
        h('div', null, h('h3', null, 'An welchen Wochentagen?', h('small', { class: 'muted' }, ' Anteil der Meldungen')), wdHost)),
      D.features.length > 1 && h('p', { class: 'small' }, h('b', null, 'Gewünschte Ausstattung: '), D.features.map(f => `${f.name} (${f.count}×)`).join(', ')),
      tbl]);
    setTimeout(() => {
      barChart(hourHost, hours, { value: r => r.n / D.count, label: r => pad(r.hour), height: 180,
        tip: r => [`${pad(r.hour)}:00–${pad(r.hour + 1)}:00 Uhr`, `${r.n} ${r.n === 1 ? 'Meldung' : 'Meldungen'}`] });
      barChart(wdHost, wdNames.slice(0, R.weekends ? 7 : 5).map((l, i) => ({ l, n: D.by_weekday[i] })), { value: r => r.n / D.count, label: r => r.l, height: 180,
        tip: r => [r.l, `${r.n} ${r.n === 1 ? 'Meldung' : 'Meldungen'}`] });
    });
    return card;
  }

  function checkinCard(R, unit) {
    const ci = R.checkin;
    if (!ci.since) return h('div', { class: 'card note-card' }, h('b', null, 'Check-in: '), 'Es liegen noch keine Check-in-Daten vor. Sobald Mitarbeitende „Ich bin da“ nutzen, erscheinen hier Check-in-Quote, nicht wahrgenommene Buchungen und vorzeitig freigegebene Zeit.');
    const kpi = (label, val, sub) => h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, label), h('div', { class: 'k-val' }, val), h('div', { class: 'k-sub' }, sub));
    return h('div', { class: 'kpis' },
      kpi('Check-in-Quote', ci.past ? fmtPct(ci.rate, 0) : '–', `${ci.checked_in} von ${ci.past} vergangenen Buchungen (seit ${fmtDate(ci.since)})`),
      kpi('Nicht erschienen', fmtNum(ci.noshow, 0), `Buchungen ohne Check-in · ${fmtNum(ci.noshow_hours)} Std. blockiert`),
      kpi('Vorzeitig freigegeben', `${fmtNum(ci.released_hours)} Std.`, `durch „Ich bin nicht mehr da“/„Freigeben“ (${ci.released}×)`));
  }

  function resTable(R) {
    let sortK = 'util', dir = -1;
    const wrap = h('div');
    const loc = r => [r.building_name, r.floor_name, R.kind === 'desk' ? r.room_name : null].filter(Boolean).join(' · ');
    const cols = [
      ['name', R.kind === 'desk' ? 'Platz' : 'Raum'], ['loc', 'Ort'], ['features', 'Ausstattung'],
      ['bookings', 'Buchungen', 'num'], ['hours', 'Belegte Std.', 'num'], ['avg_hours_per_day', 'Ø Std./Tag', 'num'],
      ['days_used', 'Tage gebucht', 'num'], ['util', 'Auslastung'],
      ...(R.kind === 'room' ? [['avg_attendees', 'Ø Pers.', 'num'], ['seat_util', 'Sitzplätze genutzt', 'num']] : []),
      ['peak_hour', 'Hauptzeit', 'num'],
    ];
    const key = (r, k) => k === 'loc' ? loc(r) : k === 'features' ? featNames(r.features).join(', ') : ['peak_hour', 'avg_attendees', 'seat_util'].includes(k) ? (r[k] ?? -1) : r[k];
    function draw() {
      const rows = [...R.resources].sort((a, b) => {
        const va = key(a, sortK), vb = key(b, sortK);
        return (typeof va === 'string' ? va.localeCompare(vb, 'de', { numeric: true }) : va - vb) * dir;
      });
      fill(wrap, h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'spacer' }),
        h('button', { class: 'small', onclick: () => csv(rows) }, 'CSV-Export')),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, cols.map(([k, l, cls]) => h('th', {
          class: 'sortable ' + (cls || ''), 'aria-sort': sortK === k ? (dir > 0 ? 'ascending' : 'descending') : null,
          onclick: () => { if (sortK === k) dir = -dir; else { sortK = k; dir = ['name', 'loc', 'features'].includes(k) ? 1 : -1; } draw(); },
        }, l, sortK === k ? (dir > 0 ? ' ▲' : ' ▼') : '')))),
        h('tbody', null, rows.map(r => {
          const bar = h('i'); bar.style.width = `${Math.min(100, r.util * 100)}%`;
          return h('tr', { class: 'click', title: 'Einzelauswertung anzeigen', onclick: () => { F.resource = String(r.id); load(); } },
            h('td', null, h('b', null, r.name), R.kind === 'room' && r.capacity ? h('span', { class: 'muted small' }, ` (${r.capacity} Pl.)`) : null,
              !r.active && h('span', { class: 'badge off', style: { marginLeft: '6px' } }, 'gesperrt')),
            h('td', { class: 'muted' }, loc(r)),
            h('td', null, featBadges(r.features)),
            h('td', { class: 'num' }, fmtNum(r.bookings, 0)),
            h('td', { class: 'num' }, fmtNum(r.hours)),
            h('td', { class: 'num' }, fmtNum(r.avg_hours_per_day, 2)),
            h('td', { class: 'num' }, fmtNum(r.days_used, 0)),
            h('td', null, h('div', { class: 'util-cell' }, h('span', { class: 'util-bar' }, bar), h('span', { class: 'num-w' }, fmtPct(r.util, 1)))),
            R.kind === 'room' && h('td', { class: 'num' }, r.avg_attendees == null ? '–' : fmtNum(r.avg_attendees, 1)),
            R.kind === 'room' && h('td', { class: 'num' }, r.seat_util == null ? '–' : fmtPct(r.seat_util, 0)),
            h('td', { class: 'num' }, r.peak_hour == null ? '–' : `${pad(r.peak_hour)}–${pad(r.peak_hour + 1)} Uhr`));
        })))));
    }
    function csv(rows) {
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const out = [['Name', 'Gebäude', 'Etage', 'Raum', 'Ausstattung', 'Buchungen', 'Belegte Stunden', 'Ø Std. pro Tag', 'Tage gebucht', 'Auslastung %', 'Hauptzeit']]
        .concat(rows.map(r => [r.name, r.building_name, r.floor_name, r.room_name, featNames(r.features).join(', '), r.bookings,
          String(r.hours).replace('.', ','), String(r.avg_hours_per_day).replace('.', ','), r.days_used,
          String(Math.round(r.util * 1000) / 10).replace('.', ','), r.peak_hour == null ? '' : `${pad(r.peak_hour)}:00`]));
      download(`auslastung_${R.kind === 'desk' ? 'plaetze' : 'raeume'}_${R.from}_${R.to}.csv`, '﻿' + out.map(r => r.map(esc).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
    }
    draw();
    return wrap;
  }

  function matrixTable(R) {
    const cols = R.series;
    const capOf = c => R.open_hours * c.days;
    const exportBtn = h('button', {
      class: 'small', onclick: () => {
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const out = [['Name', 'Raum', ...cols.map(c => c.label), 'Summe']].concat(R.resources.map(r => [r.name, r.room_name,
          ...cols.map(c => String(r.buckets[c.key] || 0).replace('.', ',')), String(r.hours).replace('.', ',')]));
        download(`stunden_je_${R.gran}_${R.from}_${R.to}.csv`, '﻿' + out.map(x => x.map(esc).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
      },
    }, 'CSV-Export');
    const head = h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'muted small' }, 'Werte in Stunden'), h('span', { class: 'spacer' }), exportBtn);
    if (cols.length > 62) {
      return h('div', null, head, h('p', { class: 'muted' }, `Zu viele Spalten (${cols.length}) für die Tabelle – bitte bei „Verlauf je“ eine gröbere Einteilung wählen oder die CSV-Datei exportieren.`));
    }
    const table = h('table', { class: 'matrix' },
      h('thead', null, h('tr', null, h('th', { class: 'sticky' }, R.kind === 'desk' ? 'Platz' : 'Raum'), cols.map(c => h('th', { title: `${c.days} Tage` }, c.label)), h('th', null, 'Summe'))),
      h('tbody', null, R.resources.map(r => h('tr', null,
        h('th', { class: 'sticky', title: `${r.building_name} · ${r.floor_name} · ${r.room_name}` }, r.name, R.kind === 'desk' && h('span', { class: 'muted' }, ` · ${r.room_name}`)),
        cols.map(c => {
          const v = r.buckets[c.key] || 0, t = capOf(c) ? v / capOf(c) : 0;
          const td = h('td', null, v ? fmtNum(v) : '');
          td.style.background = rampColor(t); td.style.color = inkOn(t);
          td.addEventListener('pointermove', ev => showTip(ev, [`${r.name} – ${c.label}`, `Belegt: ${fmtNum(v)} Std.`, `Auslastung: ${fmtPct(t, 1)}`]));
          td.addEventListener('pointerleave', hideTip);
          return td;
        }),
        h('td', { class: 'sum' }, fmtNum(r.hours))))));
    return h('div', null, head, h('div', { class: 'matrix-wrap' }, table));
  }

  await renderFilters();
  await load();
}

boot();
