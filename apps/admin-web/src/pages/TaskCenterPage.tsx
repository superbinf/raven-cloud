import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Clock3,
  ListTodo,
  Play,
  RefreshCw,
  Workflow,
} from "lucide-react";
import {
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
import { useAdminInitialLoading } from "../app/AdminInitialLoading";
import { adminApiFetch as apiFetch } from "../shared/api/adminApi";

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

export function TaskCenterPage() {
  const [platform, setPlatform] = useState<BackgroundTaskOverview | null>(null);
  const [jobs, setJobs] = useState<CollectionJob[]>([]);
  const [runs, setRuns] = useState<BackgroundRun[]>([]);
  const [attentionRuns, setAttentionRuns] = useState<BackgroundRun[]>([]);
  const [runView, setRunView] = useState<"recent" | "attention">("recent");
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
      apiFetch<{ items: BackgroundRun[] }>("/api/background-runs?limit=30"),
      apiFetch<{ items: BackgroundRun[] }>(
        "/api/background-runs?attention=true&limit=30",
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
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load().catch(() => undefined);
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
  const displayedRuns = runView === "attention" ? attentionRuns : runs;
  const catalogPagination = useClientPagination(platform?.catalog || [], 10);
  const jobPagination = useClientPagination(jobs, 10);
  const runPagination = useClientPagination(displayedRuns, 10, runView);
  const activeCount =
    platform?.queue.running ??
    runs.filter((item) => ["running", "retrying"].includes(item.state)).length;
  const attentionCount = attentionRuns.length;

  return (
    <>
      <PageHeader
        eyebrow="TASK OPERATIONS CENTER"
        title="任务中心"
        description="统一查看云端任务目录、执行状态和问题记录；调度周期与启停配置请前往定时任务。"
        actions={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={17} />
            刷新状态
          </Button>
        }
      />

      <section className="scheduler-summary">
        <div>
          <ListTodo size={20} />
          <span>
            <strong>{(platform?.catalog.length ?? 0) + jobs.length}</strong>
            <small>任务总数</small>
          </span>
        </div>
        <div>
          <Activity size={20} />
          <span>
            <strong>{activeCount}</strong>
            <small>正在执行</small>
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
            <strong>{attentionCount}</strong>
            <small>问题记录</small>
          </span>
        </div>
      </section>

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
                      >
                        <Play size={13} />
                        {running === task.identifier ? "提交中" : "执行"}
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
                    >
                      <Play size={13} />
                      {submitting
                        ? "提交中"
                        : active
                          ? runPresentation(active).label
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
            <ListTodo size={26} />
            <strong>暂无第三方数据采集任务</strong>
            <span>在定时任务中创建采集计划后，将在这里统一执行和观测。</span>
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
                  <SequenceCell
                    value={
                      (runPagination.page - 1) * runPagination.pageSize +
                      index +
                      1
                    }
                  />
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
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
