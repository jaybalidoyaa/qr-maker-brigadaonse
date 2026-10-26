/**
 * JSON API routes.
 *
 * Public:  GET /api/health, POST /api/setup, POST /api/auth/login,
 *          POST /api/auth/logout, GET /api/verify/:token
 * Admin:   everything else — each handler calls requireAuth(), which enforces
 *          origin checks, session validity and the CSRF header.
 */

import {
  assertSameOrigin,
  attemptKey,
  authenticate,
  clearLoginAttempts,
  createSession,
  destroySession,
  loginRateState,
  registerFailedLogin,
  requireAuth,
  sessionCookie,
  clearedSessionCookie,
  SESSION_COOKIE,
} from '../auth';
import { publicAddressMode, publicBaseUrl, publicShowsPersonnelId, verificationUrl } from '../config';
import {
  adminCount,
  dashboardCounts,
  getPersonnel,
  getPersonnelByTokenHash,
  insertPersonnel,
  listAudit,
  listGroups,
  listPersonnel,
  personnelIdExists,
  recordAudit,
  recordVerificationEvent,
  renewPersonnel,
  setPersonnelStatus,
  updatePersonnel,
} from '../db';
import type { PersonnelRow } from '../db';
import { decryptToken, encryptToken, hashPassword } from '../crypto';
import { Router, type Ctx } from '../router';
import { formatMulti, GROUP_OPTIONS, POSITION_OPTIONS } from '../options';
import { computeStatus, isValidDateString, manilaDateTime, manilaToday, MANILA_TIMEZONE } from '../status';
import { HttpError, json, parseCookies, randomToken, sha256Hex } from '../util';
import { validatePersonnel, validateRenewal } from '../validate';
import { qrToPng, qrToSvg } from '../qr';

const ORGANIZATION = 'Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Inc.';
const MAX_BODY_BYTES = 1024 * 1024; // profile photos are additionally capped at 256 KB

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

async function readJson(ctx: Ctx): Promise<Record<string, unknown>> {
  const declared = Number.parseInt(ctx.req.headers.get('content-length') ?? '0', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Request body too large.');
  }
  let text: string;
  try {
    text = await ctx.req.text();
  } catch {
    throw new HttpError(400, 'Unable to read request body.');
  }
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
  try {
    const parsed: unknown = JSON.parse(text || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function parseId(ctx: Ctx): number {
  const id = Number.parseInt(ctx.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Record not found.');
  return id;
}

async function requirePersonnel(ctx: Ctx, id: number): Promise<PersonnelRow> {
  const row = await getPersonnel(ctx.env, id);
  if (!row) throw new HttpError(404, 'Personnel record not found.');
  return row;
}

/** Projection safe for admin JSON responses — never includes token material. */
function adminRecord(row: PersonnelRow): Record<string, unknown> {
  return {
    id: row.id,
    personnel_id: row.personnel_id,
    full_name: row.full_name,
    address: row.address,
    group_name: row.group_name,
    position: row.position,
    profile_photo: row.profile_photo,
    valid_until: row.valid_until,
    status: row.status,
    remarks: row.remarks,
    date_registered: row.date_registered,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verification_status: computeStatus(row).status,
  };
}

/** Detail projection additionally resolves the stable public verification URL. */
async function detailRecord(row: PersonnelRow, ctx: Ctx): Promise<Record<string, unknown>> {
  const token = await decryptToken(ctx.env, row.verification_token_enc);
  return { ...adminRecord(row), verification_url: verificationUrl(ctx.env, ctx.req, token) };
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function generatePersonnelId(ctx: Ctx): Promise<string> {
  const year = manilaToday().slice(0, 4);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  for (let attempt = 0; attempt < 8; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    let suffix = '';
    for (const b of bytes) suffix += alphabet[b % alphabet.length];
    const candidate = `BO-${year}-${suffix}`;
    if (!(await personnelIdExists(ctx.env, candidate))) return candidate;
  }
  throw new HttpError(500, 'Unable to allocate a unique Personnel ID; please supply one manually.');
}

function pagination(page: number, pageSize: number, total: number) {
  return { page, page_size: pageSize, total, total_pages: Math.max(1, Math.ceil(total / pageSize)) };
}

function parseListParams(url: URL) {
  const qp = url.searchParams;
  const page = Math.max(1, Number.parseInt(qp.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(qp.get('page_size') ?? '20', 10) || 20));
  const order = (qp.get('order') ?? 'asc').toLowerCase() === 'desc' ? ('desc' as const) : ('asc' as const);
  return {
    page,
    pageSize,
    order,
    sort: qp.get('sort') ?? 'name',
    q: (qp.get('q') ?? '').trim().slice(0, 80) || undefined,
    status: (qp.get('status') ?? '').trim() || undefined,
    group: (qp.get('group') ?? '').trim() || undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* Route table                                                                 */
/* -------------------------------------------------------------------------- */

export function apiRouter(): Router {
  const r = new Router();

  /* ------------------------------ public -------------------------------- */

  r.get('/api/health', () =>
    json({ ok: true, service: 'brigada-onse-qr-verification', time: new Date().toISOString() }),
  );

  /** One-time bootstrap, closed forever as soon as one admin exists. */
  r.post('/api/setup', async (ctx) => {
    assertSameOrigin(ctx);
    if ((await adminCount(ctx.env)) > 0) {
      throw new HttpError(403, 'Setup is closed: an administrator account already exists.');
    }
    const body = await readJson(ctx);
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const displayName = String(body.display_name ?? '').trim() || null;

    const errors: Record<string, string> = {};
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      errors.username = 'Username must be 3–32 characters (letters, numbers, dot, dash, underscore).';
    }
    if (password.length < 12) errors.password = 'Password must be at least 12 characters.';
    if (password.length > 200) errors.password = 'Password must be 200 characters or fewer.';
    if (Object.keys(errors).length) throw new HttpError(422, 'Validation failed.', errors);

    const passwordHash = await hashPassword(password);
    await ctx.env.DB.prepare(
      `INSERT INTO admin_users (username, password_hash, display_name, role) VALUES (?, ?, ?, 'admin')`,
    )
      .bind(username, passwordHash, displayName)
      .run();
    await recordAudit(ctx.env, {
      actorId: null,
      actorName: username,
      action: 'setup.create_admin',
      entityType: 'admin_users',
      entityLabel: username,
    });
    return json({ ok: true, username }, 201);
  });

  r.post('/api/auth/login', async (ctx) => {
    assertSameOrigin(ctx);
    const body = await readJson(ctx);
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!username || !password) throw new HttpError(400, 'Username and password are required.');

    const key = await attemptKey(username, ctx.ip);
    const state = await loginRateState(ctx.env, key);
    if (!state.allowed) {
      const retryAfter = Math.max(1, state.retryAfterSeconds);
      return json(
        {
          ok: false,
          error: `Too many failed attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          retry_after: retryAfter,
        },
        429,
        { 'retry-after': String(retryAfter) },
      );
    }

    const admin = await authenticate(ctx.env, username, password);
    if (!admin) {
      const after = await registerFailedLogin(ctx.env, key);
      await recordAudit(ctx.env, {
        actorId: null,
        actorName: username.slice(0, 64),
        action: 'auth.login_failed',
        entityType: 'admin_users',
        entityLabel: username.slice(0, 64),
        metadata: { attempts: after.attempts, locked: !after.allowed },
      });
      return json({ ok: false, error: 'Invalid username or password.' }, 401);
    }

    await clearLoginAttempts(ctx.env, key);
    const session = await createSession(ctx.env, admin.id);
    await ctx.env.DB.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), admin.id)
      .run();
    await recordAudit(ctx.env, {
      actorId: admin.id,
      actorName: admin.username,
      action: 'auth.login',
      entityType: 'admin_users',
      entityLabel: admin.username,
    });

    return json(
      {
        ok: true,
        user: {
          id: admin.id,
          username: admin.username,
          display_name: admin.display_name,
          role: admin.role,
        },
        csrf_token: session.csrfToken,
      },
      200,
      { 'set-cookie': sessionCookie(session.token, session.maxAge) },
    );
  });

  r.post('/api/auth/logout', async (ctx) => {
    assertSameOrigin(ctx);
    const token = parseCookies(ctx.req)[SESSION_COOKIE];
    if (token) await destroySession(ctx.env, token);
    return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie() });
  });

  r.get('/api/auth/me', async (ctx) => {
    const auth = await requireAuth(ctx);
    return json({
      ok: true,
      user: {
        id: auth.admin.id,
        username: auth.admin.username,
        display_name: auth.admin.display_name,
        role: auth.admin.role,
        last_login_at: auth.admin.last_login_at,
      },
      csrf_token: auth.session.csrf_token,
      expires_at: auth.session.expires_at,
    });
  });

  /* ---------------------------- dashboard ------------------------------- */

  r.get('/api/dashboard', async (ctx) => {
    await requireAuth(ctx);
    const today = manilaToday();
    const counts = await dashboardCounts(ctx.env, today, addDays(today, 30));
    const expiring = await listPersonnel(ctx.env, {
      expiringBefore: addDays(today, 30),
      page: 1,
      pageSize: 10,
      sort: 'valid_until',
      order: 'asc',
    });
    const audit = await listAudit(ctx.env, 1, 8);
    return json({
      ok: true,
      counts,
      expiring: expiring.items,
      recent_activity: audit.items.map(sanitizeAudit),
      today,
    });
  });

  r.get('/api/groups', async (ctx) => {
    await requireAuth(ctx);
    return json({
      ok: true,
      // Canonical selectable options (drive the checkboxes and the filter).
      groups: GROUP_OPTIONS,
      positions: POSITION_OPTIONS,
      // Values currently present in the data, including any legacy rows.
      stored_groups: await listGroups(ctx.env),
    });
  });

  /* ----------------------------- personnel ------------------------------ */

  r.get('/api/personnel', async (ctx) => {
    await requireAuth(ctx);
    const params = parseListParams(ctx.url);
    const { items, total } = await listPersonnel(ctx.env, params);
    return json({
      ok: true,
      items: items.map(adminRecord),
      pagination: pagination(params.page, params.pageSize, total),
    });
  });

  r.post('/api/personnel', async (ctx) => {
    const auth = await requireAuth(ctx);
    const body = await readJson(ctx);
    const result = validatePersonnel(body);
    if (!result.ok) throw new HttpError(422, 'Validation failed.', result.errors);
    const value = result.value;

    let personnelId = (value.personnel_id ?? '').toUpperCase();
    if (!personnelId) personnelId = await generatePersonnelId(ctx);
    else if (await personnelIdExists(ctx.env, personnelId)) {
      throw new HttpError(409, 'Validation failed.', {
        personnel_id: `Personnel ID "${personnelId}" already exists.`,
      });
    }

    // One permanent, cryptographically random token per record. The QR URL
    // contains only this token and never changes for the life of the record.
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const tokenEnc = await encryptToken(ctx.env, token);

    let row: PersonnelRow;
    try {
      row = await insertPersonnel(ctx.env, {
        personnel_id: personnelId,
        verification_token_hash: tokenHash,
        verification_token_enc: tokenEnc,
        full_name: value.full_name,
        address: value.address,
        group_name: value.group_name,
        position: value.position,
        profile_photo: value.profile_photo ?? null,
        valid_until: value.valid_until,
        status: value.status ?? 'active',
        remarks: value.remarks ?? null,
        created_by: auth.admin.username,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (/UNIQUE constraint failed/i.test(message)) {
        throw new HttpError(409, 'Validation failed.', {
          personnel_id: 'A record with this Personnel ID already exists.',
        });
      }
      throw err;
    }

    await recordAudit(ctx.env, {
      actorId: auth.admin.id,
      actorName: auth.admin.username,
      action: 'personnel.create',
      entityId: row.id,
      entityLabel: row.personnel_id,
      metadata: { full_name: row.full_name, group_name: row.group_name, position: row.position },
    });

    return json({ ok: true, record: await detailRecord(row, ctx) }, 201);
  });

  r.get('/api/personnel/:id', async (ctx) => {
    await requireAuth(ctx);
    const row = await requirePersonnel(ctx, parseId(ctx));
    return json({ ok: true, record: await detailRecord(row, ctx) });
  });

  r.put('/api/personnel/:id', async (ctx) => {
    const auth = await requireAuth(ctx);
    const id = parseId(ctx);
    const existing = await requirePersonnel(ctx, id);
    const body = await readJson(ctx);

    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
    // Multi-select fields arrive as arrays and must not be stringified (that
    // would join them with commas); every other field is a plain string.
    const asValue = (key: string, fallback: string): string | string[] => {
      if (!has(key)) return fallback;
      const value = body[key];
      return Array.isArray(value) ? value.map(String) : String(value ?? '');
    };

    const merged = {
      personnel_id: String(asValue('personnel_id', existing.personnel_id)).toUpperCase(),
      full_name: String(asValue('full_name', existing.full_name)),
      address: String(asValue('address', existing.address)),
      group_name: asValue('group_name', existing.group_name),
      position: asValue('position', existing.position),
      valid_until: String(asValue('valid_until', existing.valid_until ?? '')),
      status: String(asValue('status', existing.status)),
      remarks: String(asValue('remarks', existing.remarks ?? '')),
      profile_photo: has('profile_photo') ? (body.profile_photo as string | null) : existing.profile_photo,
    };

    const result = validatePersonnel(merged);
    if (!result.ok) throw new HttpError(422, 'Validation failed.', result.errors);
    const value = result.value;
    const personnelId = (value.personnel_id ?? '').toUpperCase();

    if (await personnelIdExists(ctx.env, personnelId, id)) {
      throw new HttpError(409, 'Validation failed.', {
        personnel_id: `Personnel ID "${personnelId}" already exists.`,
      });
    }

    const before: Record<string, unknown> = {
      personnel_id: existing.personnel_id,
      full_name: existing.full_name,
      address: existing.address,
      group_name: existing.group_name,
      position: existing.position,
      valid_until: existing.valid_until ?? '',
      status: existing.status,
      remarks: existing.remarks ?? '',
      profile_photo: existing.profile_photo ?? null,
    };
    const after: Record<string, unknown> = {
      personnel_id: personnelId,
      full_name: value.full_name,
      address: value.address,
      group_name: value.group_name,
      position: value.position,
      valid_until: value.valid_until,
      status: value.status ?? 'active',
      remarks: value.remarks ?? null,
      profile_photo: value.profile_photo ?? null,
    };
    // Field names only — private values (notably the address) never reach the log.
    const changedFields = Object.keys(before).filter((k) => (before[k] ?? null) !== (after[k] ?? null));

    const updated = await updatePersonnel(ctx.env, id, {
      personnel_id: personnelId,
      full_name: value.full_name,
      address: value.address,
      group_name: value.group_name,
      position: value.position,
      profile_photo: value.profile_photo ?? null,
      valid_until: value.valid_until,
      status: value.status ?? 'active',
      remarks: value.remarks ?? null,
    });
    if (!updated) throw new HttpError(500, 'Failed to update record.');

    await recordAudit(ctx.env, {
      actorId: auth.admin.id,
      actorName: auth.admin.username,
      action: changedFields.includes('status') ? 'personnel.status' : 'personnel.update',
      entityId: id,
      entityLabel: updated.personnel_id,
      metadata: { changed_fields: changedFields },
    });

    return json({ ok: true, record: await detailRecord(updated, ctx) });
  });

  r.post('/api/personnel/:id/renew', async (ctx) => {
    const auth = await requireAuth(ctx);
    const id = parseId(ctx);
    const existing = await requirePersonnel(ctx, id);
    const body = await readJson(ctx);
    const renewal = validateRenewal(body);
    if (!renewal.ok || !renewal.value) throw new HttpError(422, 'Validation failed.', renewal.errors);

    const today = manilaToday();
    if (renewal.value < today) {
      throw new HttpError(422, 'Validation failed.', {
        valid_until: `Renewal date must be today (${today}) or later (Asia/Manila).`,
      });
    }

    const updated = await renewPersonnel(ctx.env, id, renewal.value);
    if (!updated) throw new HttpError(500, 'Failed to renew record.');

    await recordAudit(ctx.env, {
      actorId: auth.admin.id,
      actorName: auth.admin.username,
      action: 'personnel.renew',
      entityId: id,
      entityLabel: updated.personnel_id,
      metadata: { previous_valid_until: existing.valid_until, valid_until: renewal.value },
    });
    return json({ ok: true, record: await detailRecord(updated, ctx) });
  });

  const statusRoutes = [
    { path: '/api/personnel/:id/suspend', status: 'suspended' as const, action: 'personnel.suspend' },
    { path: '/api/personnel/:id/reactivate', status: 'active' as const, action: 'personnel.reactivate' },
    { path: '/api/personnel/:id/revoke', status: 'revoked' as const, action: 'personnel.revoke' },
  ];

  for (const route of statusRoutes) {
    r.post(route.path, async (ctx) => {
      const auth = await requireAuth(ctx);
      const id = parseId(ctx);
      const existing = await requirePersonnel(ctx, id);

      if (route.status === 'suspended' && existing.status === 'revoked') {
        throw new HttpError(409, 'A revoked identification cannot be suspended; register a new record instead.');
      }
      if (route.status === 'active' && existing.status !== 'suspended') {
        throw new HttpError(409, 'Only a suspended identification can be reactivated.');
      }
      if (existing.status === route.status) throw new HttpError(409, `Record is already ${route.status}.`);

      const updated = await setPersonnelStatus(ctx.env, id, route.status);
      if (!updated) throw new HttpError(500, 'Failed to update status.');

      await recordAudit(ctx.env, {
        actorId: auth.admin.id,
        actorName: auth.admin.username,
        action: route.action,
        entityId: id,
        entityLabel: updated.personnel_id,
        metadata: { from: existing.status, to: route.status },
      });
      return json({ ok: true, record: await detailRecord(updated, ctx) });
    });
  }

  r.get('/api/personnel/:id/qr', async (ctx) => {
    await requireAuth(ctx);
    const row = await requirePersonnel(ctx, parseId(ctx));
    const token = await decryptToken(ctx.env, row.verification_token_enc);
    const url = verificationUrl(ctx.env, ctx.req, token);

    const format = (ctx.url.searchParams.get('format') ?? 'svg').toLowerCase();
    const download = ctx.url.searchParams.get('download') === '1';
    const safeName = row.personnel_id.replace(/[^A-Za-z0-9._-]/g, '_');

    if (format === 'png') {
      const bytes = qrToPng(url, { cellSize: 10, marginModules: 4 });
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          ...(download ? { 'content-disposition': `attachment; filename="${safeName}-qr.png"` } : {}),
        },
      });
    }
    if (format !== 'svg') throw new HttpError(400, 'format must be "svg" or "png".');
    return new Response(qrToSvg(url, { cellSize: 8, marginModules: 4 }), {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store',
        ...(download ? { 'content-disposition': `attachment; filename="${safeName}-qr.svg"` } : {}),
      },
    });
  });

  /* ------------------------------- audit -------------------------------- */

  r.get('/api/audit', async (ctx) => {
    await requireAuth(ctx);
    const qp = ctx.url.searchParams;
    const page = Math.max(1, Number.parseInt(qp.get('page') ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(qp.get('page_size') ?? '25', 10) || 25));
    const entityId = (qp.get('entity_id') ?? '').trim() || undefined;
    const { items, total } = await listAudit(ctx.env, page, pageSize, entityId);
    return json({
      ok: true,
      items: items.map(sanitizeAudit),
      pagination: pagination(page, pageSize, total),
    });
  });

  /* --------------------------- public verify ---------------------------- */

  r.get('/api/verify/:token', async (ctx) => {
    const token = (ctx.params.token ?? '').trim();
    const organization = ORGANIZATION;

    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      return json({
        ok: false,
        status: 'INVALID',
        label: 'INVALID CODE',
        reason: 'This verification code is malformed.',
        checked_at: manilaDateTime(),
        timezone: MANILA_TIMEZONE,
        organization,
      });
    }

    const tokenHash = await sha256Hex(token);
    const row = await getPersonnelByTokenHash(ctx.env, tokenHash);
    const result = computeStatus(row);

    if (!row) {
      await recordVerificationEvent(ctx.env, tokenHash, 'INVALID', null);
      return json({
        ok: false,
        status: 'INVALID',
        label: result.label,
        reason: result.reason,
        checked_at: manilaDateTime(),
        timezone: MANILA_TIMEZONE,
        organization,
      });
    }

    await recordVerificationEvent(ctx.env, tokenHash, result.status, row.id);
    return json({
      ok: true,
      status: result.status,
      label: result.label,
      reason: result.reason,
      checked_at: manilaDateTime(),
      timezone: MANILA_TIMEZONE,
      organization,
      personnel: {
        full_name: row.full_name,
        ...(publicShowsPersonnelId(ctx.env) ? { personnel_id: row.personnel_id } : {}),
        group_name: formatMulti(row.group_name),
        position: formatMulti(row.position),
        valid_until: isValidDateString(row.valid_until) ? row.valid_until : null,
        record_status: row.status,
        // The residential address is private unless explicitly configured otherwise.
        ...(publicAddressMode(ctx.env) === 'full' ? { address: row.address } : {}),
        ...(row.status === 'active' && row.profile_photo ? { profile_photo: row.profile_photo } : {}),
      },
    });
  });

  return r;
}

function sanitizeAudit(row: {
  id: number;
  actor_id: number | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  metadata: string | null;
  created_at: string;
}) {
  let metadata: unknown = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = null;
    }
  }
  return { ...row, metadata };
}
