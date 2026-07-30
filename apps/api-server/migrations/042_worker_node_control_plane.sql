CREATE TABLE worker_nodes (
  node_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  desired_state TEXT NOT NULL DEFAULT 'active'
    CHECK (desired_state IN ('active','draining','disabled')),
  registered_at TEXT NOT NULL,
  last_seen_at TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE worker_instances
  ADD COLUMN node_id TEXT,
  ADD COLUMN host_name TEXT,
  ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN applied_state TEXT NOT NULL DEFAULT 'active'
    CHECK (applied_state IN ('active','draining','disabled')),
  ADD COLUMN active_jobs INTEGER NOT NULL DEFAULT 0;

INSERT INTO worker_nodes
  (node_id,display_name,description,desired_state,registered_at,last_seen_at,updated_at)
SELECT instance_id,instance_id,'由历史 Worker 实例迁移','active',started_at,last_heartbeat_at,last_heartbeat_at
FROM worker_instances
ON CONFLICT(node_id) DO NOTHING;

UPDATE worker_instances
SET node_id=instance_id,
    host_name=instance_id
WHERE node_id IS NULL;

ALTER TABLE worker_instances
  ALTER COLUMN node_id SET NOT NULL;

ALTER TABLE worker_instances
  ADD CONSTRAINT worker_instances_node_fk
  FOREIGN KEY (node_id) REFERENCES worker_nodes(node_id) ON DELETE CASCADE;

CREATE INDEX worker_instances_node_health_idx
  ON worker_instances(node_id,status,last_heartbeat_at DESC);

CREATE INDEX worker_nodes_desired_state_idx
  ON worker_nodes(desired_state,updated_at DESC);
