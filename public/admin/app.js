/* Brigada Onse — administration console (vanilla JS, no framework). */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  user: null,
  csrf: null,
  route: normalizeRoute(location.hash.slice(1)),
  list: { q: '', status: '', group: '', page: 1, sort: 'name', order: 'asc', pages: 1, total: 0 },
  audit: { page: 1, pages: 1, total: 0 },
  groups: [],
  groupOptions: [],
  positionOptions: [],
  editing: null,
  setupMode: false,
};

/** Stored multi-values are "|"-joined; display them separated by · */
function splitMulti(value) {
  return String(value ?? '').split('|').map((part) => part.trim()).filter(Boolean);
}
function fmtMulti(value) {
  return splitMulti(value).join(' · ');
}

function checkboxField(label, name, options, selected) {
  const items = (options || []).map((option) => `
    <label class="check">
      <input type="checkbox" name="${name}" value="${esc(option)}" ${selected.includes(option) ? 'checked' : ''} />
      <span>${esc(option)}</span>
    </label>`).join('');
  return `
    <fieldset class="field checks">
      <legend>${esc(label)}</legend>
      <div class="check-list">${items}</div>
    </fieldset>`;
}

let detailCache = null;

/** Today's calendar date in Asia/Manila (matches the server rule). */
function manilaToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/* ------------------------------------------------------------------ utils */

function normalizeRoute(r) {
  const clean = (r || '/dashboard').split('?')[0];
  return clean.startsWith('/') ? clean : `/${clean}`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function statusPill(status, verificationStatus) {
  const value = verificationStatus || status;
  return `<span class="pill ${esc(value)}">${esc(value)}</span>`;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }

  if (res.status === 401) {
    state.user = null;
    state.csrf = null;
    render();
    throw new Error('Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    throw err;
  }
  return data;
}

function showErrors(err, form) {
  if (!form) { toast(err.message); return; }
  form.querySelectorAll('.err').forEach((n) => n.remove());
  form.querySelectorAll('.field-error').forEach((n) => n.classList.remove('field-error'));
  const details = err.details;
  if (details && typeof details === 'object') {
    let first = null;
    for (const [field, message] of Object.entries(details)) {
      const input = form.querySelector(`[name="${field}"]`);
      if (input) {
        input.closest('.field')?.classList.add('field-error');
        const span = document.createElement('div');
        span.className = 'err';
        span.textContent = message;
        input.insertAdjacentElement('afterend', span);
        if (!first) first = input;
      }
    }
    if (first) { first.focus(); return; }
  }
  toast(err.message);
}

/* ------------------------------------------------------------------ router */

window.addEventListener('hashchange', () => {
  state.route = normalizeRoute(location.hash.slice(1));
  render();
});

function go(path) {
  location.hash = path;
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    state.csrf = me.csrf_token;
  } catch {
    /* signed out */
  }
  render();
}

/* ------------------------------------------------------------------ render */

async function render() {
  if (!state.user) {
    app.innerHTML = loginView();
    bindLogin();
    return;
  }

  const [section, id, action] = state.route.split('/').filter(Boolean);
  let body = '';
  let title = 'Dashboard';
  let sub = 'Brigada Onse personnel verification';

  try {
    if (!section || section === 'dashboard') {
      body = await dashboardView();
      title = 'Dashboard';
      sub = 'Registry summary and expiration monitoring';
    } else if (section === 'personnel' && id === 'new') {
      body = await formView(null);
      title = 'Register Personnel';
      sub = 'Create a record, then generate its permanent QR code';
    } else if (section === 'personnel' && id && action === 'edit') {
      body = await formView(Number(id));
      title = 'Edit Personnel';
      sub = 'Update registration details — the QR link never changes';
    } else if (section === 'personnel' && id) {
      body = await detailView(Number(id));
      title = 'Personnel Record';
      sub = 'Details, QR code and lifecycle actions';
    } else if (section === 'personnel') {
      body = await listView();
      title = 'Personnel Directory';
      sub = 'Search, filter and manage registrations';
    } else if (section === 'audit') {
      body = await auditView();
      title = 'Audit History';
      sub = 'Authorized administrative actions';
    } else if (section === 'expiring') {
      body = await expiringView();
      title = 'Expiration Monitor';
      sub = 'Expired and soon-to-expire identifications';
    } else {
      body = `<div class="card"><div class="empty">Page not found. <a href="#/dashboard">Back to dashboard</a></div></div>`;
    }
  } catch (err) {
    body = `<div class="card"><div class="alert error">${esc(err.message)}</div></div>`;
  }

  app.innerHTML = shell(title, sub, body);
  bindCommon();

  if (!section || section === 'dashboard') bindDashboard();
  else if (section === 'personnel') bindPersonnel(id, action);
  else if (section === 'audit') bindAudit();
}

/* -------------------------------------------------------------------- views */

function shell(title, sub, body) {
  const link = (href, label) =>
    `<a class="navlink ${state.route.startsWith(href) ? 'active' : ''}" href="#${href}">${label}</a>`;
  return `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="crest">BO</div>
        <div><strong>Brigada Onse</strong><span>QR Verification</span></div>
      </div>
      ${link('/dashboard', 'Dashboard')}
      ${link('/personnel', 'Personnel')}
      ${link('/expiring', 'Expiration Monitor')}
      ${link('/audit', 'Audit History')}
      <div class="spacer"></div>
      <div class="whoami">Signed in as <strong>${esc(state.user.display_name || state.user.username)}</strong></div>
      <a class="navlink" href="#" id="logout">Sign out</a>
    </aside>
    <main class="main">
      <div class="topbar">
        <div><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
        <a class="btn" href="#/personnel/new">+ Register personnel</a>
      </div>
      ${body}
    </main>
  </div>`;
}

function bindCommon() {
  document.getElementById('logout')?.addEventListener('click', async (e) => {
    e.preventDefault();
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    state.user = null;
    state.csrf = null;
    go('/dashboard');
    render();
  });
}

/* ------------------------------------------------------------------- login */

function loginView() {
  return `
  <div class="login-wrap">
    <div class="login-card">
      <div class="brand" style="padding:0 0 16px">
        <div class="crest">BO</div>
        <div><strong>Brigada Onse</strong><span>Personnel Administration</span></div>
      </div>
      <h1>${state.setupMode ? 'Create administrator account' : 'Administrator sign in'}</h1>
      <p class="sub">${state.setupMode
        ? 'One-time setup. This page closes permanently once an account exists.'
        : 'Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Inc.'}</p>
      <div id="login-error"></div>
      <form id="login-form" autocomplete="on">
        <label class="field"><span>Username</span>
          <input type="text" name="username" autocomplete="username" required /></label>
        <label class="field"><span>Password</span>
          <input type="password" name="password" autocomplete="${state.setupMode ? 'new-password' : 'current-password'}"
            ${state.setupMode ? 'minlength="12" required' : 'required'} />${state.setupMode
              ? '<div class="muted" style="font-size:11.5px;margin-top:4px">At least 12 characters. You will use this to sign in.</div>'
              : ''}</label>
        ${state.setupMode ? `
        <label class="field"><span>Display name (optional)</span>
          <input type="text" name="display_name" /></label>` : ''}
        <button class="btn" style="width:100%;justify-content:center" type="submit">
          ${state.setupMode ? 'Create account' : 'Sign in'}</button>
      </form>
      <p class="sub" style="margin-top:14px">
        ${state.setupMode
          ? '<a href="#" id="toggle-setup">Back to sign in</a>'
          : '<a href="#" id="toggle-setup">First time? Set up the administrator account</a>'}
      </p>
    </div>
  </div>`;
}

function bindLogin() {
  const form = document.getElementById('login-form');
  document.getElementById('toggle-setup')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.setupMode = !state.setupMode;
    render();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      username: fd.get('username'),
      password: fd.get('password'),
      ...(state.setupMode ? { display_name: fd.get('display_name') } : {}),
    };
    const errBox = document.getElementById('login-error');
    errBox.innerHTML = '';

    try {
      if (state.setupMode) {
        await api('/api/setup', { method: 'POST', body: payload });
        state.setupMode = false;
        const me = await api('/api/auth/login', { method: 'POST', body: payload });
        state.user = me.user;
        state.csrf = me.csrf_token;
      } else {
        const me = await api('/api/auth/login', { method: 'POST', body: payload });
        state.user = me.user;
        state.csrf = me.csrf_token;
      }
      go('/dashboard');
      render();
    } catch (err) {
      showFormErrors(err, form, errBox);
    }
  });
}

/** Renders server-side validation into the sign-in / setup form, field by field. */
function showFormErrors(err, form, errBox) {
  form.querySelectorAll('.err').forEach((n) => n.remove());
  form.querySelectorAll('.field-error').forEach((n) => n.classList.remove('field-error'));

  const details = err.details;
  if (details && typeof details === 'object' && Object.keys(details).length) {
    let shown = 0;
    for (const [field, message] of Object.entries(details)) {
      const input = form.querySelector(`[name="${field}"]`);
      if (!input) continue;
      input.closest('.field')?.classList.add('field-error');
      const note = document.createElement('div');
      note.className = 'err';
      note.textContent = message;
      input.insertAdjacentElement('afterend', note);
      shown += 1;
    }
    if (shown) {
      errBox.innerHTML = '';
      form.querySelector('.field-error input')?.focus();
      return;
    }
  }
  errBox.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
}

/* ---------------------------------------------------------------- dashboard */

async function dashboardView() {
  const data = await api('/api/dashboard');
  const c = data.counts;
  const rows = (data.expiring || []).map((r) => `
    <tr class="clickable" data-id="${r.id}">        <td>${esc(r.full_name)}<div class="muted">${esc(r.personnel_id)}</div></td>
      <td>${esc(fmtMulti(r.group_name))}</td>
      <td>${esc(r.valid_until || '—')}</td>
      <td>${statusPill(r.status, r.verification_status)}</td>
    </tr>`).join('');

  const activity = (data.recent_activity || []).map((a) => `
    <tr>
      <td>${esc(a.created_at.slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(a.actor_name)}</td>
      <td>${esc(a.action)}</td>
      <td class="muted">${esc(a.entity_label || a.entity_type)}</td>
    </tr>`).join('');

  return `
    <div class="grid cols-4">
      <div class="stat"><div class="label">Total personnel</div><div class="value">${c.total}</div></div>
      <div class="stat good"><div class="label">Active</div><div class="value">${c.active}</div></div>
      <div class="stat warn"><div class="label">Expiring in 30 days</div><div class="value">${c.expiring_soon}</div></div>
      <div class="stat alert"><div class="label">Expired</div><div class="value">${c.expired}</div></div>
    </div>
    <div class="grid cols-4" style="margin-top:14px">
      <div class="stat"><div class="label">Suspended</div><div class="value">${c.suspended}</div></div>
      <div class="stat"><div class="label">Revoked</div><div class="value">${c.revoked}</div></div>
      <div class="stat" style="grid-column: span 2; display:flex; align-items:center; justify-content:space-between">
        <div><div class="label">Today (Asia/Manila)</div><div class="value" style="font-size:18px">${esc(data.today)}</div></div>
        <a class="btn secondary" href="#/expiring">Open monitor</a>
      </div>
    </div>

    <div class="card" style="margin-top:18px">
      <h2>Expired or expiring soon (next 30 days)</h2>
      ${rows ? `<table><thead><tr><th>Personnel</th><th>Group</th><th>Valid until</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table>`
        : '<div class="empty">No records expire within the next 30 days.</div>'}
    </div>

    <div class="card">
      <h2>Recent activity</h2>
      ${activity ? `<table><thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>${activity}</tbody></table>`
        : '<div class="empty">No administrative activity recorded yet.</div>'}
    </div>`;
}

function bindDashboard() {
  document.querySelectorAll('tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => go(`/personnel/${tr.dataset.id}`)));
}

/* -------------------------------------------------------------------- list */

async function listView() {
  const params = new URLSearchParams({
    q: state.list.q, status: state.list.status, group: state.list.group,
    page: String(state.list.page), sort: state.list.sort, order: state.list.order, page_size: '20',
  });
  const [data, options] = await Promise.all([
    api(`/api/personnel?${params}`),
    state.groupOptions.length ? Promise.resolve({ groups: state.groupOptions }) : api('/api/groups'),
  ]);
  state.groupOptions = options.groups || [];
  state.groups = state.groupOptions;
  state.list.pages = data.pagination.total_pages;
  state.list.total = data.pagination.total;

  const rows = data.items.map((r) => `
    <tr class="clickable" data-id="${r.id}">
      <td>${esc(r.full_name)}<div class="muted">${esc(r.personnel_id)}</div></td>
      <td>${esc(fmtMulti(r.group_name))}</td>
      <td>${esc(fmtMulti(r.position))}</td>
      <td>${esc(r.valid_until || '—')}</td>
      <td>${statusPill(r.status, r.verification_status)}</td>
      <td><span class="btn secondary sm" data-open="${r.id}">Open</span></td>
    </tr>`).join('');

  return `
    <div class="card">
      <div class="filters">
        <div class="grow">
          <label class="field"><span>Search</span>
            <input type="search" id="f-q" placeholder="Name, personnel ID, group or position" value="${esc(state.list.q)}" /></label>
        </div>
        <div>
          <label class="field"><span>Status</span>
            <select id="f-status">
              <option value="">All</option>
              ${['active', 'suspended', 'revoked'].map((s) =>
                `<option value="${s}" ${state.list.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
            </select></label>
        </div>
        <div>
          <label class="field"><span>Group</span>
            <select id="f-group">
              <option value="">All</option>
              ${state.groups.map((g) =>
                `<option value="${esc(g)}" ${state.list.group === g ? 'selected' : ''}>${esc(g)}</option>`).join('')}
            </select></label>
        </div>
        <div>
          <label class="field"><span>Sort by</span>
            <select id="f-sort">
              ${[['name', 'Name'], ['valid_until', 'Valid until'], ['group', 'Group'],
                 ['created_at', 'Date registered'], ['personnel_id', 'Personnel ID']]
                .map(([v, l]) => `<option value="${v}" ${state.list.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
        </div>
        <div>
          <button class="btn secondary" id="f-reset" type="button">Reset</button>
        </div>
      </div>

      ${rows ? `<table>
        <thead><tr><th>Personnel</th><th>Group</th><th>Position</th><th>Valid until</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`
        : '<div class="empty">No personnel records match this search.</div>'}

      <div class="pager">
        <span class="muted">${state.list.total} record(s)</span>
        <button class="btn secondary sm" id="prev" ${state.list.page <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${state.list.page} of ${state.list.pages}</span>
        <button class="btn secondary sm" id="next" ${state.list.page >= state.list.pages ? 'disabled' : ''}>Next</button>
      </div>
    </div>`;
}

function bindPersonnel(id, action) {
  if (id === 'new') { bindForm(null); return; }
  if (id && action === 'edit') { bindForm(Number(id)); return; }
  if (!id) {
    // directory
    let timer;
    document.getElementById('f-q')?.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.list.q = e.target.value.trim(); state.list.page = 1; render(); }, 320);
    });
    document.getElementById('f-status')?.addEventListener('change', (e) => {
      state.list.status = e.target.value; state.list.page = 1; render();
    });
    document.getElementById('f-group')?.addEventListener('change', (e) => {
      state.list.group = e.target.value; state.list.page = 1; render();
    });
    document.getElementById('f-sort')?.addEventListener('change', (e) => {
      state.list.sort = e.target.value; state.list.page = 1; render();
    });
    document.getElementById('f-reset')?.addEventListener('click', () => {
      state.list = { ...state.list, q: '', status: '', group: '', page: 1, sort: 'name' };
      render();
    });
    document.getElementById('prev')?.addEventListener('click', () => { state.list.page--; render(); });
    document.getElementById('next')?.addEventListener('click', () => { state.list.page++; render(); });
    document.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', () => go(`/personnel/${tr.dataset.id}`)));
    return;
  }
  bindDetail(Number(id));
}

/* -------------------------------------------------------------- create/edit */

async function formView(id) {
  let record = {
    personnel_id: '', full_name: '', address: '', group_name: '', position: '',
    valid_until: '', remarks: '', profile_photo: null, status: 'active',
  };
  if (id) {
    const data = await api(`/api/personnel/${id}`);
    record = data.record;
  }
  const options = await api('/api/groups');
  state.groups = options.groups || [];
  state.groupOptions = options.groups || [];
  state.positionOptions = options.positions || [];
  state.editing = { ...record };

  return `
    <div class="card">
      <h2>${id ? `Edit ${esc(record.personnel_id)}` : 'New personnel record'}</h2>
      <form id="person-form" novalidate>
        <div class="grid cols-2">
          <div>
            <label class="field"><span>Full name *</span>
              <input type="text" name="full_name" value="${esc(record.full_name)}" required /></label>
            <label class="field"><span>Address *</span>
              <textarea name="address" required>${esc(record.address)}</textarea></label>
            ${checkboxField('Group *', 'group_name', state.groupOptions, splitMulti(record.group_name))}
            ${checkboxField('Position *', 'position', state.positionOptions, splitMulti(record.position))}
          </div>
          <div>
            <label class="field"><span>Valid until * (Asia/Manila)</span>
              <input type="date" name="valid_until" value="${esc(record.valid_until || '')}" required /></label>
            <label class="field"><span>Personnel ID (leave blank to auto-generate)</span>
              <input type="text" name="personnel_id" value="${esc(record.personnel_id)}" placeholder="BO-2026-XXXXXX" /></label>
            <label class="field"><span>Status</span>
              <select name="status">
                ${['active', 'suspended', 'revoked'].map((s) =>
                  `<option value="${s}" ${record.status === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
              </select></label>
            <label class="field"><span>Remarks</span>
              <textarea name="remarks">${esc(record.remarks || '')}</textarea></label>
            <label class="field"><span>Profile photo (PNG/JPG/WebP/GIF, max 256 KB)</span>
              <input type="file" name="photo" accept="image/png,image/jpeg,image/webp,image/gif" /></label>
            <div id="photo-preview">${record.profile_photo
              ? `<img class="thumb" src="${esc(record.profile_photo)}" alt="Current profile photo" />` : ''}</div>
          </div>
        </div>
        <div class="form-actions">
          <a class="btn secondary" href="${id ? `#/personnel/${id}` : '#/personnel'}">Cancel</a>
          <button class="btn" type="submit">${id ? 'Save changes' : 'Create record'}</button>
        </div>
      </form>
    </div>`;
}

function bindForm(id) {
  const form = document.getElementById('person-form');
  if (!form) return;
  const photoInput = form.querySelector('[name="photo"]');
  let pendingPhoto; // undefined = unchanged, null = cleared, string = new data URL

  photoInput?.addEventListener('change', () => {
    const file = photoInput.files?.[0];
    const preview = document.getElementById('photo-preview');
    if (!file) { pendingPhoto = null; preview.innerHTML = ''; return; }
    if (file.size > 256 * 1024) {
      photoInput.value = '';
      pendingPhoto = null;
      preview.innerHTML = '<div class="err">Photo must be 256 KB or smaller.</div>';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingPhoto = String(reader.result);
      preview.innerHTML = `<img class="thumb" src="${pendingPhoto}" alt="Selected profile photo" />`;
    };
    reader.readAsDataURL(file);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      full_name: fd.get('full_name'),
      address: fd.get('address'),
      // Multi-select: send every ticked box; the server stores them "|"-joined.
      group_name: fd.getAll('group_name'),
      position: fd.getAll('position'),
      valid_until: fd.get('valid_until'),
      personnel_id: fd.get('personnel_id'),
      status: fd.get('status'),
      remarks: fd.get('remarks'),
    };
    if (pendingPhoto !== undefined) payload.profile_photo = pendingPhoto;

    try {
      const result = id
        ? await api(`/api/personnel/${id}`, { method: 'PUT', body: payload })
        : await api('/api/personnel', { method: 'POST', body: payload });
      toast(id ? 'Record updated.' : `Record created — ${result.record.personnel_id}`);
      go(`/personnel/${result.record.id}`);
      render();
    } catch (err) {
      showErrors(err, form);
    }
  });
}

/* ------------------------------------------------------------------ detail */

async function detailView(id) {
  const data = await api(`/api/personnel/${id}`);
  const r = data.record;
  detailCache = r;
  const expiry = r.valid_until
    ? (r.verification_status === 'EXPIRED' ? statusPill(null, 'EXPIRED') : `<span class="muted">${esc(r.valid_until)}</span>`)
    : '<span class="pill INVALID">NO DATE</span>';

  return `
    <div class="card">
      <div class="detail-head">
        ${r.profile_photo
          ? `<img class="avatar" src="${esc(r.profile_photo)}" alt="Profile photo" style="object-fit:cover">`
          : `<div class="avatar">${esc(r.full_name.slice(0, 1).toUpperCase())}</div>`}
        <div style="flex:1">
          <h2 style="font-size:19px;margin:0 0 4px">${esc(r.full_name)}</h2>
          <div class="muted">${esc(fmtMulti(r.position))} · ${esc(fmtMulti(r.group_name))}</div>
          <div style="margin-top:8px">${statusPill(r.status, r.verification_status)} ${expiry}</div>
        </div>
        <div class="actions">
          <a class="btn secondary" href="#/personnel">← Directory</a>
          <a class="btn" href="#/personnel/${r.id}/edit" id="edit-link">Edit</a>
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:18px">
        <div>
          <dl class="kv">
            <dt>Personnel ID</dt><dd>${esc(r.personnel_id)}</dd>
            <dt>Group</dt><dd>${esc(fmtMulti(r.group_name))}</dd>
            <dt>Position</dt><dd>${esc(fmtMulti(r.position))}</dd>
            <dt>Address</dt><dd>${esc(r.address)}</dd>
            <dt>Valid until</dt><dd>${esc(r.valid_until || '—')}</dd>
            <dt>Status</dt><dd>${esc(r.status)}</dd>
            <dt>Date registered</dt><dd>${esc(r.date_registered.slice(0, 10))}</dd>
            <dt>Last updated</dt><dd>${esc(r.updated_at.slice(0, 16).replace('T', ' '))}</dd>
            <dt>Created by</dt><dd>${esc(r.created_by)}</dd>
            <dt>Remarks</dt><dd>${esc(r.remarks || '—')}</dd>
          </dl>
        </div>
        <div>
          <div class="qr-panel">
            <div class="qr-box">
              <img id="qr-img" src="/api/personnel/${r.id}/qr?format=svg" alt="Verification QR code" />
              <div class="muted" style="font-size:11px;margin-top:6px">Scan to verify</div>
            </div>
            <div style="flex:1;min-width:220px">
              <div class="qr-url" id="qr-url">${esc(r.verification_url || '')}</div>
              <div class="actions">
                <button class="btn sm" id="dl-png">Download PNG</button>
                <button class="btn secondary sm" id="dl-svg">Download SVG</button>
                <button class="btn secondary sm" id="copy-link">Copy link</button>
                <button class="btn secondary sm" id="print-card">Print ID card</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="actions" style="margin-top:18px;border-top:1px solid var(--line);padding-top:16px">
        <button class="btn secondary" id="act-renew">Renew validity</button>
        ${r.status === 'active'
          ? '<button class="btn secondary" id="act-suspend">Suspend</button>' : ''}
        ${r.status === 'suspended'
          ? '<button class="btn secondary" id="act-reactivate">Reactivate</button>' : ''}
        ${r.status !== 'revoked'
          ? '<button class="btn danger" id="act-revoke">Revoke identification</button>'
          : '<span class="muted">This identification is revoked and cannot be reactivated.</span>'}
      </div>
    </div>

    <div class="card">
      <h2>Audit history for this record</h2>
      <div id="record-audit"><div class="muted">Loading…</div></div>
    </div>`;
}

function bindDetail(id) {
  document.getElementById('edit-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    go(`/personnel/${id}/edit`);
  });

  document.getElementById('dl-png')?.addEventListener('click', () => {
    window.open(`/api/personnel/${id}/qr?format=png&download=1`, '_blank');
  });
  document.getElementById('dl-svg')?.addEventListener('click', () => {
    window.open(`/api/personnel/${id}/qr?format=svg&download=1`, '_blank');
  });
  document.getElementById('copy-link')?.addEventListener('click', async () => {
    const url = document.getElementById('qr-url').textContent.trim();
    try {
      await navigator.clipboard.writeText(url);
      toast('Verification link copied.');
    } catch {
      toast('Copy failed — select the link manually.');
    }
  });
  document.getElementById('print-card')?.addEventListener('click', () => printIdCard(id));

  document.getElementById('act-renew')?.addEventListener('click', () => renewDialog(id));
  document.getElementById('act-suspend')?.addEventListener('click', () =>
    confirmAction(id, 'suspend', 'Suspend this identification? Verification will report SUSPENDED immediately.'));
  document.getElementById('act-reactivate')?.addEventListener('click', () =>
    confirmAction(id, 'reactivate', 'Reactivate this identification?'));
  document.getElementById('act-revoke')?.addEventListener('click', () =>
    confirmAction(id, 'revoke', 'REVOKE this identification permanently? The QR code will report REVOKED and it cannot be reactivated.'));

  loadRecordAudit(id);
}

async function loadRecordAudit(id) {
  const box = document.getElementById('record-audit');
  if (!box) return;
  try {
    const data = await api(`/api/audit?entity_id=${id}&page_size=25`);
    box.innerHTML = data.items.length
      ? `<table><thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Details</th></tr></thead>
         <tbody>${data.items.map((a) => `<tr>
           <td>${esc(a.created_at.slice(0, 16).replace('T', ' '))}</td>
           <td>${esc(a.actor_name)}</td>
           <td>${esc(a.action)}</td>
           <td class="muted">${esc(JSON.stringify(a.metadata))}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">No recorded actions for this record.</div>';
  } catch (err) {
    box.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
  }
}

async function confirmAction(id, action, message) {
  if (!confirm(message)) return;
  try {
    await api(`/api/personnel/${id}/${action}`, { method: 'POST', body: {} });
    toast(`Record updated: ${action}.`);
    render();
  } catch (err) {
    toast(err.message);
  }
}

function renewDialog(id) {
  const input = document.querySelector('[name="valid_until"]');
  const current = input?.value || detailCache?.valid_until || '';
  const value = prompt('New valid until date (YYYY-MM-DD):', current || '');
  if (!value) return;
  api(`/api/personnel/${id}/renew`, { method: 'POST', body: { valid_until: value } })
    .then(() => { toast('Validity renewed.'); render(); })
    .catch((err) => toast(err.message));
}

/* -------------------------------------------------------------- ID card */

async function printIdCard(id) {
  const data = await api(`/api/personnel/${id}`);
  const r = data.record;
  let qrSvg = '';
  try {
    const res = await fetch(`/api/personnel/${r.id}/qr?format=svg`, { credentials: 'same-origin' });
    qrSvg = await res.text();
    qrSvg = qrSvg.replace(/^<\?xml[^>]*>\s*/, '');
  } catch { /* fall back to no QR */ }

  const photo = r.profile_photo
    ? `<img src="${r.profile_photo}" class="p">` : `<div class="p ph">${esc(r.full_name.slice(0, 1))}</div>`;

  const card = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(r.personnel_id)} — Identification Card</title>
<style>
  @page { size: 86mm 54mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#e2e8f0; }
  .card { width:86mm; height:54mm; background:#fff; color:#0f172a; display:flex; overflow:hidden;
          border:.4mm solid #cbd5e1; margin:6mm auto; }
  .left { width:60%; padding:3mm; display:flex; flex-direction:column; }
  .right { width:40%; background:#0f172a; color:#fff; display:flex; flex-direction:column;
           align-items:center; justify-content:center; padding:2mm; gap:1.5mm; }
  .hdr { display:flex; align-items:center; gap:2mm; border-bottom:.3mm solid #e2e8f0; padding-bottom:1.5mm; }
  .crest { width:8mm; height:8mm; border-radius:50%; background:#b91c1c; color:#fff; font-weight:800;
           font-size:3mm; display:flex; align-items:center; justify-content:center; }
  .org { font-size:2.4mm; font-weight:800; line-height:1.15; }
  .org span { display:block; font-weight:500; color:#64748b; font-size:2.1mm; }
  .row { display:flex; gap:2mm; margin-top:2mm; }
  .p { width:17mm; height:17mm; border-radius:1.5mm; object-fit:cover; border:.3mm solid #e2e8f0; }
  .ph { background:#e2e8f0; color:#94a3b8; font-size:7mm; font-weight:800; display:flex;
        align-items:center; justify-content:center; }
  .name { font-size:3.6mm; font-weight:800; line-height:1.1; }
  .role { font-size:2.5mm; color:#475569; margin-top:.6mm; }
  .kv { margin-top:auto; font-size:2.3mm; display:grid; grid-template-columns:14mm 1fr; gap:.6mm; }
  .kv b { color:#64748b; font-weight:600; }
  .right svg, .right img { width:20mm; height:20mm; background:#fff; padding:.8mm; border-radius:1mm; }
  .tid { font-size:2.5mm; font-weight:700; letter-spacing:.2mm; }
  .hint { font-size:2mm; text-align:center; color:#cbd5e1; }
</style></head><body>
<div class="card">
  <div class="left">
    <div class="hdr">
      <div class="crest">BO</div>
      <div class="org">BRIGADA ONSE<span>Sun Valley Fire &amp; Rescue<br>Volunteer Group, Inc.</span></div>
    </div>
    <div class="row">
      ${photo}
      <div>
        <div class="name">${esc(r.full_name)}</div>
        <div class="role">${esc(fmtMulti(r.position))}</div>
        <div class="role">${esc(fmtMulti(r.group_name))}</div>
      </div>
    </div>
    <div class="kv">
      <b>ID No.</b><span>${esc(r.personnel_id)}</span>
      <b>Valid until</b><span>${esc(r.valid_until || '—')}</span>
      <b>Status</b><span>${esc(r.status.toUpperCase())}</span>
    </div>
  </div>
  <div class="right">
    ${qrSvg}
    <div class="tid">${esc(r.personnel_id)}</div>
    <div class="hint">Scan to verify</div>
  </div>
</div>
</body></html>`;

  const win = window.open('', '_blank');
  if (!win) { toast('Allow pop-ups to print the ID card.'); return; }
  win.document.write(card);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

/* -------------------------------------------------------------- audit view */

async function auditView() {
  const data = await api(`/api/audit?page=${state.audit.page}&page_size=25`);
  state.audit.pages = data.pagination.total_pages;
  state.audit.total = data.pagination.total;
  return `
    <div class="card">
      ${data.items.length ? `<table>
        <thead><tr><th>When (UTC)</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>${data.items.map((a) => `<tr>
          <td>${esc(a.created_at.slice(0, 19).replace('T', ' '))}</td>
          <td>${esc(a.actor_name)}</td>
          <td>${esc(a.action)}</td>
          <td>${esc(a.entity_label || a.entity_type)}</td>
          <td class="muted">${esc(JSON.stringify(a.metadata))}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">No audit entries yet.</div>'}
      <div class="pager">
        <span class="muted">${state.audit.total} entries</span>
        <button class="btn secondary sm" id="a-prev" ${state.audit.page <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${state.audit.page} of ${state.audit.pages}</span>
        <button class="btn secondary sm" id="a-next" ${state.audit.page >= state.audit.pages ? 'disabled' : ''}>Next</button>
      </div>
    </div>`;
}

function bindAudit() {
  document.getElementById('a-prev')?.addEventListener('click', () => { state.audit.page--; render(); });
  document.getElementById('a-next')?.addEventListener('click', () => { state.audit.page++; render(); });
}

/* --------------------------------------------------------- expiration view */

async function expiringView() {
  const [windowRes, suspendedRes] = await Promise.all([
    api('/api/personnel?status=active&expiring_before=1&sort=valid_until&order=asc&page_size=100'),
    api('/api/personnel?status=suspended&page_size=100'),
  ]);

  // Manila calendar date, matching the server's expiration rule.
  const today = manilaToday();
  const isExpired = (r) => r.valid_until && r.valid_until < today;

  const rows = (list) => list.filter(isExpired).map((r) => `
    <tr class="clickable" data-id="${r.id}">
      <td>${esc(r.full_name)}<div class="muted">${esc(r.personnel_id)}</div></td>
      <td>${esc(fmtMulti(r.group_name))}</td>
      <td>${esc(r.valid_until)}</td>
      <td>${daysSince(r.valid_until)} day(s) ago</td>
      <td>${statusPill(r.status, r.verification_status)}</td>
    </tr>`).join('');

  const soon = windowRes.items.filter((r) => !isExpired(r) && r.valid_until).map((r) => `
    <tr class="clickable" data-id="${r.id}">
      <td>${esc(r.full_name)}<div class="muted">${esc(r.personnel_id)}</div></td>
      <td>${esc(fmtMulti(r.group_name))}</td>
      <td>${esc(r.valid_until)}</td>
      <td>${daysUntil(r.valid_until)} day(s) left</td>
      <td>${statusPill(r.status, r.verification_status)}</td>
    </tr>`).join('');

  const suspended = suspendedRes.items.map((r) => `
    <tr class="clickable" data-id="${r.id}">
      <td>${esc(r.full_name)}<div class="muted">${esc(r.personnel_id)}</div></td>
      <td>${esc(fmtMulti(r.group_name))}</td>
      <td>${esc(r.valid_until || '—')}</td>
      <td>—</td>
      <td>${statusPill('suspended')}</td>
    </tr>`).join('');

  const table = (body, empty) => body
    ? `<table><thead><tr><th>Personnel</th><th>Group</th><th>Valid until</th><th>Window</th><th>Status</th></tr></thead>
       <tbody>${body}</tbody></table>`
    : `<div class="empty">${empty}</div>`;

  return `
    <div class="card">
      <h2>Expired identifications</h2>
      ${table(rows(windowRes.items), 'No expired identifications.')}
    </div>
    <div class="card">
      <h2>Expiring within 30 days</h2>
      ${table(soon, 'Nothing expires in the next 30 days.')}
    </div>
    <div class="card">
      <h2>Suspended identifications</h2>
      ${table(suspended, 'No suspended identifications.')}
    </div>`;
}

function daysUntil(dateStr) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const target = new Date(`${dateStr}T00:00:00Z`);
  return Math.round((target - today) / 86400000);
}
function daysSince(dateStr) {
  return Math.abs(daysUntil(dateStr));
}

boot();
