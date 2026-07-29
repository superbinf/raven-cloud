import { MAINTENANCE_TASKS } from "./maintenance.mjs";

export const SCHEDULER_TASKS = Object.freeze({
  snapshots: "schedule_edge_snapshots",
  collections: "dispatch_due_collection_jobs"
});

export const BACKGROUND_TASK_CATALOG = Object.freeze([
  { identifier: SCHEDULER_TASKS.snapshots, label: "地端快照调度", role: "scheduler", category: "调度", schedulable: true },
  { identifier: SCHEDULER_TASKS.collections, label: "到期采集投递", role: "scheduler", category: "调度", schedulable: true },
  { identifier: "build_edge_snapshot", label: "地端快照构建", role: "snapshot", category: "计算", schedulable: false },
  { identifier: "execute_collection_job", label: "第三方数据采集", role: "io", category: "外部 I/O", schedulable: false },
  { identifier: MAINTENANCE_TASKS.sessions, label: "过期会话清理", role: "maintenance", category: "维护", schedulable: true },
  { identifier: MAINTENANCE_TASKS.snapshots, label: "过期快照与残留清理", role: "maintenance", category: "维护", schedulable: true },
  { identifier: MAINTENANCE_TASKS.history, label: "业务任务历史清理", role: "maintenance", category: "维护", schedulable: true },
  { identifier: MAINTENANCE_TASKS.queueHistory, label: "BullMQ 队列历史清理", role: "maintenance", category: "维护", schedulable: true }
]);

export function mergeTaskLists(...lists) {
  const merged = {};
  for (const list of lists) {
    for (const [name, handler] of Object.entries(list || {})) {
      if (merged[name]) throw new Error(`后台任务标识重复：${name}`);
      merged[name] = handler;
    }
  }
  return merged;
}

export function createSchedulerTaskList({ snapshotJobs, collectionJobs }) {
  return {
    [SCHEDULER_TASKS.snapshots]: () => snapshotJobs.enqueueEnabled(),
    [SCHEDULER_TASKS.collections]: () => collectionJobs.dispatchDue()
  };
}
