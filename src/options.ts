/**
 * Canonical Group and Position options — single source of truth for the
 * registration form, validation, filtering and the public verification page.
 *
 * To add an option, append it here (and to the docs); the admin form,
 * directory filter and server-side validation all follow automatically.
 */

export const GROUP_OPTIONS = [
  'Brigada Onse Sun Valley Fire and Rescue Volunteer Group, Incorporated',
  'Don Bosco Fire and Rescue Volunteer Group',
  'Griffin Fire and Rescue Volunteer Group',
  'Not Available',
] as const;

export const POSITION_OPTIONS = [
  'Volunteer',
  'Candidate',
  'Regular',
  'Barangay Personnel',
  'Officer',
] as const;

/**
 * A person may hold several groups/positions at once. Values are stored in a
 * single column separated by "|", which appears in none of the option labels
 * (a comma would, e.g. in "…Group, Incorporated").
 */
export const MULTI_SEPARATOR = '|';

/** Splits a stored multi-value string into its individual values. */
export function splitMulti(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(MULTI_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Joins individual values into the stored representation. */
export function joinMulti(values: string[]): string {
  return values.filter(Boolean).join(MULTI_SEPARATOR);
}

/** Human-readable rendering for pages and public API responses. */
export function formatMulti(value: string | null | undefined): string {
  return splitMulti(value).join(' · ');
}

/** True when every value is one of the allowed options. */
export function multiWithinOptions(value: string | null | undefined, options: readonly string[]): boolean {
  const parts = splitMulti(value);
  return parts.length > 0 && parts.every((part) => (options as readonly string[]).includes(part));
}
