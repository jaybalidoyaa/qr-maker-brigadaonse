/**
 * Verification status rules. All expiry comparisons happen in Asia/Manila.
 *
 * Ordering (server-side, never trusting the client):
 *   1. unknown token .............. INVALID
 *   2. revoked record ............. REVOKED
 *   3. suspended record ........... SUSPENDED
 *   4. missing/malformed date ..... INVALID  (never auto-valid)
 *   5. date in the past ........... EXPIRED
 *   6. otherwise .................. VALID
 *
 * Expiration boundary: a record is VALID through the ENTIRE valid_until day in
 * Asia/Manila and becomes EXPIRED at 00:00:00 Asia/Manila the following day.
 */

export const MANILA_TIMEZONE = 'Asia/Manila';

export type VerificationStatus = 'VALID' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED' | 'INVALID';

export interface StatusResult {
  status: VerificationStatus;
  label: string;
  reason: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map((n) => Number.parseInt(n, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Today's calendar date in Asia/Manila, formatted YYYY-MM-DD. */
export function manilaToday(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Formats the current date/time in Asia/Manila for display. */
export function manilaDateTime(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-PH', {
    timeZone: MANILA_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${fmt.format(now)} (Manila)`;
}

export function computeStatus(
  record: { valid_until: string | null; status: string } | null,
  now: Date = new Date(),
): StatusResult {
  if (!record) {
    return {
      status: 'INVALID',
      label: 'INVALID CODE',
      reason: 'This verification code does not match any record in the registry.',
    };
  }
  if (record.status === 'revoked') {
    return {
      status: 'REVOKED',
      label: 'REVOKED',
      reason: 'This identification has been revoked by the organization and is no longer recognized.',
    };
  }
  if (record.status === 'suspended') {
    return {
      status: 'SUSPENDED',
      label: 'SUSPENDED',
      reason: 'This identification is currently suspended pending review.',
    };
  }
  if (!isValidDateString(record.valid_until)) {
    return {
      status: 'INVALID',
      label: 'INVALID',
      reason: 'This record has no valid validity date and cannot be treated as a valid identification.',
    };
  }
  const today = manilaToday(now);
  if (record.valid_until < today) {
    return {
      status: 'EXPIRED',
      label: 'EXPIRED',
      reason: `Validity ended on ${record.valid_until} (Asia/Manila).`,
    };
  }
  return {
    status: 'VALID',
    label: 'ACTIVE / VALID',
    reason: `Valid through ${record.valid_until} (Asia/Manila).`,
  };
}
