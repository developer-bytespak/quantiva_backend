-- One-shot data migration: rename the synthetic general-news asset
-- from "__GENERAL__" to "CRYPTO" so the frontend chip shows a clean label
-- on all HISTORICAL general-feed rows (new rows from the cron already use
-- "CRYPTO" after the NestJS deploy).
--
-- Safe to re-run: the WHERE clause ensures idempotency — if the row is
-- already renamed, UPDATE affects 0 rows.
--
-- Run on the Render production Postgres DB:
--   psql "$DATABASE_URL" -f rename-general-to-crypto.sql

BEGIN;

-- Show the row(s) we're about to rename (0 or 1 expected)
SELECT asset_id, symbol, name, display_name, asset_type
FROM assets
WHERE symbol = '__GENERAL__' AND asset_type = 'crypto';

-- Perform the rename
UPDATE assets
SET
  symbol = 'CRYPTO',
  display_name = 'General Crypto News'
WHERE
  symbol = '__GENERAL__'
  AND asset_type = 'crypto';

-- Confirm the rename took effect
SELECT asset_id, symbol, name, display_name, asset_type
FROM assets
WHERE symbol = 'CRYPTO' AND asset_type = 'crypto';

COMMIT;
