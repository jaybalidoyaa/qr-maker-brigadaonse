-- seed.sql
-- Development-only bootstrap account for `npm run db:seed:local` (uses --local).
-- This file contains NO real personnel data and NO production credentials.
--
--   username: admin
--   password: ChangeMe123!
--
-- The stored value is a PBKDF2-HMAC-SHA256 hash (100,000 iterations — the
-- maximum workerd's WebCrypto supports — with a 16-byte salt). Change this password after first sign-in, or skip this file entirely
-- and create your own account through the one-time `POST /api/setup` endpoint.
-- Never apply this file with --remote.

INSERT INTO admin_users (username, password_hash, display_name, role)
VALUES (
  'admin',
  'pbkdf2-sha256$100000$nWqjnjYuQe61s32o+AucaA==$lxo3ezVbTsfehzHNIZLtngOjKxZzg86OmxxS4VyfCcg=',
  'Local Development Admin',
  'admin'
) ON CONFLICT (username) DO NOTHING;
