import { describe, expect, it } from 'vitest';
import { computeStatus, isValidDateString, manilaDateTime, manilaToday } from '../src/status';

const DAY = 86_400_000;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const active = (valid_until: string | null) => ({ valid_until, status: 'active' as const });

describe('isValidDateString', () => {
  it('accepts real ISO dates', () => {
    expect(isValidDateString('2026-10-26')).toBe(true);
    expect(isValidDateString('2028-02-29')).toBe(true); // leap year
  });

  it('rejects malformed, impossible and non-string values', () => {
    expect(isValidDateString('26-10-2026')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2027-02-29')).toBe(false); // not a leap year
    expect(isValidDateString('')).toBe(false);
    expect(isValidDateString(null)).toBe(false);
    expect(isValidDateString(20261026)).toBe(false);
    expect(isValidDateString('2026-10-26T00:00:00Z')).toBe(false);
  });
});

describe('manilaToday', () => {
  it('returns YYYY-MM-DD in Asia/Manila', () => {
    expect(manilaToday(new Date('2026-10-26T00:00:00Z'))).toBe('2026-10-26');
    // 16:00 UTC on the 26th is already the 27th in Manila (UTC+8).
    expect(manilaToday(new Date('2026-10-26T16:00:00Z'))).toBe('2026-10-27');
    // 15:59 UTC on the 26th is still the 26th in Manila.
    expect(manilaToday(new Date('2026-10-26T15:59:00Z'))).toBe('2026-10-26');
  });

  it('formats a readable Manila timestamp', () => {
    expect(manilaDateTime(new Date('2026-10-26T00:00:00Z'))).toContain('Manila');
  });
});

describe('computeStatus', () => {
  it('returns INVALID for an unknown token', () => {
    const result = computeStatus(null);
    expect(result.status).toBe('INVALID');
    expect(result.label).toBe('INVALID CODE');
  });

  it('returns REVOKED before any other rule', () => {
    expect(computeStatus({ valid_until: '2099-12-31', status: 'revoked' }).status).toBe('REVOKED');
    expect(computeStatus({ valid_until: null, status: 'revoked' }).status).toBe('REVOKED');
  });

  it('returns SUSPENDED for suspended records', () => {
    expect(computeStatus({ valid_until: '2099-12-31', status: 'suspended' }).status).toBe('SUSPENDED');
  });

  it('never treats a missing or malformed validity date as valid', () => {
    expect(computeStatus(active(null)).status).toBe('INVALID');
    expect(computeStatus(active('')).status).toBe('INVALID');
    expect(computeStatus(active('not-a-date')).status).toBe('INVALID');
    expect(computeStatus(active('2026-99-99')).status).toBe('INVALID');
  });

  it('keeps a record valid through the whole valid_until day in Manila', () => {
    const today = manilaToday();
    expect(computeStatus(active(today)).status).toBe('VALID');
    expect(computeStatus(active(addDays(today, 1))).status).toBe('VALID');
  });

  it('expires exactly one day after valid_until (Manila boundary)', () => {
    const today = manilaToday();
    const yesterday = addDays(today, -1);
    const result = computeStatus(active(yesterday));
    expect(result.status).toBe('EXPIRED');
    expect(result.reason).toContain(yesterday);
  });

  it('is still VALID at 23:59 Manila on the expiry day and EXPIRED at 00:00 the next day', () => {
    const day = manilaToday();
    // 15:59 UTC = 23:59 Manila of the same day
    expect(computeStatus(active(day), new Date(`${day}T15:59:59Z`)).status).toBe('VALID');
    // 16:00 UTC = 00:00 Manila of the next day
    expect(computeStatus(active(day), new Date(`${day}T16:00:00Z`)).status).toBe('EXPIRED');
  });

  it('reports suspended records as suspended even when expired', () => {
    expect(computeStatus({ valid_until: '2000-01-01', status: 'suspended' }).status).toBe('SUSPENDED');
  });
});

describe('date helpers', () => {
  it('handles year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-10-26', 30)).toBe('2026-11-25');
  });
});
