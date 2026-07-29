ALTER TABLE fingerprint_watch_items
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'custom'
  CHECK (source_kind IN ('asset','custom'));

UPDATE fingerprint_watch_items AS items
SET source_kind='asset'
FROM fingerprint_watch_groups AS groups
WHERE items.group_id=groups.id
  AND groups.is_default=TRUE;

CREATE INDEX fingerprint_watch_items_source_idx
  ON fingerprint_watch_items(group_id, source_kind, enabled);
