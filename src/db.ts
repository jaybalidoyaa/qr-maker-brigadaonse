/**
 * D1 data access. Every query is a prepared statement with bound parameters.
 */

import type { Env } from './config';

export interface PersonnelRow {
  id: number;
  personnel_id: string;
  verification_token_hash: string;
  verification_token_enc: string;
  full_name: string;
  address: string;
  group_name: string;
  position: string;
  profile_photo: string | null;
  valid_until: string | null;
  status: 'active' | 'suspended' | 'revoked';
  remarks: string | null;
  date_registered: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: 'admin' | 'viewer';
  is_active: number;
  created_at: string;
  last_login_at: string | null;
}

export interface AuditRow {
  id: number;
  actor_id: number | null;
  actor_name: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  metadata: string | null;
  created_at: string;
}

export interface ListQuery {
  q?: string;
  status?: string;
  group?: string;
  /** Only return records expiring on or before this Manila calendar date. */
  expiringBefore?: string;
  page: number;
  pageSize: number;
  sort: string;
  order: 'asc' | 'desc';
}

/** Whitelisted sort columns — never interpolate user input into SQL. */
const SORT_COLUMNS: Record<string, string> = {
  name: 'full_name',
  personnel_id: 'personnel_id',
  valid_until: 'valid_until',
  group: 'group_name',
  status: 'status',
  created_at: 'created_at',
  updated_at: 'updated_at',
};

function buildFilters(query: ListQuery): { sql: string; binds: (string | number)[] } {
  const where: string[] = [];
  const binds: (string | number)[] = [];

  if (query.q) {
    const like = `%${query.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push(
      `(full_name LIKE ? ESCAPE '\\' OR personnel_id LIKE ? ESCAPE '\\' OR position LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\')`,
    );
    binds.push(like, like, like, like);
  }
  if (query.status) {
    where.push('status = ?');
    binds.push(query.status);
  }
  if (query.group) {
    // group_name can hold several "|"-separated values; match one individual
    // group. Wrapping both sides also matches legacy single-value rows.
    const escaped = query.group.replace(/[\\%_]/g, (m) => `\\${m}`);
    where.push(`('|' || group_name || '|' LIKE ? ESCAPE '\\')`);
    binds.push(`%|${escaped}|%`);
  }
  if (query.expiringBefore !== undefined) {
    // ISO dates compare chronologically as strings.
    where.push('valid_until IS NOT NULL AND valid_until <= ?');
    binds.push(query.expiringBefore);
  }
  return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', binds };
}

export async function listPersonnel(
  env: Env,
  query: ListQuery,
): Promise<{ items: PersonnelRow[]; total: number }> {
  const column = SORT_COLUMNS[query.sort] ?? 'full_name';
  const direction = query.order === 'desc' ? 'DESC' : 'ASC';
  const offset = (query.page - 1) * query.pageSize;

  const { sql: filterSql, binds } = buildFilters(query);
  const listStmt = env.DB.prepare(
    `SELECT * FROM personnel${filterSql} ORDER BY ${column} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
  )
    .bind(...binds, query.pageSize, offset);
  const countStmt = env.DB.prepare(`SELECT COUNT(*) AS n FROM personnel${filterSql}`).bind(...binds);

  const [list, count] = await env.DB.batch([listStmt, countStmt]);
  return {
    items: (list.results ?? []) as unknown as PersonnelRow[],
    total: ((count.results?.[0] as { n?: number })?.n ?? 0) as number,
  };
}

export async function getPersonnel(env: Env, id: number): Promise<PersonnelRow | null> {
  return env.DB.prepare('SELECT * FROM personnel WHERE id = ?')
    .bind(id)
    .first<PersonnelRow>();
}

export async function getPersonnelByTokenHash(
  env: Env,
  tokenHash: string,
): Promise<PersonnelRow | null> {
  return env.DB.prepare('SELECT * FROM personnel WHERE verification_token_hash = ?')
    .bind(tokenHash)
    .first<PersonnelRow>();
}

export async function personnelIdExists(env: Env, personnelId: string, exceptId?: number): Promise<boolean> {
  const row = exceptId
    ? await env.DB.prepare('SELECT id FROM personnel WHERE personnel_id = ? AND id <> ?')
        .bind(personnelId, exceptId)
        .first()
    : await env.DB.prepare('SELECT id FROM personnel WHERE personnel_id = ?').bind(personnelId).first();
  return row !== null;
}

export interface InsertPersonnelInput {
  personnel_id: string;
  verification_token_hash: string;
  verification_token_enc: string;
  full_name: string;
  address: string;
  group_name: string;
  position: string;
  profile_photo: string | null;
  valid_until: string;
  status: string;
  remarks: string | null;
  created_by: string;
}

export async function insertPersonnel(env: Env, input: InsertPersonnelInput): Promise<PersonnelRow> {
  const result = await env.DB.prepare(
    `INSERT INTO personnel
       (personnel_id, verification_token_hash, verification_token_enc, full_name, address,
        group_name, position, profile_photo, valid_until, status, remarks, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
  )
    .bind(
      input.personnel_id,
      input.verification_token_hash,
      input.verification_token_enc,
      input.full_name,
      input.address,
      input.group_name,
      input.position,
      input.profile_photo,
      input.valid_until,
      input.status ?? 'active',
      input.remarks ?? null,
      input.created_by,
    )
    .first<PersonnelRow>();

  if (!result) throw new Error('Failed to insert personnel record');
  return result;
}

export interface UpdatePersonnelInput {
  personnel_id: string;
  full_name: string;
  address: string;
  group_name: string;
  position: string;
  profile_photo: string | null;
  valid_until: string;
  status: string;
  remarks: string | null;
}

export async function updatePersonnel(
  env: Env,
  id: number,
  input: UpdatePersonnelInput,
): Promise<PersonnelRow | null> {
  return env.DB.prepare(
    `UPDATE personnel SET
       personnel_id = ?, full_name = ?, address = ?, group_name = ?, position = ?,
       profile_photo = ?, valid_until = ?, status = ?, remarks = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?
     RETURNING *`,
  )
    .bind(
      input.personnel_id,
      input.full_name,
      input.address,
      input.group_name,
      input.position,
      input.profile_photo,
      input.valid_until,
      input.status,
      input.remarks ?? null,
      id,
    )
    .first<PersonnelRow>();
}

export async function setPersonnelStatus(
  env: Env,
  id: number,
  status: 'active' | 'suspended' | 'revoked',
): Promise<PersonnelRow | null> {
  return env.DB.prepare(
    `UPDATE personnel SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *`,
  )
    .bind(status, id)
    .first<PersonnelRow>();
}

export async function renewPersonnel(
  env: Env,
  id: number,
  validUntil: string,
): Promise<PersonnelRow | null> {
  return env.DB.prepare(
    `UPDATE personnel SET valid_until = ?,
       status = CASE WHEN status = 'revoked' THEN status ELSE 'active' END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? RETURNING *`,
  )
    .bind(validUntil, id)
    .first<PersonnelRow>();
}

export async function listGroups(env: Env): Promise<string[]> {
  const res = await env.DB.prepare(
    'SELECT DISTINCT group_name FROM personnel WHERE group_name <> \'\' ORDER BY group_name ASC',
  ).all<{ group_name: string }>();
  return (res.results ?? []).map((r) => r.group_name);
}

export interface DashboardCounts {
  total: number;
  active: number;
  suspended: number;
  revoked: number;
  expired: number;
  expiring_soon: number;
}

/**
 * Counts computed against the Asia/Manila calendar date supplied by the caller
 * (see status.ts manilaToday) so expiration reporting matches verification.
 */
export async function dashboardCounts(
  env: Env,
  today: string,
  horizon: string,
): Promise<DashboardCounts> {
  const res = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
       SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END) AS revoked,
       SUM(CASE WHEN status = 'active' AND valid_until IS NOT NULL
                 AND valid_until < ? THEN 1 ELSE 0 END) AS expired,
       SUM(CASE WHEN status = 'active' AND valid_until IS NOT NULL
                 AND valid_until >= ? AND valid_until <= ? THEN 1 ELSE 0 END) AS expiring_soon
     FROM personnel`,
  )
    .bind(today, today, horizon)
    .first<Record<string, number>>();

  return {
    total: res?.total ?? 0,
    active: res?.active ?? 0,
    suspended: res?.suspended ?? 0,
    revoked: res?.revoked ?? 0,
    expired: res?.expired ?? 0,
    expiring_soon: res?.expiring_soon ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Audit log                                                                   */
/* -------------------------------------------------------------------------- */

export interface AuditInput {
  actorId: number | null;
  actorName: string;
  action: string;
  entityType?: string;
  entityId?: string | number | null;
  entityLabel?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordAudit(env: Env, input: AuditInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (actor_id, actor_name, action, entity_type, entity_id, entity_label, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.actorId,
      input.actorName,
      input.action,
      input.entityType ?? 'personnel',
      input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
      input.entityLabel ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    )
    .run();
}

export async function listAudit(
  env: Env,
  page: number,
  pageSize: number,
  entityId?: string,
): Promise<{ items: AuditRow[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const filter = entityId ? ' WHERE entity_id = ?' : '';
  const binds = entityId ? [entityId, pageSize, offset] : [pageSize, offset];

  const [list, count] = await env.DB.batch([
    env.DB.prepare(
      `SELECT * FROM audit_logs${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).bind(...binds),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_logs${filter}`).bind(
      ...(entityId ? [entityId] : []),
    ),
  ]);

  return {
    items: (list.results ?? []) as unknown as AuditRow[],
    total: ((count.results?.[0] as { n?: number })?.n ?? 0) as number,
  };
}

/* -------------------------------------------------------------------------- */
/* Verification events (operational monitoring, no IP storage)                */
/* -------------------------------------------------------------------------- */

export async function recordVerificationEvent(
  env: Env,
  tokenHash: string,
  status: string,
  personnelId: number | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO verification_events (personnel_id, token_hash, status) VALUES (?, ?, ?)`,
    )
      .bind(personnelId, tokenHash, status)
      .run();
  } catch (err) {
    // Monitoring must never break verification.
    console.error('verification_events insert failed', err instanceof Error ? err.message : String(err));
  }
}

export async function adminCount(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM admin_users').first<{ n: number }>();
  return row?.n ?? 0;
}
