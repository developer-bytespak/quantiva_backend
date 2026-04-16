-- One-time rescue: reopen rows that were marked 'filled' even though TP/SL
-- were never attached. With the new cron logic (status stays 'submitted'
-- until protection succeeds), these rows will be retried on the next tick
-- and the 48h give-up will eventually kick in if they're structurally stuck.
--
-- Run this ONCE after applying the migration that adds `buy_filled_at` and
-- `protection_attempts` columns to pending_queued_trades. Idempotent — a
-- second run has no effect because it only targets rows matching the
-- stuck-protection pattern.

UPDATE pending_queued_trades
SET
  status              = 'submitted',
  buy_filled_at       = filled_at,                   -- preserve when the buy actually filled
  filled_at           = NULL,                        -- reserved for the truly-done state
  protection_attempts = GREATEST(protection_attempts, 1)
WHERE
  status = 'filled'
  AND failure_reason IS NOT NULL
  AND (tp_order_id IS NULL OR sl_order_id IS NULL);
