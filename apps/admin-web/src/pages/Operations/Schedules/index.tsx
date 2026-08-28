import { useEffect, useState, type FormEvent } from "react";

import {
  Activity,
  CalendarClock,
  Clock3,
  Database,
  Plus,
  Settings2,
} from "lucide-react";
import {
  type ApiConnection,
  type CollectionJob,
} from "@sentinel/shared";
import { Button, Modal, Panel, Tag } from "@/components/ui";
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
import { adminApiFetch as apiFetch } from "@/api/admin";
import { useAdminInitialLoading } from "@/hooks/useAdminInitialLoading";

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
  const [open, setOpen] = useState(false);
  const [editingJob, setEditingJob] = useState<CollectionJob | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<BackgroundTask | null>(
    null,
  );
  const [scheduleType, setScheduleType] = useState<ScheduleType>("interval");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  useAdminInitialLoading("schedules", initialLoading);

  const load = () =>
    Promise.all([
      apiFetch<CollectionJob[]>("/api/collection-jobs"),
      apiFetch<ApiConnection[]>("/api/connections"),
      apiFetch<BackgroundTaskOverview>("/api/background-tasks"),
    ]).then(
      ([jobItems, connectionItems, overview]) => {
        setJobs(jobItems);
        setConnections(connectionItems);
        setPlatform(overview);
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
      ])
        .then(([jobItems, overview]) => {
          setJobs(jobItems);
          setPlatform(overview);
        })
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, []);

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

  const scheduledTasks =
    platform?.catalog.filter((task) => task.schedulable) || [];
  const enabledSchedules = scheduledTasks.filter((task) => task.enabled).length;
  const enabledJobs = jobs.filter((item) => item.enabled).length;
  const defaultTime = editingSchedule
    ? `${String(editingSchedule.hour ?? 0).padStart(2, "0")}:${String(editingSchedule.minute ?? 0).padStart(2, "0")}`
    : "00:00";
  const scheduledTaskPagination = useClientPagination(scheduledTasks, 10);
  const jobPagination = useClientPagination(jobs, 10);

  return (
    <>
      <PageHeader
        eyebrow="BACKGROUND TASK PLATFORM"
        title="调度计划"
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
            <small>系统调度任务</small>
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
          <Database size={20} />
          <span>
            <strong>{jobs.length}</strong>
            <small>采集计划</small>
          </span>
        </div>
        <div>
          <Clock3 size={20} />
          <span>
            <strong>{enabledJobs}</strong>
            <small>已启用采集</small>
          </span>
        </div>
      </section>

      {platform && (
        <Panel
          title="平台调度任务"
          action={<Tag>{enabledSchedules} 个启用</Tag>}
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
              <span>下次运行</span>
              <span>重试</span>
              <span>启用</span>
              <span>操作</span>
            </div>
            {jobPagination.items.map((job, index) => {
              return (
                <div className="admin-table-row" key={job.id}>
                  <SequenceCell value={(jobPagination.page - 1) * jobPagination.pageSize + index + 1} />
                  <div className="schedule-card-title">
                    <strong>{job.name}</strong>
                    <small>{job.id}</small>
                  </div>
                  <div data-label="连接器">
                    <strong>{job.connectionName}</strong>
                    <small>{job.providerType}</small>
                  </div>
                  <code data-label="执行周期">每 {job.intervalMinutes} 分钟</code>
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
              <em>启用该调度任务</em>
            </label>
            <p className="form-help">
              保存后重新计算下次执行时间，并在下一次调度心跳中生效；手动执行请前往任务中心。
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
            保存后按新周期重新计算执行计划；执行任务与查看运行记录请前往任务中心。
          </p>
        </form>
      </Modal>
      <Toast value={toast} onClose={() => setToast(null)} />
    </>
  );
}
