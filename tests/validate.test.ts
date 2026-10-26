import { describe, expect, it } from 'vitest';
import { GROUP_OPTIONS, POSITION_OPTIONS } from '../src/options';
import { MAX_PHOTO_BYTES, validatePersonnel, validateRenewal } from '../src/validate';

const valid = {
  full_name: 'Juan Dela Cruz',
  address: '123 Sunset Lane, Sun Valley',
  group_name: GROUP_OPTIONS[1],
  position: POSITION_OPTIONS[0],
  valid_until: '2027-06-30',
};

describe('validatePersonnel', () => {
  it('accepts a complete record', () => {
    const result = validatePersonnel(valid);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual({});
    expect(result.value.full_name).toBe('Juan Dela Cruz');
  });

  it('requires every primary field', () => {
    const result = validatePersonnel({});
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors).sort()).toEqual([
      'address',
      'full_name',
      'group_name',
      'position',
      'valid_until',
    ]);
  });

  it('rejects an impossible validity date', () => {
    const result = validatePersonnel({ ...valid, valid_until: '2027-02-30' });
    expect(result.ok).toBe(false);
    expect(result.errors.valid_until).toBeTruthy();
    expect(validatePersonnel({ ...valid, valid_until: '30/06/2027' }).ok).toBe(false);
  });

  it('normalises whitespace and strips control characters', () => {
    const result = validatePersonnel({ ...valid, full_name: '  Juan   Dela\u0000\u0007 Cruz  ' });
    expect(result.value.full_name).toBe('Juan Dela Cruz');
  });

  it('accepts multiple groups and positions from the checkbox form', () => {
    const result = validatePersonnel({
      ...valid,
      group_name: [GROUP_OPTIONS[0], GROUP_OPTIONS[2]],
      position: [POSITION_OPTIONS[0], POSITION_OPTIONS[4]],
    });
    expect(result.ok).toBe(true);
    expect(result.value.group_name).toBe(`${GROUP_OPTIONS[0]}|${GROUP_OPTIONS[2]}`);
    expect(result.value.position).toBe(`${POSITION_OPTIONS[0]}|${POSITION_OPTIONS[4]}`);
  });

  it('accepts an already-joined string (record round-trip on edit)', () => {
    const joined = `${GROUP_OPTIONS[1]}|${GROUP_OPTIONS[3]}`;
    const result = validatePersonnel({ ...valid, group_name: joined });
    expect(result.ok).toBe(true);
    expect(result.value.group_name).toBe(joined);
  });

  it('deduplicates repeated selections and trims them', () => {
    const result = validatePersonnel({
      ...valid,
      group_name: [`  ${GROUP_OPTIONS[1]} `, GROUP_OPTIONS[1]],
    });
    expect(result.ok).toBe(true);
    expect(result.value.group_name).toBe(GROUP_OPTIONS[1]);
  });

  it('requires at least one group and one position', () => {
    const result = validatePersonnel({ ...valid, group_name: [], position: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.group_name).toContain('at least one');
    expect(result.errors.position).toContain('at least one');
  });

  it('rejects values outside the canonical option lists', () => {
    const result = validatePersonnel({
      ...valid,
      group_name: [GROUP_OPTIONS[0], 'Made Up Group'],
      position: ['King'],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.group_name).toContain('Made Up Group');
    expect(result.errors.position).toContain('King');
  });

  it('validates optional personnel IDs', () => {
    expect(validatePersonnel({ ...valid, personnel_id: 'BO-2026-ABC123' }).ok).toBe(true);
    expect(validatePersonnel({ ...valid, personnel_id: 'x' }).ok).toBe(false);
    expect(validatePersonnel({ ...valid, personnel_id: 'bad id!' }).ok).toBe(false);
  });

  it('rejects invalid profile photos and enforces the size cap', () => {
    expect(validatePersonnel({ ...valid, profile_photo: 'data:text/html,<script>' }).ok).toBe(false);
    expect(validatePersonnel({ ...valid, profile_photo: 'https://example.com/p.jpg' }).ok).toBe(false);

    const small = `data:image/png;base64,${'A'.repeat(64)}`;
    expect(validatePersonnel({ ...valid, profile_photo: small }).ok).toBe(true);

    const huge = `data:image/png;base64,${'A'.repeat(MAX_PHOTO_BYTES * 2)}`;
    const result = validatePersonnel({ ...valid, profile_photo: huge });
    expect(result.ok).toBe(false);
    expect(result.errors.profile_photo).toContain('smaller');
  });

  it('rejects unknown statuses', () => {
    expect(validatePersonnel({ ...valid, status: 'zombie' }).ok).toBe(false);
    expect(validatePersonnel({ ...valid, status: 'revoked' }).value.status).toBe('revoked');
  });
});

describe('validateRenewal', () => {
  it('accepts ISO dates only', () => {
    expect(validateRenewal({ valid_until: '2027-01-01' })).toMatchObject({ ok: true });
    expect(validateRenewal({ valid_until: 'next year' }).ok).toBe(false);
    expect(validateRenewal({}).ok).toBe(false);
  });
});
