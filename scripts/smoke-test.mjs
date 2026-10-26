#!/usr/bin/env node
/**
 * End-to-end smoke test against a running development server.
 *
 *   npm run db:migrate:local     # apply migrations first
 *   npx wrangler dev --port 8787 # in another shell
 *   node scripts/smoke-test.mjs
 *
 * Environment:
 *   BASE_URL             default http://127.0.0.1:8787
 *   SMOKE_ADMIN_USERNAME default admin
 *   SMOKE_ADMIN_PASSWORD default ChangeMe123!   (used when setup is already closed)
 *
 * Uses synthetic records only. Never runs against production.
 */

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN_USER = process.env.SMOKE_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASS = process.env.SMOKE_ADMIN_PASSWORD ?? 'ChangeMe123!';
const ORIGIN = BASE;

let cookie = '';
let csrf = '';
let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} ${detail}`);
    console.log(`  FAIL ${label} ${detail}`);
  }
}

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (pair.startsWith('bo_session=')) cookie = pair;
  }

  const contentType = res.headers.get('content-type') ?? '';
  let data = null;
  let text = '';
  if (contentType.includes('application/json')) {
    text = await res.text();
    try { data = JSON.parse(text); } catch { /* ignore */ }
  } else {
    text = await res.text();
  }
  return { status: res.status, headers: res.headers, data, text, bytes: text };
}

const today = new Date().toISOString().slice(0, 10);
const futureDate = '2030-12-31';
const pastDate = '2020-01-01';

// Canonical options (mirror src/options.ts)
const BRIGADA_GROUP = 'Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Incorporated';
const GRIFFIN_GROUP = 'Griffin Fire and Rescue Volunteer Group';

async function main() {
  console.log(`Smoke test against ${BASE}\n`);

  /* ---------------------------------------------------------- availability */
  console.log('Availability and auth guards');
  const health = await call('GET', '/api/health');
  check('GET /api/health returns ok', health.status === 200 && health.data?.ok === true);

  const unauth = await call('GET', '/api/personnel');
  check('GET /api/personnel requires authentication (401)', unauth.status === 401);

  const unauthVerify = await call('GET', '/api/auth/me');
  check('GET /api/auth/me is 401 when signed out', unauthVerify.status === 401);

  const admin = await call('GET', '/admin/');
  check('GET /admin/ serves the dashboard shell', admin.status === 200 && admin.text.includes('app.js'));

  const landing = await call('GET', '/');
  check('GET / serves the landing page', landing.status === 200 && landing.text.includes('Brigada Onse'));

  /* ---------------------------------------------------------------- setup */
  console.log('\nOne-time administrator setup');
  const setup = await call('POST', '/api/setup', {
    username: ADMIN_USER,
    password: ADMIN_PASS,
    display_name: 'Smoke Test Admin',
  }, { origin: ORIGIN });
  check('POST /api/setup creates the first admin (201) or reports closed (403)',
    setup.status === 201 || setup.status === 403, `got ${setup.status}`);

  const setupAgain = await call('POST', '/api/setup', {
    username: ADMIN_USER,
    password: ADMIN_PASS,
  }, { origin: ORIGIN });
  check('POST /api/setup is closed afterwards (403)', setupAgain.status === 403, `got ${setupAgain.status}`);

  /* ---------------------------------------------------------------- login */
  console.log('\nAuthentication and rate limiting');
  const badLogin = await call('POST', '/api/auth/login',
    { username: ADMIN_USER, password: 'definitely-wrong' }, { origin: ORIGIN });
  check('wrong password is rejected (401)', badLogin.status === 401);

  for (let i = 0; i < 5; i++) {
    await call('POST', '/api/auth/login', { username: 'nobody-here', password: 'x' }, { origin: ORIGIN });
  }
  const limited = await call('POST', '/api/auth/login',
    { username: 'nobody-here', password: 'x' }, { origin: ORIGIN });
  check('login attempts are rate limited (429)', limited.status === 429, `got ${limited.status}`);

  const originAttack = await call('POST', '/api/auth/login',
    { username: ADMIN_USER, password: ADMIN_PASS }, { origin: 'https://evil.example' });
  check('foreign Origin header is rejected (403)', originAttack.status === 403, `got ${originAttack.status}`);

  const login = await call('POST', '/api/auth/login',
    { username: ADMIN_USER, password: ADMIN_PASS }, { origin: ORIGIN });
  check('valid credentials sign in (200)', login.status === 200 && login.data?.ok === true,
    `got ${login.status}`);
  csrf = login.data?.csrf_token ?? '';
  check('login returns a CSRF token', csrf.length > 20);
  check('session cookie is HttpOnly and Secure',
    (login.headers.get('set-cookie') ?? '').includes('HttpOnly') &&
    (login.headers.get('set-cookie') ?? '').includes('Secure'));

  const me = await call('GET', '/api/auth/me');
  check('GET /api/auth/me returns the session user', me.status === 200 && me.data?.user?.username === ADMIN_USER);

  /* ---------------------------------------------------- create + validate */
  console.log('\nPersonnel registration');
  const noCsrf = await (async () => {
    const saved = csrf;
    csrf = '';
    const r = await call('POST', '/api/personnel', {
      full_name: 'No CSRF', address: 'x street', group_name: 'G', position: 'P', valid_until: futureDate,
    }, { origin: ORIGIN });
    csrf = saved;
    return r;
  })();
  check('mutation without CSRF header is rejected (403)', noCsrf.status === 403, `got ${noCsrf.status}`);

  const invalid = await call('POST', '/api/personnel', { full_name: 'X' }, { origin: ORIGIN });
  check('incomplete payload returns 422 with field errors',
    invalid.status === 422 && Boolean(invalid.data?.details?.full_name));

  const created = await call('POST', '/api/personnel', {
    full_name: 'Juan Dela Cruz',
    address: '123 Sunset Lane, Sun Valley, Parañaque',
    group_name: [BRIGADA_GROUP, GRIFFIN_GROUP],
    position: ['Volunteer', 'Officer'],
    valid_until: futureDate,
    remarks: 'Synthetic test record',
  }, { origin: ORIGIN });
  check('POST /api/personnel creates a record (201)', created.status === 201, `got ${created.status}`);
  const rec = created.data?.record;
  check('multiple groups are stored as a multi-value field',
    rec?.group_name === `${BRIGADA_GROUP}|${GRIFFIN_GROUP}`, rec?.group_name);
  check('multiple positions are stored as a multi-value field',
    rec?.position === 'Volunteer|Officer', rec?.position);
  check('record has a personnel ID', /^[A-Z]{2,}-\d{4}-[A-Z0-9]+$/.test(rec?.personnel_id ?? ''),
    rec?.personnel_id);
  check('record has a verification URL with a long random token',
    /^https?:\/\/.+\/verify\/[A-Za-z0-9_-]{43}$/.test(rec?.verification_url ?? ''), rec?.verification_url);
  check('response never contains database token material',
    !JSON.stringify(created.data).includes('verification_token'));

  const dupId = await call('POST', '/api/personnel', {
    full_name: 'Duplicate Person',
    address: '456 Other Street',
    group_name: ['Not Available'],
    position: ['Barangay Personnel'],
    valid_until: futureDate,
    personnel_id: rec.personnel_id,
  }, { origin: ORIGIN });
  check('duplicate Personnel ID returns 409', dupId.status === 409, `got ${dupId.status}`);

  const badGroup = await call('POST', '/api/personnel', {
    full_name: 'Bad Group Person',
    address: '1 Test Street',
    group_name: ['Made Up Group'],
    position: ['Volunteer'],
    valid_until: futureDate,
  }, { origin: ORIGIN });
  check('unknown group option is rejected (422)',
    badGroup.status === 422 && Boolean(badGroup.data?.details?.group_name), `got ${badGroup.status}`);

  const second = await call('POST', '/api/personnel', {
    full_name: 'Expired Test Person',
    address: '789 Lapsed Avenue',
    group_name: ['Don Bosco Fire and Rescue Volunteer Group'],
    position: ['Candidate'],
    valid_until: pastDate,
  }, { origin: ORIGIN });
  check('second record created (201)', second.status === 201);
  const expiredRec = second.data?.record;

  const tokens = (created.text + second.text).match(/[A-Za-z0-9_-]{43}/g) ?? [];
  check('verification tokens are unique per record', new Set(tokens).size === 2, JSON.stringify(tokens));

  /* ------------------------------------------------------------ directory */
  console.log('\nDirectory, search and pagination');
  const list = await call('GET', '/api/personnel?page=1&page_size=20');
  check('GET /api/personnel lists records (200)', list.status === 200 && list.data?.items?.length >= 2);
  check('pagination metadata present', list.data?.pagination?.total >= 2);

  const search = await call('GET', '/api/personnel?q=Juan');
  check('search by name finds the record', search.data?.items?.some((r) => r.full_name === 'Juan Dela Cruz'));

  const filter = await call('GET', '/api/personnel?status=active');
  check('status filter applies', filter.data?.items?.every((r) => r.status === 'active'));

  const badSort = await call('GET', '/api/personnel?sort=;DROP TABLE personnel;--');
  check('malicious sort parameter does not break the query', badSort.status === 200,
    `got ${badSort.status}`);

  /* ---------------------------------------------------- update + stability */
  console.log('\nEditing and QR URL stability');
  const before = await call('GET', `/api/personnel/${rec.id}`);
  const updated = await call('PUT', `/api/personnel/${rec.id}`, {
    full_name: 'Juan Dela Cruz-Reyes',
    address: '123 Sunset Lane, Sun Valley, Parañaque',
    group_name: [BRIGADA_GROUP, GRIFFIN_GROUP],
    position: ['Regular'],
    valid_until: futureDate,
  }, { origin: ORIGIN });
  check('PUT /api/personnel/:id updates the record (200)', updated.status === 200, `got ${updated.status}`);
  check('verification URL is unchanged after an edit',
    before.data?.record?.verification_url === updated.data?.record?.verification_url);
  check('updated field is persisted', updated.data?.record?.position === 'Regular');
  check('multi-value groups survive an edit',
    updated.data?.record?.group_name === `${BRIGADA_GROUP}|${GRIFFIN_GROUP}`);

  const groupFilter = await call('GET', `/api/personnel?group=${encodeURIComponent(GRIFFIN_GROUP)}`);
  check('filtering by one of several groups finds the record',
    groupFilter.status === 200 && groupFilter.data?.items?.some((r) => r.id === rec.id),
    `got ${groupFilter.status}`);

  /* ------------------------------------------------------------------- QR */
  console.log('\nQR generation');
  const svg = await call('GET', `/api/personnel/${rec.id}/qr?format=svg`);
  check('SVG QR served with image/svg+xml',
    svg.status === 200 && (svg.headers.get('content-type') ?? '').includes('image/svg+xml'));
  check('SVG QR is a standalone document', svg.text.includes('<svg xmlns='));

  const png = await fetch(`${BASE}/api/personnel/${rec.id}/qr?format=png`, { headers: { cookie } });
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  check('PNG QR served with image/png', png.status === 200 && (png.headers.get('content-type') ?? '').includes('image/png'));
  check('PNG QR has a valid signature',
    pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47);
  check('PNG QR is large enough to be scannable', pngBytes.length > 500, `${pngBytes.length} bytes`);

  const qrNoAuth = await fetch(`${BASE}/api/personnel/${rec.id}/qr?format=svg`);
  check('QR endpoint requires authentication (401)', qrNoAuth.status === 401);

  /* ------------------------------------------------------------ verification */
  console.log('\nPublic verification');
  const token = (rec.verification_url ?? '').split('/verify/')[1];
  const page = await call('GET', `/verify/${token}`);
  check('verification page renders (200)', page.status === 200);
  check('verification page shows the name', page.text.includes('Juan Dela Cruz-Reyes'));
  check('verification page shows VALID status', page.text.includes('ACTIVE / VALID'));
  check('verification page keeps the address private',
    !page.text.includes('Sun Valley, Parañaque'), 'address leaked');
  check('verification page has no script tags', !/<script/i.test(page.text));

  const apiVerify = await call('GET', `/api/verify/${token}`);
  check('public verify API reports VALID', apiVerify.data?.status === 'VALID');
  check('public verify API hides the address',
    !JSON.stringify(apiVerify.data).includes('Sun Valley, Parañaque'));
  check('public verify API shows approved fields',
    apiVerify.data?.personnel?.personnel_id === rec.personnel_id);
  check('public verify API formats multi-values for display',
    apiVerify.data?.personnel?.group_name === `${BRIGADA_GROUP} · ${GRIFFIN_GROUP}`,
    apiVerify.data?.personnel?.group_name);
  check('public verify page renders multi-values',
    page.text.includes('Griffin Fire and Rescue Volunteer Group'));
  check('public verify API never leaks the storage delimiter',
    !JSON.stringify(apiVerify.data).includes('|'));

  const unknown = await call('GET', '/api/verify/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  check('unknown token reports INVALID', unknown.data?.status === 'INVALID');

  const unknownPage = await call('GET', '/verify/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  check('unknown token page renders INVALID', unknownPage.status === 404 && unknownPage.text.includes('INVALID'));

  const malformed = await call('GET', '/api/verify/%22%20OR%201%3D1--');
  check('malformed/injected token is rejected as INVALID', malformed.data?.status === 'INVALID');

  const sqlInjection = await call('GET',
    `/api/verify/${"' OR 1=1 --aaaaaaaaaaaaaaaaaaaa"}`);
  check('SQL injection attempt does not match a record', sqlInjection.data?.status === 'INVALID');

  const expiredVerify = await call('GET', `/api/verify/${(expiredRec.verification_url ?? '').split('/verify/')[1]}`);
  check('record with a past validity date reports EXPIRED', expiredVerify.data?.status === 'EXPIRED',
    expiredVerify.data?.status);

  /* -------------------------------------------------------------- lifecycle */
  console.log('\nLifecycle: renew, suspend, reactivate, revoke');
  const badRenew = await call('POST', `/api/personnel/${rec.id}/renew`,
    { valid_until: pastDate }, { origin: ORIGIN });
  check('renewing into the past returns 422', badRenew.status === 422, `got ${badRenew.status}`);

  const renew = await call('POST', `/api/personnel/${rec.id}/renew`,
    { valid_until: '2031-12-31' }, { origin: ORIGIN });
  check('renewal updates validity (200)', renew.status === 200 && renew.data?.record?.valid_until === '2031-12-31');
  check('renewal does not change the verification URL',
    renew.data?.record?.verification_url === rec.verification_url);

  const suspend = await call('POST', `/api/personnel/${rec.id}/suspend`, {}, { origin: ORIGIN });
  check('suspend succeeds (200)', suspend.status === 200 && suspend.data?.record?.status === 'suspended');
  const suspendedVerify = await call('GET', `/api/verify/${token}`);
  check('suspended record reports SUSPENDED', suspendedVerify.data?.status === 'SUSPENDED');
  const suspendedPage = await call('GET', `/verify/${token}`);
  check('suspended state shown on the page', suspendedPage.text.includes('SUSPENDED'));

  const reactivate = await call('POST', `/api/personnel/${rec.id}/reactivate`, {}, { origin: ORIGIN });
  check('reactivate succeeds (200)', reactivate.status === 200 && reactivate.data?.record?.status === 'active');
  check('reactivated record verifies VALID again',
    (await call('GET', `/api/verify/${token}`)).data?.status === 'VALID');

  const revoke = await call('POST', `/api/personnel/${rec.id}/revoke`, {}, { origin: ORIGIN });
  check('revoke succeeds (200)', revoke.status === 200 && revoke.data?.record?.status === 'revoked');
  check('revoked record reports REVOKED', (await call('GET', `/api/verify/${token}`)).data?.status === 'REVOKED');

  const reactivateRevoked = await call('POST', `/api/personnel/${rec.id}/reactivate`, {}, { origin: ORIGIN });
  check('a revoked record cannot be reactivated (409)', reactivateRevoked.status === 409,
    `got ${reactivateRevoked.status}`);

  /* ------------------------------------------------------- audit + summary */
  console.log('\nAudit log and dashboard');
  const audit = await call('GET', '/api/audit?page_size=50');
  check('GET /api/audit returns entries (200)', audit.status === 200 && audit.data?.items?.length > 0);
  const actions = new Set(audit.data?.items?.map((a) => a.action));
  for (const expected of ['personnel.create', 'personnel.update', 'personnel.renew',
    'personnel.suspend', 'personnel.reactivate', 'personnel.revoke', 'auth.login']) {
    check(`audit records ${expected}`, actions.has(expected));
  }
  check('audit log does not contain the private address',
    !audit.text.includes('Sun Valley, Parañaque'));

  const dashboard = await call('GET', '/api/dashboard');
  check('GET /api/dashboard returns counts', dashboard.status === 200 && dashboard.data?.counts?.total >= 2);
  check('dashboard reports at least one expired record', dashboard.data?.counts?.expired >= 1);

  const logout = await call('POST', '/api/auth/logout', {}, { origin: ORIGIN });
  check('logout succeeds (200)', logout.status === 200);
  const afterLogout = await call('GET', '/api/personnel');
  check('session is invalid after logout (401)', afterLogout.status === 401);

  /* -------------------------------------------------------------- summary */
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Smoke test could not run:', err.message);
  process.exitCode = 1;
});
