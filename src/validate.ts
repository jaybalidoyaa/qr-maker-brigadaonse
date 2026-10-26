/**
 * Input validation for personnel payloads. Returns normalised values plus a
 * field->message map so the frontend can highlight invalid inputs.
 */

import { isValidDateString } from './status';

export interface PersonnelPayload {
  personnel_id?: string;
  full_name: string;
  address: string;
  group_name: string;
  position: string;
  valid_until: string;
  profile_photo?: string | null;
  status?: 'active' | 'suspended' | 'revoked';
  remarks?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
  value: PersonnelPayload;
}

const PERSONNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;
const STATUS_VALUES = ['active', 'suspended', 'revoked'] as const;
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;
export const MAX_PHOTO_BYTES = 256 * 1024;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalises whitespace and strips control characters (also helps against log injection). */
function cleanText(value: unknown, max: number): string {
  return str(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function cleanMultiline(value: unknown, max: number): string {
  return str(value)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, max);
}

export function validatePersonnel(body: unknown): ValidationResult {
  const errors: Record<string, string> = {};
  const src = (body ?? {}) as Record<string, unknown>;

  const full_name = cleanText(src.full_name, 120);
  const address = typeof src.address === 'string' ? cleanMultiline(src.address, 400).trim() : '';
  const group_name = cleanText(src.group_name, 80);
  const position = cleanText(src.position, 80);
  const valid_until = cleanText(src.valid_until, 10);
  const personnel_id = cleanText(src.personnel_id, 32);
  const remarks = cleanMultiline(src.remarks, 1000);

  if (full_name.length < 2) errors.full_name = 'Full name is required (at least 2 characters).';
  if (address.length < 2) errors.address = 'Address is required (at least 2 characters).';
  if (group_name.length < 2) errors.group_name = 'Group is required.';
  if (position.length < 2) errors.position = 'Position is required.';
  if (!isValidDateString(valid_until)) {
    errors.valid_until = 'Valid Until must be a real date in YYYY-MM-DD format.';
  }
  if (personnel_id && !PERSONNEL_ID_RE.test(personnel_id)) {
    errors.personnel_id = 'Personnel ID may contain letters, numbers, dot, dash and underscore (2–32 chars).';
  }

  let status: PersonnelPayload['status'];
  if (src.status !== undefined && src.status !== null && src.status !== '') {
    if ((STATUS_VALUES as readonly string[]).includes(String(src.status))) {
      status = String(src.status) as PersonnelPayload['status'];
    } else {
      errors.status = 'Status must be active, suspended or revoked.';
    }
  }

  let profile_photo: string | null = null;
  if (typeof src.profile_photo === 'string' && src.profile_photo.trim() !== '') {
    const photo = src.profile_photo.trim();
    if (!PHOTO_RE.test(photo)) {
      errors.profile_photo = 'Profile photo must be a PNG, JPEG, WebP or GIF data URL.';
    } else {
      // base64 length -> bytes (approximate, then exact via decoded length).
      const base64 = photo.slice(photo.indexOf(',') + 1);
      const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
      if (bytes > MAX_PHOTO_BYTES) {
        errors.profile_photo = `Profile photo must be ${Math.round(MAX_PHOTO_BYTES / 1024)} KB or smaller.`;
      } else {
        profile_photo = photo;
      }
    }
  } else if (src.profile_photo === null) {
    profile_photo = null;
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      ...(personnel_id ? { personnel_id } : {}),
      full_name,
      address,
      group_name,
      position,
      valid_until,
      profile_photo,
      ...(status ? { status } : {}),
      ...(typeof src.remarks === 'string' ? { remarks } : {}),
    },
  };
}

/** Validates the "renew" payload (a new valid-until date). */
export function validateRenewal(body: unknown): { ok: boolean; errors: Record<string, string>; value?: string } {
  const src = (body ?? {}) as Record<string, unknown>;
  const valid_until = cleanText(src.valid_until, 10);
  if (!isValidDateString(valid_until)) {
    return {
      ok: false,
      errors: { valid_until: 'valid_until must be a real date in YYYY-MM-DD format.' },
    };
  }
  return { ok: true, errors: {}, value: valid_until };
}
