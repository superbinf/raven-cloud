CREATE TABLE background_task_schedules (
  identifier TEXT PRIMARY KEY,
  task_identifier TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('scheduler','maintenance')),
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('interval','daily','weekly')),
  interval_minutes INTEGER CHECK (interval_minutes BETWEEN 1 AND 10080),
  hour INTEGER CHECK (hour BETWEEN 0 AND 23),
  minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
  day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
  next_run_at TEXT,
  last_enqueued_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX background_task_schedules_due_idx
  ON background_task_schedules(enabled,next_run_at);

INSERT INTO background_task_schedules
  (identifier,task_identifier,label,role,category,enabled,schedule_type,interval_minutes,hour,minute,day_of_week,next_run_at,created_at,updated_at)
VALUES
  ('schedule_edge_snapshots','schedule_edge_snapshots','地端快照调度','scheduler','调度',1,'interval',1,NULL,0,NULL,(NOW()+INTERVAL '1 minute')::TEXT,NOW()::TEXT,NOW()::TEXT),
  ('dispatch_due_collection_jobs','dispatch_due_collection_jobs','到期采集投递','scheduler','调度',1,'interval',1,NULL,0,NULL,(NOW()+INTERVAL '1 minute')::TEXT,NOW()::TEXT,NOW()::TEXT),
  ('cleanup_expired_sessions','cleanup_expired_sessions','过期会话清理','maintenance','维护',1,'interval',60,NULL,0,NULL,(NOW()+INTERVAL '1 hour')::TEXT,NOW()::TEXT,NOW()::TEXT),
  ('cleanup_expired_snapshots','cleanup_expired_snapshots','过期快照与残留清理','maintenance','维护',1,'daily',NULL,10,23,NULL,((date_trunc('day',NOW() AT TIME ZONE 'Asia/Shanghai')+INTERVAL '10 hours 23 minutes'+CASE WHEN (NOW() AT TIME ZONE 'Asia/Shanghai')::time>=TIME '10:23' THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Shanghai')::TEXT,NOW()::TEXT,NOW()::TEXT),
  ('cleanup_business_task_history','cleanup_business_task_history','业务任务历史清理','maintenance','维护',1,'daily',NULL,11,41,NULL,((date_trunc('day',NOW() AT TIME ZONE 'Asia/Shanghai')+INTERVAL '11 hours 41 minutes'+CASE WHEN (NOW() AT TIME ZONE 'Asia/Shanghai')::time>=TIME '11:41' THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Shanghai')::TEXT,NOW()::TEXT,NOW()::TEXT),
  ('cleanup_bullmq_history','cleanup_bullmq_history','BullMQ 队列历史清理','maintenance','维护',1,'weekly',NULL,12,53,0,((date_trunc('week',NOW() AT TIME ZONE 'Asia/Shanghai')+INTERVAL '6 days 12 hours 53 minutes'+CASE WHEN NOW() AT TIME ZONE 'Asia/Shanghai'>=date_trunc('week',NOW() AT TIME ZONE 'Asia/Shanghai')+INTERVAL '6 days 12 hours 53 minutes' THEN INTERVAL '7 days' ELSE INTERVAL '0 day' END) AT TIME ZONE 'Asia/Shanghai')::TEXT,NOW()::TEXT,NOW()::TEXT);
