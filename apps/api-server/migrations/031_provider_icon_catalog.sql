ALTER TABLE fingerprint_icon_library DROP CONSTRAINT IF EXISTS fingerprint_icon_library_source_check;
ALTER TABLE fingerprint_icon_library ADD CONSTRAINT fingerprint_icon_library_source_check
  CHECK (source IN ('upload', 'favicon', 'iconify', 'simple-icons', 'domestic', 'provider', 'custom'));
