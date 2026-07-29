import { useEffect, useState, type FormEvent } from "react";

import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Clock3,
  Database,
  Play,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import {
  type ApiConnection,
  type BackgroundRun,
  type BackgroundRunDetail,
  type BackgroundRunState,
  type CollectionJob,
} from "@sentinel/shared";
import { Button, Modal, Panel, StatusDot, Tag } from "@sentinel/ui";
import {
  PageHeader,
  SequenceCell,
  SequenceHeader,
  Toast,
  type ToastState,
} from "../components/AdminPrimitives";
import {
  TablePagination,
  useClientPagination,
} from "../components/TablePagination";
import { adminApiFetch as apiFetch } from "../shared/api/adminApi";
import { useAdminInitialLoading } from "../app/AdminInitialLoading";

type ScheduleType = "interval" | "daily" | "weekly";
type BackgroundTask = {
  identifier: string;
  taskIdentifier?: string;
  label: string;
  role: string;
  category: string;
  schedulable: boolean;
  enabled: boolean;
  schedule: string;
  scheduleType?: ScheduleType;
  intervalMinutes?: number | null;
  hour?: number | null;
  minute?: number;
  dayOfWeek?: number | null;
  nextRunAt?: string | null;
  lastEnqueuedAt?: string | null;
};
type BackgroundTaskOverview = {
  timezone: string;
  catalog: BackgroundTask[];
  queue: {
    pending: number;
    running: number;
    permanentlyFailed: number;
    oldestWaitingMs: number;
  };
  observability: {
    lastHour: {
      jobs: number;
      succeeded: number;
      failed: number;
      retrying: number;
      retryAttempts: number;
      successRate: number | null;
      averageDurationMs: number;
      p95DurationMs: number;
    };
  };
};

function localTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function duration(value?: number | null) {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

const runState: Record<
  BackgroundRunState,
  { label: string; tone: "success" | "warning" | "danger" | "muted" }
> = {
  running: { label: "运行中", tone: "warning" },
  retrying: { label: "重试中", tone: "warning" },
  succeeded: { label: "成功", tone: "success" },
  failed: { label: "最终失败", tone: "danger" },
};

function runIssue(
  item: Pick<BackgroundRun, "error" | "noticeMessage" | "businessMessage">,
) {
  return (
    item.error?.message || item.noticeMessage || item.businessMessage || ""
  );
}

function issueLocation(item: BackgroundRun) {
  const message = runIssue(item);
  if (/文章(?:引用的)?图片|图片不存在|article-image/iu.test(message))
    return "暗网情报 / 文章正文图片";
  if (/暗网文件|dark-web\/blobs|\bblob\b/iu.test(message))
    return "暗网情报 / 证据文件存储";
  if (/许可证|license/iu.test(message)) return "地端授权 / 许可证";
  if (/数据库|postgres|sql/iu.test(message)) return "数据服务 / PostgreSQL";
  if (/redis|bullmq|队列/iu.test(message))
    return `后台任务 / ${item.queueRole} 队列`;
  return `${item.queueRole} 队列 / ${item.taskIdentifier}`;
}

function runPresentation(item: BackgroundRun) {
  return item.state === "succeeded" && item.noticeMessage
    ? { label: "部分成功", tone: "warning" as const }
    : runState[item.state];
}

function triggerLabel(value: string) {
  return value === "manual"
    ? "手动"
    : value === "schedule"
      ? "定时"
      : value === "recovery"
        ? "恢复"
        : "队列";
}

function scheduleInput(task: BackgroundTask, enabled = task.enabled) {
  return {
    enabled,
    scheduleType: task.scheduleType,
    intervalMinutes: task.intervalMinutes,
    hour: task.hour,
    minute: task.minute,
    dayOfWeek: task.dayOfWeek,
  };
}

export function SchedulesPage() {
  const [jobs, setJobs] = useState<CollectionJob[]>([]);
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [platform, setPlatform] = useState<BackgroundTaskOverview | null>(null);
  const [runs, setRuns] = useState<BackgroundRun[]>([]);
  const [attentionRuns, setAttentionRuns] = useState<BackgroundRun[]>([]);
  const [runView, setRunView] = useState<"recent" | "attention">("recent");
  const [runDetail, setRunDetail] = useState<BackgroundRunDetail | null>(null);
  const [loadingRunDetail, setLoadingRunDetail] = useState(false);
  const [pendingRuns, setPendingRuns] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<CollectionJob | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<BackgroundTask | null>(
    null,
  );
  const [scheduleType, setScheduleType] = useState<ScheduleType>("interval");
  const [running, setRunning] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  useAdminInitialLoading("schedules", initialLoading);

  const applyRuns = (items: BackgroundRun[], attention: BackgroundRun[]) => {
    setRuns(items);
    setAttentionRuns(attention);
    setPendingRuns((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([, runId]) => {
          const observed = [...items, ...attention].find(
            (item) => item.aggregateId === runId,
          );
          return (
            !observed ||
            observed.state === "running" ||
            observed.state === "retrying"
          );
        }),
      ),
    );
  };

  const load = () =>
    Promise.all([
      apiFetch<CollectionJob[]>("/api/collection-jobs"),
      apiFetch<ApiConnection[]>("/api/connections"),
      apiFetch<BackgroundTaskOverview>("/api/background-tasks"),
      apiFetch<{ items: BackgroundRun[] }>("/api/background-runs?limit=30"),
      apiFetch<{ items: BackgroundRun[] }>(
        "/api/background-runs?attention=true&limit=30",
      ),
    ]).then(
      ([jobItems, connectionItems, overview, runItems, attentionItems]) => {
        setJobs(jobItems);
        setConnections(connectionItems);
        setPlatform(overview);
        applyRuns(runItems.items, attentionItems.items);
      },
    );

  useEffect(() => {
    load().catch((error) => setToast({ tone: "warning", text: error.message })).finally(() => setInitialLoading(false));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      Promise.all([
        apiFetch<CollectionJob[]>("/api/collection-jobs"),
        apiFetch<BackgroundTaskOverview>("/api/background-tasks"),
        apiFetch<{ items: BackgroundRun[] }>("/api/background-runs?limit=30"),
        apiFetch<{ items: BackgroundRun[] }>(
          "/api/background-runs?attention=true&limit=30",
        ),
      ])
        .then(([jobItems, overview, runItems, attentionItems]) => {
          setJobs(jobItems);
          setPlatform(overview);
          applyRuns(runItems.items, attentionItems.items);
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!runDetail || !["running", "retrying"].includes(runDetail.state))
      return;
    const jobId = runDetail.bullmqJobId;
    const timer = window.setInterval(() => {
      apiFetch<BackgroundRunDetail>(
        `/api/background-runs/${encodeURIComponent(jobId)}`,
      )
        .then(setRunDetail)
        .catch(() => undefined);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [runDetail?.bullmqJobId, runDetail?.state]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const payload = {
        name: String(form.get("name") || ""),
        connectionId:
          editingJob?.connectionId || String(form.get("connectionId") || ""),
        intervalMinutes: Number(form.get("intervalMinutes") || 60),
        timeoutSeconds: Number(form.get("timeoutSeconds") || 60),
        retryLimit: Number(form.get("retryLimit") || 2),
        enabled: form.get("enabled") === "on",
      };
      await apiFetch(
        editingJob
          ? `/api/collection-jobs/${editingJob.id}`
          : "/api/collection-jobs",
        { method: editingJob ? "PUT" : "POST", body: JSON.stringify(payload) },
      );
      await load();
      setOpen(false);
      setEditingJob(null);
      setToast({
        tone: "success",
        text: editingJob ? "采集计划已更新" : "定时采集任务已创建",
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "任务创建失败",
      });
    }
  };

  const toggle = async (job: CollectionJob) => {
    try {
      const saved = await apiFetch<CollectionJob>(
        `/api/collection-jobs/${job.id}`,
        { method: "PUT", body: JSON.stringify({ enabled: !job.enabled }) },
      );
      setJobs((items) =>
        items.map((item) => (item.id === saved.id ? saved : item)),
      );
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "任务状态更新失败",
      });
    }
  };

  const run = async (job: CollectionJob) => {
    setRunning(job.id);
    try {
      const result = await apiFetch<{
        run: { id: string };
        deduplicated: boolean;
      }>(`/api/collection-jobs/${job.id}/run`, { method: "POST" });
      setPendingRuns((current) => ({ ...current, [job.id]: result.run.id }));
      await load();
      setToast({
        tone: "success",
        text: result.deduplicated
          ? `任务已在队列中（${result.run.id}）`
          : `任务已提交（${result.run.id}）`,
      });
    } catch (error) {
      await load();
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "任务执行失败",
      });
    } finally {
      setRunning(null);
    }
  };

  const openSchedule = (task: BackgroundTask) => {
    setEditingSchedule(task);
    setScheduleType(task.scheduleType || "interval");
  };

  const toggleSchedule = async (task: BackgroundTask) => {
    try {
      await apiFetch(
        `/api/background-tasks/${encodeURIComponent(task.identifier)}/schedule`,
        {
          method: "PUT",
          body: JSON.stringify(scheduleInput(task, !task.enabled)),
        },
      );
      await load();
      setToast({
        tone: "success",
        text: `${task.label}已${task.enabled ? "停用" : "启用"}`,
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "调度状态更新失败",
      });
    }
  };

  const saveSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingSchedule) return;
    const form = new FormData(event.currentTarget);
    const [hour, minute] = String(form.get("time") || "00:00")
      .split(":")
      .map(Number);
    setSavingSchedule(true);
    try {
      await apiFetch(
        `/api/background-tasks/${encodeURIComponent(editingSchedule.identifier)}/schedule`,
        {
          method: "PUT",
          body: JSON.stringify({
            enabled: form.get("enabled") === "on",
            scheduleType,
            intervalMinutes: Number(form.get("intervalMinutes") || 1),
            hour,
            minute,
            dayOfWeek: Number(form.get("dayOfWeek") || 0),
          }),
        },
      );
      await load();
      setEditingSchedule(null);
      setToast({
        tone: "success",
        text: `${editingSchedule.label}的执行时间已更新`,
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "执行时间保存失败",
      });
    } finally {
      setSavingSchedule(false);
    }
  };

  const runSchedule = async (task: BackgroundTask) => {
    setRunning(task.identifier);
    try {
      const result = await apiFetch<{ jobId: string }>(
        `/api/background-tasks/${encodeURIComponent(task.identifier)}/run`,
        { method: "POST" },
      );
      await load();
      setToast({
        tone: "success",
        text: `${task.label}已提交（${result.jobId}）`,
      });
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "任务提交失败",
      });
    } finally {
      setRunning(null);
    }
  };

  const openRunDetail = async (item: BackgroundRun) => {
    setLoadingRunDetail(true);
    try {
      setRunDetail(
        await apiFetch<BackgroundRunDetail>(
          `/api/background-runs/${encodeURIComponent(item.bullmqJobId)}`,
        ),
      );
    } catch (error) {
      setToast({
        tone: "warning",
        text: error instanceof Error ? error.message : "运行详情加载失败",
      });
    } finally {
      setLoadingRunDetail(false);
    }
  };

  const scheduledTasks =
    platform?.catalog.filter((task) => task.schedulable) || [];
  const enabledSchedules = scheduledTasks.filter((task) => task.enabled).length;
  const failed = jobs.filter((item) => item.lastStatus === "失败").length;
  const defaultTime = editingSchedule
    ? `${String(editingSchedule.hour ?? 0).padStart(2, "0")}:${String(editingSchedule.minute ?? 0).padStart(2, "0")}`
    : "00:00";
  const activeRunFor = (jobId: string) =>
    runs.find(
      (item) =>
        item.collectionJobId === jobId &&
        ["running", "retrying"].includes(item.state),
    );
  const displayedRuns = runView === "attention" ? attentionRuns : runs;
  const scheduledTaskPagination = useClientPagination(scheduledTasks, 10);
  const jobPagination = useClientPagination(jobs, 10);
  const runPagination = useClientPagination(displayedRuns, 10, runView);

  return (
    <>
      <PageHeader
        eyebrow="BACKGROUND TASK PLATFORM"
        title="定时任务"
        description="管理云端系统调度和第三方采集计划；所有时间按北京时间执行，修改后无需重启 Worker。"
        actions={
          <Button
            onClick={() => {
              setEditingJob(null);
              setOpen(true);
            }}
            disabled={!connections.length}
          >
            <Plus size={17} />
            新增采集计划
          </Button>
        }
      />
      <section className="scheduler-summary">
        <div>
          <CalendarClock size={20} />
          <span>
            <strong>{scheduledTasks.length}</strong>
            <small>系统定时任务</small>
          </span>
        </div>
        <div>
          <Activity size={20} />
          <span>
            <strong>{enabledSchedules}</strong>
            <small>已启用调度</small>
          </span>
        </div>
        <div>
          <Clock3 size={20} />
          <span>
            <strong>{platform?.queue.pending ?? 0}</strong>
            <small>队列等待</small>
          </span>
        </div>
        <div>
          <AlertTriangle size={20} />
          <span>
            <strong>{(platform?.queue.permanentlyFailed ?? 0) + failed}</strong>
            <small>失败关注项</small>
          </span>
        </div>
      </section>

      {platform && (
        <Panel
          title="平台定时任务"
          action={
            <StatusDot
              label={`队列 ${platform.queue.running} 运行 / ${platform.queue.pending} 等待`}
              tone={platform.queue.permanentlyFailed ? "danger" : "success"}
            />
          }
        >
          <div className="admin-table background-task-table">
            <div className="admin-table-head">
              <SequenceHeader />
              <span>任务</span>
              <span>类别</span>
              <span>执行计划</span>
              <span>下次执行</span>
              <span>最近投递</span>
              <span>启用</span>
              <span>操作</span>
            </div>
            {scheduledTaskPagination.items.map((task, index) => (
              <div className="admin-table-row" key={task.identifier}>
                <SequenceCell value={(scheduledTaskPagination.page - 1) * scheduledTaskPagination.pageSize + index + 1} />
                <div className="schedule-card-title">
                  <strong>{task.label}</strong>
                  <small>{task.identifier}</small>
                </div>
                <div data-label="类别">
                  <Tag>{task.category}</Tag>
                  <small>{task.role}</small>
                </div>
                <code data-label="执行计划">{task.schedule}</code>
                <span data-label="下次执行">{localTime(task.nextRunAt)}</span>
                <span data-label="最近投递">{localTime(task.lastEnqueuedAt)}</span>
                <div className="schedule-switch-cell" data-label="启用状态">
                  <label className="switch compact">
                    <input
                      type="checkbox"
                      checked={task.enabled}
                      onChange={() => void toggleSchedule(task)}
                    />
                    <span />
                  </label>
                </div>
                <div className="background-task-actions">
                  <button
                    className="text-action"
                    onClick={() => openSchedule(task)}
                  >
                    <Settings2 size={13} />
                    配置
                  </button>
                  <button
                    className="text-action"
                    disabled={running === task.identifier}
                    onClick={() => void runSchedule(task)}
                  >
                    <Play size={13} />
                    {running === task.identifier ? "提交中" : "执行"}
                  </button>
                </div>
              </div>
            ))}
          </div>
          <TablePagination
            page={scheduledTaskPagination.page}
            pageSize={scheduledTaskPagination.pageSize}
            pageSizeOptions={[10, 20, 50]}
            totalPages={scheduledTaskPagination.totalPages}
            total={scheduledTaskPagination.total}
            onPageChange={scheduledTaskPagination.setPage}
            onPageSizeChange={scheduledTaskPagination.setPageSize}
          />
        </Panel>
      )}

      <Panel
        title="第三方数据采集计划"
        action={<Tag>{jobs.filter((item) => item.enabled).length} 个启用</Tag>}
      >
        {jobs.length ? (
          <div className="admin-table schedule-table">
            <div className="admin-table-head">
              <SequenceHeader />
              <span>任务</span>
              <span>连接器</span>
              <span>周期</span>
              <span>状态</span>
              <span>下次运行</span>
              <span>重试</span>
              <span>启用</span>
              <span>操作</span>
            </div>
            {jobPagination.items.map((job, index) => {
              const active = activeRunFor(job.id);
              const queued = pendingRuns[job.id];
              const submitting = running === job.id;
              const busy = submitting || Boolean(active) || Boolean(queued);
              const status = active
                ? runState[active.state]
                : queued
                  ? { label: "排队中", tone: "warning" as const }
                  : {
                      label: job.lastStatus,
                      tone:
                        job.lastStatus === "成功"
                          ? ("success" as const)
                          : job.lastStatus === "失败"
                            ? ("danger" as const)
                            : ("muted" as const),
                    };
              return (
                <div className="admin-table-row" key={job.id}>
                  <SequenceCell value={(jobPagination.page - 1) * jobPagination.pageSize + index + 1} />
                  <div className="schedule-card-title">
                    <strong>{job.name}</strong>
                    <small>{queued || active?.aggregateId || job.id}</small>
                  </div>
                  <div data-label="连接器">
                    <strong>{job.connectionName}</strong>
                    <small>{job.providerType}</small>
                  </div>
                  <code data-label="执行周期">每 {job.intervalMinutes} 分钟</code>
                  <div data-label="运行状态">
                    <StatusDot label={status.label} tone={status.tone} />
                  </div>
                  <span data-label="下次运行">{localTime(job.nextRunAt)}</span>
                  <span data-label="重试">{job.retryLimit} 次</span>
                  <div className="schedule-switch-cell" data-label="启用状态">
                    <label className="switch compact">
                      <input
                        type="checkbox"
                        checked={job.enabled}
                        onChange={() => void toggle(job)}
                      />
                      <span />
                    </label>
                  </div>
                  <div className="background-task-actions">
                    <button
                      className="text-action"
                      onClick={() => {
                        setEditingJob(job);
                        setOpen(true);
                      }}
                    >
                      <Settings2 size={13} />
                      配置
                    </button>
                    <button
                      className="text-action"
                      disabled={busy}
                      onClick={() => void run(job)}
                    >
                      <Play size={13} />
                      {submitting
                        ? "提交中"
                        : active
                          ? runState[active.state].label
                          : queued
                            ? "排队中"
                            : "执行"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="inline-empty">
            <Database size={28} />
            <strong>暂无采集计划</strong>
            <span>先在接口管理中配置第三方数据源，再创建采集任务。</span>
          </div>
        )}
        <TablePagination
          page={jobPagination.page}
          pageSize={jobPagination.pageSize}
          pageSizeOptions={[10, 20, 50]}
          totalPages={jobPagination.totalPages}
          total={jobPagination.total}
          onPageChange={jobPagination.setPage}
          onPageSizeChange={jobPagination.setPageSize}
        />
      </Panel>

      <Panel
        title="任务运行与问题记录"
        action={
          <div className="run-view-actions">
            <button
              className={runView === "recent" ? "run-view-active" : ""}
              onClick={() => setRunView("recent")}
            >
              最近运行
            </button>
            <button
              className={runView === "attention" ? "run-view-active" : ""}
              onClick={() => setRunView("attention")}
            >
              问题记录 {attentionRuns.length ? `(${attentionRuns.length})` : ""}
            </button>
            {platform && (
              <span className="run-metrics">
                近 1 小时成功率{" "}
                {platform.observability.lastHour.successRate === null
                  ? "—"
                  : `${platform.observability.lastHour.successRate}%`}{" "}
                · P95 {duration(platform.observability.lastHour.p95DurationMs)}
              </span>
            )}
          </div>
        }
      >
        {displayedRuns.length ? (
          <div className="admin-table background-run-table">
            <div className="admin-table-head">
              <SequenceHeader />
              <span>任务</span>
              <span>状态</span>
              <span>触发</span>
              <span>尝试</span>
              <span>排队 / 执行</span>
              <span>开始时间</span>
              <span>问题 / 告警</span>
              <span>操作</span>
            </div>
            {runPagination.items.map((item, index) => {
              const issue = runIssue(item);
              const presentation = runPresentation(item);
              return (
                <div className="admin-table-row" key={item.bullmqJobId}>
                  <SequenceCell value={(runPagination.page - 1) * runPagination.pageSize + index + 1} />
                  <div className="schedule-card-title">
                    <strong>{item.taskLabel}</strong>
                    <small>{item.aggregateId || item.bullmqJobId}</small>
                  </div>
                  <div data-label="状态">
                    <StatusDot
                      label={presentation.label}
                      tone={presentation.tone}
                    />
                  </div>
                  <div data-label="触发方式">
                    <Tag
                      tone={item.triggerType === "manual" ? "cyan" : "default"}
                    >
                      {triggerLabel(item.triggerType)}
                    </Tag>
                  </div>
                  <span data-label="尝试次数">
                    {item.attempt}/{item.maxAttempts}
                  </span>
                  <span data-label="排队 / 执行">
                    {duration(item.queueLatencyMs)} /{" "}
                    {duration(item.durationMs)}
                  </span>
                  <span data-label="开始时间">{localTime(item.startedAt)}</span>
                  <span
                    data-label="问题 / 告警"
                    className={
                      item.error
                        ? "run-error"
                        : issue
                          ? "run-notice"
                          : "run-issue-empty"
                    }
                    title={issue}
                  >
                    {issue || "—"}
                  </span>
                  <div className="background-run-actions">
                    <button
                      className="text-action"
                      disabled={loadingRunDetail}
                      onClick={() => void openRunDetail(item)}
                    >
                      <Activity size={13} />
                      详情
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="inline-empty">
            <RefreshCw size={26} />
            <strong>
              {runView === "attention"
                ? "暂无需关注的运行记录"
                : "暂无任务运行记录"}
            </strong>
            <span>
              {runView === "attention"
                ? "当前没有失败或部分成功告警。"
                : "手动或定时任务被 Worker 领取后将在这里展示。"}
            </span>
          </div>
        )}
        <TablePagination
          page={runPagination.page}
          pageSize={runPagination.pageSize}
          pageSizeOptions={[10, 20, 50]}
          totalPages={runPagination.totalPages}
          total={runPagination.total}
          onPageChange={runPagination.setPage}
          onPageSizeChange={runPagination.setPageSize}
        />
      </Panel>

      <Modal
        open={Boolean(runDetail)}
        title={runDetail ? `运行详情 · ${runDetail.taskLabel}` : "运行详情"}
        onClose={() => setRunDetail(null)}
        footer={
          <Button variant="ghost" onClick={() => setRunDetail(null)}>
            关闭
          </Button>
        }
      >
        {runDetail && (
          <div className="background-run-detail">
            <dl>
              <div>
                <dt>BullMQ Job ID</dt>
                <dd>{runDetail.bullmqJobId}</dd>
              </div>
              <div>
                <dt>业务运行 ID</dt>
                <dd>{runDetail.aggregateId || "—"}</dd>
              </div>
              <div>
                <dt>队列 / Worker</dt>
                <dd>
                  {runDetail.queueRole} · {runDetail.workerInstanceId || "—"}
                </dd>
              </div>
              <div>
                <dt>总体状态</dt>
                <dd>
                  <StatusDot
                    label={runPresentation(runDetail).label}
                    tone={runPresentation(runDetail).tone}
                  />
                </dd>
              </div>
            </dl>
            {runIssue(runDetail) && (
              <section
                className={`run-problem-detail ${runDetail.error ? "run-problem-detail-error" : "run-problem-detail-notice"}`}
              >
                <h3>{runDetail.error ? "错误定位" : "部分发布告警"}</h3>
                <strong>功能：{runDetail.taskLabel}</strong>
                <strong>位置：{issueLocation(runDetail)}</strong>
                <span>问题：{runIssue(runDetail)}</span>
                <small>
                  处理结果：
                  {runDetail.error
                    ? "本次任务未完成，请修复问题后重新执行。"
                    : "异常对象未使用新版本数据，其他正常内容已完成发布；修复后重新发布即可更新该对象。"}
                </small>
              </section>
            )}
            <section>
              <h3>执行时间线</h3>
              <div className="run-attempts">
                {runDetail.attempts.map((attempt) => (
                  <article
                    key={attempt.id}
                    className={`run-attempt run-attempt-${attempt.state}`}
                  >
                    <span>{attempt.attempt}</span>
                    <div>
                      <header>
                        <strong>
                          第 {attempt.attempt}/{attempt.maxAttempts} 次尝试
                        </strong>
                        <StatusDot
                          label={runPresentation(attempt).label}
                          tone={runPresentation(attempt).tone}
                        />
                      </header>
                      <p>
                        排队 {duration(attempt.queueLatencyMs)} · 执行{" "}
                        {duration(attempt.durationMs)} ·{" "}
                        {localTime(attempt.startedAt)}
                      </p>
                      {attempt.noticeMessage && (
                        <div className="attempt-notice">
                          <strong>部分发布告警</strong>
                          <span>{attempt.noticeMessage}</span>
                        </div>
                      )}
                      {attempt.error && (
                        <div className="attempt-error">
                          <strong>{attempt.error.message}</strong>
                          {attempt.willRetry && (
                            <small>
                              将于 {localTime(attempt.nextRetryAt)} 自动重试
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(editingSchedule)}
        title={
          editingSchedule
            ? `配置执行时间 · ${editingSchedule.label}`
            : "配置执行时间"
        }
        onClose={() => setEditingSchedule(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingSchedule(null)}>
              取消
            </Button>
            <Button
              type="submit"
              form="background-schedule-form"
              disabled={savingSchedule}
            >
              {savingSchedule ? "保存中..." : "保存并生效"}
            </Button>
          </>
        }
      >
        {editingSchedule && (
          <form
            key={editingSchedule.identifier}
            id="background-schedule-form"
            className="admin-form"
            onSubmit={saveSchedule}
          >
            <label>
              调度方式
              <select
                name="scheduleType"
                value={scheduleType}
                onChange={(event) =>
                  setScheduleType(event.target.value as ScheduleType)
                }
              >
                <option value="interval">固定间隔</option>
                <option value="daily">每天定时</option>
                <option value="weekly">每周定时</option>
              </select>
            </label>
            {scheduleType === "interval" ? (
              <label>
                执行间隔（分钟）
                <input
                  name="intervalMinutes"
                  type="number"
                  min="1"
                  max="10080"
                  required
                  defaultValue={editingSchedule.intervalMinutes ?? 60}
                />
              </label>
            ) : (
              <div className="form-grid">
                {scheduleType === "weekly" && (
                  <label>
                    执行日
                    <select
                      name="dayOfWeek"
                      defaultValue={editingSchedule.dayOfWeek ?? 0}
                    >
                      <option value="1">星期一</option>
                      <option value="2">星期二</option>
                      <option value="3">星期三</option>
                      <option value="4">星期四</option>
                      <option value="5">星期五</option>
                      <option value="6">星期六</option>
                      <option value="0">星期日</option>
                    </select>
                  </label>
                )}
                <label>
                  执行时间（北京时间）
                  <input
                    name="time"
                    type="time"
                    required
                    defaultValue={defaultTime}
                  />
                </label>
              </div>
            )}
            <label className="switch">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={editingSchedule.enabled}
              />
              <span />
              <em>启用该定时任务</em>
            </label>
            <p className="form-help">
              保存后重新计算下次执行时间，并在下一次调度心跳中生效；“立即执行”不改变后续计划。
            </p>
          </form>
        )}
      </Modal>

      <Modal
        open={open}
        title={
          editingJob ? `配置采集计划 · ${editingJob.name}` : "新增定时采集任务"
        }
        onClose={() => {
          setOpen(false);
          setEditingJob(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setEditingJob(null);
              }}
            >
              取消
            </Button>
            <Button type="submit" form="schedule-form">
              {editingJob ? "保存并生效" : "创建任务"}
            </Button>
          </>
        }
      >
        <form
          key={editingJob?.id || "new"}
          id="schedule-form"
          className="admin-form"
          onSubmit={save}
        >
          <label>
            任务名称
            <input
              name="name"
              required
              defaultValue={editingJob?.name || ""}
              placeholder="例如：Hunter 每小时资产增量采集"
            />
          </label>
          <label>
            数据连接器
            <select
              name="connectionId"
              required
              defaultValue={editingJob?.connectionId || ""}
              disabled={Boolean(editingJob)}
            >
              {connections
                .filter(
                  (item) =>
                    item.enabled || item.id === editingJob?.connectionId,
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.providerName}
                  </option>
                ))}
            </select>
          </label>
          <div className="form-grid">
            <label>
              执行周期（分钟）
              <input
                name="intervalMinutes"
                type="number"
                min="5"
                max="10080"
                defaultValue={editingJob?.intervalMinutes ?? 60}
              />
            </label>
            <label>
              超时（秒）
              <input
                name="timeoutSeconds"
                type="number"
                min="5"
                max="600"
                defaultValue={editingJob?.timeoutSeconds ?? 60}
              />
            </label>
          </div>
          <label>
            失败重试次数
            <input
              name="retryLimit"
              type="number"
              min="0"
              max="10"
              defaultValue={editingJob?.retryLimit ?? 2}
            />
          </label>
          <label className="switch">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={editingJob?.enabled ?? false}
            />
            <span />
            <em>启用该采集计划</em>
          </label>
          <p className="form-help">
            保存后按新周期重新计算执行计划；手动执行仍会写入运行记录，但不会改变后续时间。
          </p>
        </form>
      </Modal>
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
