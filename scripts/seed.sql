-- seed.sql
-- Development-only bootstrap account for `npm run db:seed:local` (uses --local).
-- This file contains NO real personnel data and NO production credentials.
--
--   username: admin
--   password: ChangeMe123!
--
-- The stored value is a PBKDF2-HMAC-SHA256 hash (600,000 iterations, 16-byte
-- salt). Change this password after first sign-in, or skip this file entirely
-- and create your own account through the one-time `POST /api/setup` endpoint.
-- Never apply this file with --remote.

INSERT INTO admin_users (username, password_hash, display_name, role)
VALUES (
  'admin',
  'pbkdf2-sha256$600000$57A+M6GcwcwL288qsA39kw==$HvSHAxVYGJJg/9+tiUKffb8OluPqHK5XrXoyfH1gpTA=',
  'Local Development Admin',
  'admin'
) ON CONFLICT (username) DO NOTHING;
