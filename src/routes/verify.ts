/**
 * Server-rendered public verification page: GET /verify/:token
 * Always reflects current database state (no client-side data fetching).
 */

import { publicAddressMode, publicShowsPersonnelId, type Env } from '../config';
import { getPersonnelByTokenHash } from '../db';
import { recordVerificationEvent } from '../db';
import { computeStatus, isValidDateString, manilaDateTime, MANILA_TIMEZONE } from '../status';
import { escapeHtml, html, sha256Hex } from '../util';

const ORGANIZATION = 'Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Inc.';
const ORGANIZATION_SHORT = 'Brigada Onse';

const STYLES = `
:root{--bg:#0f172a;--card:#ffffff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;
--valid:#15803d;--valid-bg:#dcfce7;--expired:#b45309;--expired-bg:#fef3c7;
--suspended:#c2410c;--suspended-bg:#ffedd5;--revoked:#b91c1c;--revoked-bg:#fee2e2;
--invalid:#b91c1c;--invalid-bg:#fee2e2;--brand:#b91c1c}
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(160deg,#0f172a 0%,#1e293b 100%);
font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
color:var(--ink);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.wrap{width:100%;max-width:460px}
.org{display:flex;align-items:center;gap:12px;color:#e2e8f0;margin-bottom:16px;justify-content:center}
.crest{width:44px;height:44px;border-radius:50%;background:var(--brand);color:#fff;display:flex;
align-items:center;justify-content:center;font-weight:800;font-size:15px;letter-spacing:.5px;
border:2px solid rgba(255,255,255,.35)}
.org h1{font-size:15px;margin:0;line-height:1.3;font-weight:700}
.org p{margin:2px 0 0;font-size:12px;color:#94a3b8}
.card{background:var(--card);border-radius:16px;overflow:hidden;box-shadow:0 20px 45px rgba(0,0,0,.35)}
.banner{padding:20px;text-align:center}
.banner .status{display:inline-block;font-size:22px;font-weight:800;letter-spacing:1px;padding:8px 18px;border-radius:999px}
.status.VALID{background:var(--valid-bg);color:var(--valid)}
.status.EXPIRED{background:var(--expired-bg);color:var(--expired)}
.status.SUSPENDED{background:var(--suspended-bg);color:var(--suspended)}
.status.REVOKED,.status.INVALID{background:var(--invalid-bg);color:var(--invalid)}
.reason{margin:10px 0 0;font-size:13px;color:#475569}
.body{padding:20px}
.photo{width:84px;height:84px;border-radius:50%;object-fit:cover;border:3px solid var(--line);background:#f1f5f9}
.identity{display:flex;gap:14px;align-items:center;margin-bottom:16px}
.identity h2{margin:0 0 4px;font-size:19px;line-height:1.25}
.identity .sub{margin:0;font-size:13px;color:var(--muted)}
dl{margin:0;display:grid;grid-template-columns:40% 60%;gap:8px 10px;font-size:14px}
dt{color:var(--muted)}
dd{margin:0;font-weight:600;word-break:break-word}
.privacy{margin-top:14px;font-size:11.5px;color:var(--muted);line-height:1.5}
.footer{margin-top:14px;text-align:center;color:#94a3b8;font-size:12px}
.badge-internal{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted)}
@media print{body{background:#fff;padding:0}.card{box-shadow:none}}
`;

function row(label: string, value: unknown, mono = false): string {
  if (value === null || value === undefined || value === '') return '';
  return `<dt>${escapeHtml(label)}</dt><dd${mono ? ' style="font-family:ui-monospace,monospace"' : ''}>${escapeHtml(value)}</dd>`;
}

export async function renderVerifyPage(env: Env, request: Request, token: string): Promise<Response> {
  const checkedAt = manilaDateTime();

  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    return page(invalidCard('INVALID CODE', 'This verification code is malformed.', checkedAt));
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
        <p class="sub">${escapeHtml(record.position)} · ${escapeHtml(record.group_name)}</p>
      </div>
    </div>`;

  const details = `
    <dl>
      ${publicShowsPersonnelId(env) ? row('Personnel ID', record.personnel_id, true) : ''}
      ${row('Group', record.group_name)}
      ${row('Position', record.position)}
      ${row('Valid Until', isValidDateString(record.valid_until) ? record.valid_until : 'Not specified')}
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
    <p class="footer">Verified at ${escapeHtml(checkedAt)}</p>`;

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
        <p class="privacy">This QR code is not recognised by the Brigada Onse registry.
        Ask the bearer to present a newly issued identification, or contact the organization.</p>
      </div>
    </div>
    <p class="footer">Checked at ${escapeHtml(checkedAt)}</p>`;
}

function page(body: string, status = 200): Response {
  return html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Personnel Verification — ${ORGANIZATION_SHORT}</title>
<style>${STYLES}</style>
</head>
<body>
<main class="wrap">
  <header class="org">
    <div class="crest" aria-hidden="true">BO</div>
    <div>
      <h1>${escapeHtml(ORGANIZATION)}</h1>
      <p>Official personnel verification</p>
    </div>
  </header>
  ${body}
</main>
</body>
</html>`,
    status,
  );
}
