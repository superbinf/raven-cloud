import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Copy,
  ListTodo,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Workflow,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  type BackgroundRun,
  type BackgroundRunDetail,
  type BackgroundRunState,
  type CollectionJob,
} from "@sentinel/shared";
import { Button, Modal, Panel, StatusDot, Tag } from "@/components/ui";
import {
  PageHeader,
  SequenceCell,
  SequenceHeader,
  Toast,
  type ToastState,
} from "@/components/business/AdminPrimitives";
import {
  TablePagination,
  useClientPagination,
} from "@/components/business/TablePagination";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";
import { useCustomerScope } from "@/layouts";
import { adminApiFetch as apiFetch } from "@/api/admin";

type BackgroundTask = {
  identifier: string;
  taskIdentifier?: string;
  label: string;
  role: string;
  category: string;
  schedulable: boolean;
  enabled: boolean;
  schedule: string;
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

function waitingDuration(value?: number | null) {
  if (value === null || value === undefined || value <= 0) return "暂无等待";
  if (value < 60_000) return `最久 ${Math.max(1, Math.round(value / 1_000))} 秒`;
  if (value < 3_600_000) return `最久 ${Math.round(value / 60_000)} 分钟`;
  return `最久 ${(value / 3_600_000).toFixed(1)} 小时`;
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

function catalogRunIdentifier(task: BackgroundTask) {
  return task.taskIdentifier || task.identifier;
}

type TaskCenterView = "attention" | "active" | "all" | "definitions";
type DefinitionView = "platform" | "collection";
type RunStateFilter =
  | "all"
  | "running"
  | "retrying"
  | "failed"
  | "partial"
  | "succeeded";

const viewLabels: Record<Exclude<TaskCenterView, "definitions">, string> = {
  attention: "需关注",
  active: "运行中",
  all: "全部运行",
};

export function TaskCenterPage() {
  const { tenantId } = useCustomerScope();
  const [platform, setPlatform] = useState<BackgroundTaskOverview | null>(null);
  const [jobs, setJobs] = useState<CollectionJob[]>([]);
  const [runs, setRuns] = useState<BackgroundRun[]>([]);
  const [attentionRuns, setAttentionRuns] = useState<BackgroundRun[]>([]);
  const [runView, setRunView] = useState<TaskCenterView>("attention");
  const [definitionView, setDefinitionView] =
    useState<DefinitionView>("platform");
  const [runSearch, setRunSearch] = useState("");
  const [stateFilter, setStateFilter] = useState<RunStateFilter>("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [triggerFilter, setTriggerFilter] = useState("all");
  const [runDetail, setRunDetail] = useState<BackgroundRunDetail | null>(null);
  const [loadingRunDetail, setLoadingRunDetail] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [pendingRuns, setPendingRuns] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<ToastState>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  useAdminInitialLoading("task-center", initialLoading);

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
      apiFetch<BackgroundTaskOverview>("/api/background-tasks"),
      apiFetch<CollectionJob[]>("/api/collection-jobs"),
      apiFetch<{ items: BackgroundRun[] }>(
        `/api/background-runs?tenant_id=${encodeURIComponent(tenantId)}&limit=30`,
      ),
      apiFetch<{ items: BackgroundRun[] }>(
        `/api/background-runs?tenant_id=${encodeURIComponent(tenantId)}&attention=true&limit=30`,
      ),
    ]).then(([overview, jobItems, runItems, attentionItems]) => {
      setPlatform(overview);
      setJobs(jobItems);
      applyRuns(runItems.items, attentionItems.items);
    });

  useEffect(() => {
    load()
      .catch((error) =>
        setToast({
          tone: "warning",
          text: error instanceof Error ? error.message : "任务中心加载失败",
        }),
      )
      .finally(() => setInitialLoading(false));
  }, [tenantId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load().catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [tenantId]);

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

  const runScheduledTask = async (task: BackgroundTask) => {
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

  const runCollectionJob = async (job: CollectionJob) => {
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

  const latestRunForTask = (task: BackgroundTask) =>
    runs.find(
      (item) => item.taskIdentifier === catalogRunIdentifier(task),
    ) || null;
  const activeRunForJob = (jobId: string) =>
    runs.find(
      (item) =>
        item.collectionJobId === jobId &&
        ["running", "retrying"].includes(item.state),
    );
  const latestRunForJob = (jobId: string) =>
    runs.find((item) => item.collectionJobId === jobId) || null;
  const activeRuns = useMemo(
    () =>
      runs.filter((item) =>
        ["running", "retrying"].includes(item.state),
      ),
    [runs],
  );
  const baseDisplayedRuns =
    runView === "attention"
      ? attentionRuns
      : runView === "active"
        ? activeRuns
        : runs;
  const displayedRuns = useMemo(() => {
    const keyword = runSearch.trim().toLocaleLowerCase("zh-CN");
    return baseDisplayedRuns.filter((item) => {
      const isPartial =
        item.state === "succeeded" && Boolean(item.noticeMessage);
      const matchesState =
        stateFilter === "all" ||
        (stateFilter === "partial"
          ? isPartial
          : stateFilter === "succeeded"
            ? item.state === "succeeded" && !isPartial
            : item.state === stateFilter);
      const matchesRole =
        roleFilter === "all" || item.queueRole === roleFilter;
      const matchesTrigger =
        triggerFilter === "all" || item.triggerType === triggerFilter;
      const matchesSearch =
        !keyword ||
        [
          item.taskLabel,
          item.taskIdentifier,
          item.aggregateId,
          item.bullmqJobId,
          item.connectionName,
          runIssue(item),
        ].some((value) => value?.toLocaleLowerCase("zh-CN").includes(keyword));
      return matchesState && matchesRole && matchesTrigger && matchesSearch;
    });
  }, [
    baseDisplayedRuns,
    roleFilter,
    runSearch,
    stateFilter,
    triggerFilter,
  ]);
  const catalogPagination = useClientPagination(platform?.catalog || [], 10);
  const jobPagination = useClientPagination(jobs, 10);
  const runPagination = useClientPagination(
    displayedRuns,
    10,
    `${runView}:${runSearch}:${stateFilter}:${roleFilter}:${triggerFilter}`,
  );
  const activeCount =
    platform?.queue.running ??
    activeRuns.length;
  const attentionCount = attentionRuns.length;
  const hourMetrics = platform?.observability.lastHour;
  const detailCollectionJob = runDetail?.collectionJobId
    ? jobs.find((job) => job.id === runDetail.collectionJobId) || null
    : null;
  const detailScheduledTask = runDetail
    ? platform?.catalog.find(
        (task) =>
          task.schedulable &&
          catalogRunIdentifier(task) === runDetail.taskIdentifier,
      ) || null
    : null;
  const canRerunDetail =
    Boolean(runDetail) &&
    !["running", "retrying"].includes(runDetail?.state || "") &&
    Boolean(detailCollectionJob || detailScheduledTask);

  const changeRunView = (view: TaskCenterView) => {
    setRunView(view);
    setStateFilter("all");
  };

  const resetRunFilters = () => {
    setRunSearch("");
    setStateFilter("all");
    setRoleFilter("all");
    setTriggerFilter("all");
  };

  const copyRunDiagnosis = async () => {
    if (!runDetail) return;
    const text = [
      `任务：${runDetail.taskLabel}`,
      `状态：${runPresentation(runDetail).label}`,
      `业务运行 ID：${runDetail.aggregateId || "—"}`,
      `BullMQ Job ID：${runDetail.bullmqJobId}`,
      `位置：${issueLocation(runDetail)}`,
      `问题：${runIssue(runDetail) || "无"}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setToast({ tone: "success", text: "诊断信息已复制" });
    } catch {
      setToast({ tone: "warning", text: "复制失败，请手动选择诊断信息" });
    }
  };

  const rerunCurrentDetail = async () => {
    if (!runDetail || !canRerunDetail) return;
    if (
      !window.confirm(
        `确认重新执行“${runDetail.taskLabel}”？请先确认当前异常已处理，重复执行可能再次调用外部接口。`,
      )
    )
      return;
    if (detailCollectionJob) await runCollectionJob(detailCollectionJob);
    else if (detailScheduledTask)
      await runScheduledTask(detailScheduledTask);
    setRunDetail(null);
  };

  return (
    <>
      <PageHeader
        eyebrow="TASK OPERATIONS CENTER"
        title="任务中心"
        description="优先处理失败、重试和运行异常；调度周期与启停配置请前往调度计划。"
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={17} />
            刷新状态
          </Button>
        }
      />

      <section className="task-center-summary" aria-label="任务运行概览">
        <button
          type="button"
          className={runView === "attention" ? "is-active is-danger" : ""}
          onClick={() => changeRunView("attention")}
          aria-pressed={runView === "attention"}
        >
          <AlertTriangle size={20} />
          <span>
            <strong>{attentionCount}</strong>
            <small>最近需关注</small>
            <em>失败或部分成功记录</em>
          </span>
        </button>
        <button
          type="button"
          className={runView === "active" ? "is-active" : ""}
          onClick={() => changeRunView("active")}
          aria-pressed={runView === "active"}
        >
          <Activity size={20} />
          <span>
            <strong>{activeCount}</strong>
            <small>正在执行</small>
            <em>包含自动重试</em>
          </span>
        </button>
        <div>
          <Clock3 size={20} />
          <span>
            <strong>{platform?.queue.pending ?? 0}</strong>
            <small>队列等待</small>
            <em>{waitingDuration(platform?.queue.oldestWaitingMs)}</em>
          </span>
        </div>
        <button
          type="button"
          className={runView === "all" ? "is-active is-success" : "is-success"}
          onClick={() => changeRunView("all")}
          aria-pressed={runView === "all"}
        >
          <CheckCircle2 size={20} />
          <span>
            <strong>
              {hourMetrics?.successRate === null ||
              hourMetrics?.successRate === undefined
                ? "—"
                : `${hourMetrics.successRate}%`}
            </strong>
            <small>近 1 小时成功率</small>
            <em>{hourMetrics?.jobs ?? 0} 次运行 · P95 {duration(hourMetrics?.p95DurationMs)}</em>
          </span>
        </button>
      </section>

      <nav
        className="task-center-primary-tabs"
        role="tablist"
        aria-label="任务中心视图"
      >
        <button
          type="button"
          role="tab"
          aria-selected={runView === "attention"}
          aria-controls="task-center-run-workspace"
          className={runView === "attention" ? "is-active" : ""}
          onClick={() => changeRunView("attention")}
        >
          需关注
          {attentionCount > 0 && <span>{attentionCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={runView === "active"}
          aria-controls="task-center-run-workspace"
          className={runView === "active" ? "is-active" : ""}
          onClick={() => changeRunView("active")}
        >
          运行中
          {activeCount > 0 && <span>{activeCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={runView === "all"}
          aria-controls="task-center-run-workspace"
          className={runView === "all" ? "is-active" : ""}
          onClick={() => changeRunView("all")}
        >
          全部运行
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={runView === "definitions"}
          aria-controls="task-center-definition-workspace"
          className={runView === "definitions" ? "is-active" : ""}
          onClick={() => changeRunView("definitions")}
        >
          任务定义
          <span>{(platform?.catalog.length ?? 0) + jobs.length}</span>
        </button>
      </nav>

      {runView === "definitions" && (
        <section
          id="task-center-definition-workspace"
          className="task-definition-switcher"
          role="tabpanel"
          aria-label="任务定义"
        >
          <div>
            <strong>任务定义</strong>
            <span>在这里查看可执行任务；周期、启停和下次运行时间仍在调度计划中配置。</span>
          </div>
          <div className="run-view-actions" role="tablist" aria-label="任务定义类型">
            <button
              type="button"
              role="tab"
              aria-selected={definitionView === "platform"}
              className={definitionView === "platform" ? "run-view-active" : ""}
              onClick={() => setDefinitionView("platform")}
            >
              平台任务 {platform?.catalog.length ?? 0}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={definitionView === "collection"}
              className={
                definitionView === "collection" ? "run-view-active" : ""
              }
              onClick={() => setDefinitionView("collection")}
            >
              采集任务 {jobs.length}
            </button>
          </div>
        </section>
      )}

      {runView === "definitions" && definitionView === "platform" && (
      <Panel
        title="平台任务目录"
        action={
          platform && (
            <StatusDot
              label={`队列 ${platform.queue.running} 运行 / ${platform.queue.pending} 等待`}
              tone={platform.queue.permanentlyFailed ? "danger" : "success"}
            />
          )
        }
      >
        {platform?.catalog.length ? (
          <div className="admin-table task-center-table">
            <div className="admin-table-head">
              <SequenceHeader />
              <span>任务</span>
              <span>类别 / 队列</span>
              <span>触发方式</span>
              <span>最近状态</span>
              <span>最近运行</span>
              <span>操作</span>
            </div>
            {catalogPagination.items.map((task, index) => {
              const latest = latestRunForTask(task);
              const presentation = latest ? runPresentation(latest) : null;
              return (
                <div className="admin-table-row" key={task.identifier}>
                  <SequenceCell
                    value={
                      (catalogPagination.page - 1) *
                        catalogPagination.pageSize +
                      index +
                      1
                    }
                  />
                  <div className="schedule-card-title">
                    <strong>{task.label}</strong>
                    <small>{catalogRunIdentifier(task)}</small>
                  </div>
                  <div data-label="类别 / 队列">
                    <Tag>{task.category}</Tag>
                    <small>{task.role}</small>
                  </div>
                  <div data-label="触发方式">
                    <Tag tone={task.schedulable ? "cyan" : "default"}>
                      {task.schedulable ? task.schedule : "业务触发"}
                    </Tag>
                  </div>
                  <div data-label="最近状态">
                    {presentation ? (
                      <StatusDot
                        label={presentation.label}
                        tone={presentation.tone}
                      />
                    ) : (
                      <StatusDot label="暂无记录" tone="muted" />
                    )}
                  </div>
                  <span data-label="最近运行">
                    {localTime(latest?.startedAt || task.lastEnqueuedAt)}
                  </span>
                  <div className="background-task-actions">
                    {task.schedulable ? (
                      <button
                        className="text-action"
                        disabled={running === task.identifier}
                        onClick={() => void runScheduledTask(task)}
                        aria-label={`立即运行${task.label}`}
                      >
                        <Play size={13} />
                        {running === task.identifier ? "提交中" : "立即运行"}
                      </button>
                    ) : (
                      <span className="task-trigger-note">
                        <Workflow size={13} />
                        由业务触发
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="inline-empty">
            <RefreshCw className="is-spinning" size={26} />
            <strong>正在加载任务目录</strong>
          </div>
        )}
        <TablePagination
          page={catalogPagination.page}
          pageSize={catalogPagination.pageSize}
          pageSizeOptions={[10, 20, 50]}
          totalPages={catalogPagination.totalPages}
          total={catalogPagination.total}
          onPageChange={catalogPagination.setPage}
          onPageSizeChange={catalogPagination.setPageSize}
        />
      </Panel>
      )}

      {runView === "definitions" && definitionView === "collection" && (
      <Panel
        title="第三方数据采集任务"
        action={<Tag>{jobs.length} 个任务</Tag>}
      >
        {jobs.length ? (
          <div className="admin-table collection-task-table">
            <div className="admin-table-head">
              <SequenceHeader />
              <span>任务</span>
              <span>连接器</span>
              <span>运行状态</span>
              <span>最近运行</span>
              <span>操作</span>
            </div>
            {jobPagination.items.map((job, index) => {
              const active = activeRunForJob(job.id);
              const latest = active || latestRunForJob(job.id);
              const queued = pendingRuns[job.id];
              const submitting = running === job.id;
              const presentation = latest ? runPresentation(latest) : null;
              return (
                <div className="admin-table-row" key={job.id}>
                  <SequenceCell
                    value={
                      (jobPagination.page - 1) * jobPagination.pageSize +
                      index +
                      1
                    }
                  />
                  <div className="schedule-card-title">
                    <strong>{job.name}</strong>
                    <small>{queued || latest?.aggregateId || job.id}</small>
                  </div>
                  <div data-label="连接器">
                    <strong>{job.connectionName}</strong>
                    <small>{job.providerType}</small>
                  </div>
                  <div data-label="运行状态">
                    {queued && !active ? (
                      <StatusDot label="排队中" tone="warning" />
                    ) : presentation ? (
                      <StatusDot
                        label={presentation.label}
                        tone={presentation.tone}
                      />
                    ) : (
                      <StatusDot
                        label={job.lastStatus || "暂无记录"}
                        tone={
                          job.lastStatus === "失败"
                            ? "danger"
                            : job.lastStatus === "成功"
                              ? "success"
                              : "muted"
                        }
                      />
                    )}
                  </div>
                  <span data-label="最近运行">
                    {localTime(latest?.startedAt || job.lastRunAt)}
                  </span>
                  <div className="background-task-actions">
                    <button
                      className="text-action"
                      disabled={submitting || Boolean(active) || Boolean(queued)}
                      onClick={() => void runCollectionJob(job)}
                      aria-label={`立即运行${job.name}`}
                    >
                      <Play size={13} />
                      {submitting
                        ? "提交中"
                        : active
                          ? runPresentation(active).label
                          : queued
                            ? "排队中"
                            : "立即运行"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="inline-empty">
            <ListTodo size={26} />
            <strong>暂无第三方数据采集任务</strong>
            <span>在调度计划中创建采集计划后，将在这里统一执行和观测。</span>
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
      )}

      {runView !== "definitions" && (
      <Panel
        id="task-center-run-workspace"
        role="tabpanel"
        title={`${viewLabels[runView]}任务`}
        action={
          <span className="run-metrics">
            当前展示 {displayedRuns.length} / {baseDisplayedRuns.length} 条
          </span>
        }
      >
        <div className="task-center-toolbar">
          <label className="task-center-search">
            <Search size={15} />
            <span className="sr-only">搜索任务或运行 ID</span>
            <input
              type="search"
              value={runSearch}
              onChange={(event) => setRunSearch(event.target.value)}
              placeholder="搜索任务、运行 ID 或异常信息"
            />
          </label>
          <select
            value={stateFilter}
            onChange={(event) =>
              setStateFilter(event.target.value as RunStateFilter)
            }
            aria-label="筛选运行状态"
          >
            <option value="all">全部状态</option>
            <option value="failed">最终失败</option>
            <option value="partial">部分成功</option>
            <option value="running">运行中</option>
            <option value="retrying">重试中</option>
            <option value="succeeded">成功</option>
          </select>
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
            aria-label="筛选任务队列"
          >
            <option value="all">全部队列</option>
            <option value="scheduler">调度</option>
            <option value="snapshot">快照</option>
            <option value="io">外部 I/O</option>
            <option value="maintenance">维护</option>
          </select>
          <select
            value={triggerFilter}
            onChange={(event) => setTriggerFilter(event.target.value)}
            aria-label="筛选触发方式"
          >
            <option value="all">全部触发</option>
            <option value="manual">手动</option>
            <option value="schedule">定时</option>
            <option value="recovery">恢复</option>
            <option value="queue">队列</option>
          </select>
          <Button
            variant="ghost"
            onClick={resetRunFilters}
            disabled={
              !runSearch &&
              stateFilter === "all" &&
              roleFilter === "all" &&
              triggerFilter === "all"
            }
          >
            <RotateCcw size={14} />
            重置
          </Button>
        </div>
        {displayedRuns.length ? (
          <div className="admin-table background-run-table">
            <div className="admin-table-head">
              <span>任务</span>
              <span>状态</span>
              <span>触发</span>
              <span>尝试</span>
              <span>排队 / 执行</span>
              <span>开始时间</span>
              <span>问题 / 告警</span>
              <span>操作</span>
            </div>
            {runPagination.items.map((item) => {
              const issue = runIssue(item);
              const presentation = runPresentation(item);
              return (
                <div className="admin-table-row" key={item.bullmqJobId}>
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
                    {duration(item.queueLatencyMs)} / {duration(item.durationMs)}
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
                      aria-label={`查看${item.taskLabel}运行详情`}
                    >
                      <Activity size={13} />
                      查看
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="inline-empty">
            {runSearch ||
            stateFilter !== "all" ||
            roleFilter !== "all" ||
            triggerFilter !== "all" ? (
              <Search size={26} />
            ) : (
              <RefreshCw size={26} />
            )}
            <strong>
              {runSearch ||
              stateFilter !== "all" ||
              roleFilter !== "all" ||
              triggerFilter !== "all"
                ? "没有符合筛选条件的任务"
                : runView === "attention"
                  ? "暂无需关注的运行记录"
                  : runView === "active"
                    ? "当前没有正在执行的任务"
                    : "暂无任务运行记录"}
            </strong>
            <span>
              {runSearch ||
              stateFilter !== "all" ||
              roleFilter !== "all" ||
              triggerFilter !== "all"
                ? "请调整搜索词或重置筛选条件。"
                : runView === "attention"
                  ? "当前没有失败或部分成功告警。"
                  : runView === "active"
                    ? "新任务被 Worker 领取后会自动出现在这里。"
                    : "手动或调度任务被 Worker 领取后将在这里展示。"}
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
      )}

      <Modal
        open={Boolean(runDetail)}
        title={runDetail ? `运行详情 · ${runDetail.taskLabel}` : "运行详情"}
        onClose={() => setRunDetail(null)}
        className="task-run-drawer"
        footer={
          <>
            <Button variant="ghost" onClick={() => void copyRunDiagnosis()}>
              <Copy size={15} />
              复制诊断
            </Button>
            {runDetail?.collectionJobId && (
              <Link
                className="button button-secondary"
                to="/admin/customer-operations/interfaces"
                onClick={() => setRunDetail(null)}
              >
                <Settings2 size={15} />
                数据源接口
              </Link>
            )}
            <Link
              className="button button-secondary"
              to="/admin/operations/schedules"
              onClick={() => setRunDetail(null)}
            >
              <Clock3 size={15} />
              调度计划
            </Link>
            <Button
              onClick={() => void rerunCurrentDetail()}
              disabled={!canRerunDetail || Boolean(running)}
              title={
                canRerunDetail
                  ? "重新提交该任务"
                  : "该任务只能由业务流程触发"
              }
            >
              <Play size={15} />
              {running ? "提交中" : "重新执行"}
            </Button>
          </>
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
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
