import { describe, expect, it } from 'vitest';
import { MAX_PHOTO_BYTES, validatePersonnel, validateRenewal } from '../src/validate';

const valid = {
  full_name: 'Juan Dela Cruz',
  address: '123 Sunset Lane, Sun Valley',
  group_name: 'Alpha Response',
  position: 'Responder',
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
