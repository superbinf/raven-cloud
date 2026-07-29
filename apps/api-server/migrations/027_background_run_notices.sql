ALTER TABLE background_task_runs
  ADD COLUMN IF NOT EXISTS notice_message TEXT;
