-- 003 was already deployed before source_hash was introduced. Keep upgrades
-- forward-only so existing PostgreSQL databases receive the new column.
ALTER TABLE edge_snapshots
  ADD COLUMN IF NOT EXISTS source_hash TEXT;
