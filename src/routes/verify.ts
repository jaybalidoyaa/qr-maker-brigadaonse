/**
 * Server-rendered public verification page: GET /verify/:token
 * Always reflects current database state (no client-side data fetching).
 */

import { formatMulti } from '../options';
import { publicAddressMode, publicShowsPersonnelId, type Env } from '../config';
import { getPersonnelByTokenHash, recordVerificationEvent } from '../db';
import { computeStatus, isValidDateString, manilaDateTime, MANILA_TIMEZONE } from '../status';
import { escapeHtml, html, sha256Hex } from '../util';

const ORGANIZATION = 'Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Inc.';

const STYLES = `
:root{
  --navy-900:#060223;--navy-800:#0c0733;--navy-700:#16114b;
  --gold:#f1d022;--gold-deep:#cdb351;
  --ink:#0b0a1f;--muted:#6b7386;--line:#e6e8f0;
  --valid:#12833f;--valid-bg:#dcf7e5;
  --expired:#a45a08;--expired-bg:#fef2d7;
  --suspended:#b3560b;--suspended-bg:#ffedd7;
  --revoked:#b3121b;--revoked-bg:#fde8e9;
}
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:26px 18px;
  background:
    radial-gradient(85% 55% at 50% 0%, rgba(241,208,34,.16), transparent 62%),
    linear-gradient(165deg,#0c0733 0%,#060223 100%);
  color:var(--ink);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{width:100%;max-width:470px}
.org{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;margin-bottom:20px}
.org .seal{width:86px;height:86px;object-fit:contain;filter:drop-shadow(0 10px 22px rgba(0,0,0,.5))}
.eyebrow{color:var(--gold);font-size:10px;font-weight:800;letter-spacing:.28em;text-transform:uppercase;margin:0}
.org h1{color:#fff;font-size:14.5px;margin:0;line-height:1.45;text-transform:uppercase;letter-spacing:.05em}
.rule{width:56px;height:3px;background:var(--gold);border-radius:2px}

.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 26px 60px rgba(0,0,0,.45);border-top:4px solid var(--gold)}
.banner{padding:22px 20px;text-align:center;background:linear-gradient(180deg,#fbfbfe,#f4f5fa);border-bottom:1px solid var(--line)}
.banner .status{display:inline-block;font-size:19px;font-weight:900;letter-spacing:.1em;padding:9px 20px;border-radius:999px;text-transform:uppercase}
.status.VALID{background:var(--valid-bg);color:var(--valid);border:1px solid rgba(18,131,63,.3)}
.status.EXPIRED{background:var(--expired-bg);color:var(--expired);border:1px solid rgba(164,90,8,.3)}
.status.SUSPENDED{background:var(--suspended-bg);color:var(--suspended);border:1px solid rgba(179,86,11,.3)}
.status.REVOKED,.status.INVALID{background:var(--revoked-bg);color:var(--revoked);border:1px solid rgba(179,18,27,.3)}
.reason{margin:11px 0 0;font-size:13px;color:#475569;line-height:1.55}
.body{padding:20px}
.identity{display:flex;gap:14px;align-items:center;margin-bottom:16px}
.photo{width:76px;height:76px;border-radius:12px;object-fit:cover;border:2px solid var(--gold);background:#f1f5f9}
.identity h2{margin:0 0 5px;font-size:18px;line-height:1.25;color:var(--navy-900)}
.identity .sub{margin:0;font-size:13px;color:var(--muted);line-height:1.45}
dl{margin:0;display:grid;grid-template-columns:42% 58%;gap:10px 10px;font-size:13.5px}
dt{color:var(--muted);font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;padding-top:2px}
dd{margin:0;font-weight:700;color:var(--ink);word-break:break-word}
.privacy{
  margin-top:16px;font-size:11.5px;color:var(--muted);line-height:1.6;
  background:#fbfbfe;border:1px solid var(--line);border-radius:10px;padding:11px 13px;
}
.footer{margin-top:16px;text-align:center;color:#94a3b8;font-size:11.5px;letter-spacing:.05em}
@media print{
  body{background:#fff;padding:0}
  .card{box-shadow:none;border:1px solid var(--line)}
}
@media (max-width:420px){
  dl{grid-template-columns:1fr;gap:4px 0}
  dt{margin-top:8px}
}
`;

function row(label: string, value: unknown, mono = false): string {
  if (value === null || value === undefined || value === '') return '';
  return `<dt>${escapeHtml(label)}</dt><dd${mono ? ' style="font-family:ui-monospace,monospace"' : ''}>${escapeHtml(value)}</dd>`;
}

export async function renderVerifyPage(env: Env, request: Request, token: string): Promise<Response> {
  const checkedAt = manilaDateTime();

  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return page(invalidCard('Invalid Code', 'This verification code is malformed.', checkedAt));
  }

  const tokenHash = await sha256Hex(token);
  const record = await getPersonnelByTokenHash(env, tokenHash);
  const result = computeStatus(record);

  if (!record) {
    await recordVerificationEvent(env, tokenHash, 'INVALID', null);
    return page(invalidCard(result.label, result.reason, checkedAt), 404);
  }

  await recordVerificationEvent(env, tokenHash, result.status, record.id);

  const showPhoto = record.status === 'active' && record.profile_photo;
  const identity = `
    <div class="identity">
      ${showPhoto ? `<img class="photo" src="${escapeHtml(record.profile_photo)}" alt="Profile photo of ${escapeHtml(record.full_name)}">` : ''}
      <div>
        <h2>${escapeHtml(record.full_name)}</h2>
        <p class="sub">${escapeHtml(formatMulti(record.position))}<br>${escapeHtml(formatMulti(record.group_name))}</p>
      </div>
    </div>`;

  const details = `
    <dl>
      ${publicShowsPersonnelId(env) ? row('Personnel ID', record.personnel_id, true) : ''}
      ${row('Group', formatMulti(record.group_name))}
      ${row('Position', formatMulti(record.position))}
      ${row('Valid Until', isValidDateString(record.valid_until) ? record.valid_until : 'Not Specified')}
      ${row('Record Status', record.status.toUpperCase())}
      ${publicAddressMode(env) === 'full' ? row('Address', record.address) : ''}
    </dl>
    <p class="privacy">
      Verified against the Brigada Onse registry in ${MANILA_TIMEZONE}.
      ${publicAddressMode(env) === 'full' ? '' : 'The residential address of personnel is kept private and is not shown here.'}
    </p>`;

  const body = `
    <div class="card">
      <div class="banner">
        <span class="status ${escapeHtml(result.status)}">${escapeHtml(result.label)}</span>
        <p class="reason">${escapeHtml(result.reason)}</p>
      </div>
      <div class="body">
        ${identity}
        ${details}
      </div>
    </div>
    <p class="footer">Verified At ${escapeHtml(checkedAt)}</p>`;

  // ACTIVE/VALID => 200; every non-valid state still renders with 200 so the
  // page displays correctly in browsers (the status itself is the signal).
  return page(body, 200);
}

function invalidCard(label: string, reason: string, checkedAt: string): string {
  return `
    <div class="card">
      <div class="banner">
        <span class="status INVALID">${escapeHtml(label)}</span>
        <p class="reason">${escapeHtml(reason)}</p>
      </div>
      <div class="body">
        <p class="privacy" style="margin-top:0">This QR code is not recognised by the Brigada Onse registry.
        Ask the bearer to present a newly issued identification, or contact the organization.</p>
      </div>
    </div>
    <p class="footer">Checked At ${escapeHtml(checkedAt)}</p>`;
}

function page(body: string, status = 200): Response {
  return html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#060223">
<title>Personnel Verification — Brigada Onse</title>
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/png" href="/assets/logo.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<style>${STYLES}</style>
</head>
<body>
<main class="wrap">
  <header class="org">
    <img class="seal" src="/assets/logo.png" alt="Brigada Onse Seal">
    <p class="eyebrow">Parañaque's Finest</p>
    <h1>${escapeHtml(ORGANIZATION)}</h1>
    <div class="rule" aria-hidden="true"></div>
  </header>
  ${body}
</main>
</body>
</html>`,
    status,
  );
}
