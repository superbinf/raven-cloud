const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const SCHEDULE_TYPES = new Set(["interval", "daily", "weekly"]);
const SCHEDULER_TIMEZONE = "Asia/Shanghai";

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw httpError(400, `${label}必须是 ${minimum}-${maximum} 的整数`);
  return parsed;
}

function dto(row) {
  return row && {
    identifier: row.identifier,
    taskIdentifier: row.task_identifier,
    label: row.label,
    role: row.role,
    category: row.category,
    enabled: Boolean(row.enabled),
    scheduleType: row.schedule_type,
    intervalMinutes: row.interval_minutes === null ? null : Number(row.interval_minutes),
    hour: row.hour === null ? null : Number(row.hour),
    minute: Number(row.minute),
    dayOfWeek: row.day_of_week === null ? null : Number(row.day_of_week),
    nextRunAt: row.next_run_at,
    lastEnqueuedAt: row.last_enqueued_at,
    updatedAt: row.updated_at
  };
}

export function normalizeSchedule(input) {
  const scheduleType = String(input.scheduleType || "");
  if (!SCHEDULE_TYPES.has(scheduleType)) throw httpError(400, "不支持的调度类型");
  if (scheduleType === "interval") {
    return { scheduleType, intervalMinutes: integer(input.intervalMinutes, "执行间隔", 1, 10080), hour: null, minute: 0, dayOfWeek: null };
  }
  const hour = integer(input.hour, "小时", 0, 23);
  const minute = integer(input.minute, "分钟", 0, 59);
  return { scheduleType, intervalMinutes: null, hour, minute, dayOfWeek: scheduleType === "weekly" ? integer(input.dayOfWeek, "星期", 0, 6) : null };
}

export function nextRunAt(schedule, from = new Date(), previousDue = null) {
  const now = from.getTime();
  if (schedule.scheduleType === "interval") {
    const intervalMs = Number(schedule.intervalMinutes) * 60_000;
    let next = previousDue ? new Date(previousDue).getTime() + intervalMs : now + intervalMs;
    if (!Number.isFinite(next)) next = now + intervalMs;
    if (next <= now) next += Math.ceil((now - next + 1) / intervalMs) * intervalMs;
    return new Date(next).toISOString();
  }

  const local = new Date(now + BEIJING_OFFSET_MS);
  let localTarget = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(schedule.hour), Number(schedule.minute));
  if (schedule.scheduleType === "weekly") {
    const delta = (Number(schedule.dayOfWeek) - local.getUTCDay() + 7) % 7;
    localTarget += delta * 86_400_000;
  }
  let target = localTarget - BEIJING_OFFSET_MS;
  const period = schedule.scheduleType === "daily" ? 86_400_000 : 7 * 86_400_000;
  if (target <= now) target += period;
  return new Date(target).toISOString();
}

export function describeSchedule(schedule) {
  if (!schedule.enabled) return "已停用";
  if (schedule.scheduleType === "interval") return `每 ${schedule.intervalMinutes} 分钟`;
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.scheduleType === "daily") return `每天 ${time}`;
  return `每周${["日", "一", "二", "三", "四", "五", "六"][schedule.dayOfWeek]} ${time}`;
}

function repeatOptions(schedule) {
  if (schedule.scheduleType === "interval") return { every: Number(schedule.intervalMinutes) * 60_000 };
  const pattern = schedule.scheduleType === "daily"
    ? `${schedule.minute} ${schedule.hour} * * *`
    : `${schedule.minute} ${schedule.hour} * * ${schedule.dayOfWeek}`;
  return { pattern, tz: SCHEDULER_TIMEZONE };
}

export function createBackgroundScheduleService({ db, runtime }) {
  async function list() {
    return (await db.prepare("SELECT * FROM background_task_schedules ORDER BY role,identifier").all()).map(dto);
  }

  async function get(identifier) {
    return dto(await db.prepare("SELECT * FROM background_task_schedules WHERE identifier=?").get(identifier));
  }

  async function reconcileOne(identifier) {
    const schedule = await get(identifier);
    if (!schedule) throw httpError(404, "定时任务不存在");
    const queue = runtime.queue(schedule.role);
    if (!schedule.enabled) {
      await queue.removeJobScheduler(schedule.identifier);
      return schedule;
    }
    const repeat = repeatOptions(schedule);
    const existing = (await queue.getJobSchedulers(0, -1, true)).find((item) => item.key === schedule.identifier);
    const unchanged = existing
      && existing.name === schedule.taskIdentifier
      && Number(existing.every || 0) === Number(repeat.every || 0)
      && String(existing.pattern || "") === String(repeat.pattern || "")
      && String(existing.tz || "") === String(repeat.tz || "");
    if (unchanged) return schedule;
    await queue.upsertJobScheduler(schedule.identifier, repeat, {
      name: schedule.taskIdentifier,
      data: { scheduleIdentifier: schedule.identifier, triggerType: "schedule" },
      opts: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: { age: 7 * 86_400, count: 10_000 },
        removeOnFail: { age: 30 * 86_400, count: 10_000 }
      }
    });
    return schedule;
  }

  async function reconcileAll() {
    const schedules = await list();
    for (const schedule of schedules) await reconcileOne(schedule.identifier);
    for (const role of ["scheduler", "maintenance"]) {
      const desired = new Set(schedules.filter((item) => item.role === role && item.enabled).map((item) => item.identifier));
      const existing = await runtime.queue(role).getJobSchedulers(0, -1, true);
      for (const scheduler of existing) if (!desired.has(scheduler.key)) await runtime.queue(role).removeJobScheduler(scheduler.key);
    }
    return schedules.length;
  }

  async function update(identifier, input) {
    const schedule = await db.transaction(async () => {
      const current = await db.prepare("SELECT * FROM background_task_schedules WHERE identifier=? FOR UPDATE").get(identifier);
      if (!current) throw httpError(404, "定时任务不存在");
      const normalized = normalizeSchedule(input);
      const enabled = input.enabled === undefined ? Boolean(current.enabled) : Boolean(input.enabled);
      const now = new Date();
      const next = enabled ? nextRunAt(normalized, now) : null;
      await db.prepare(`UPDATE background_task_schedules
        SET enabled=?,schedule_type=?,interval_minutes=?,hour=?,minute=?,day_of_week=?,next_run_at=?,updated_at=? WHERE identifier=?`)
        .run(enabled ? 1 : 0, normalized.scheduleType, normalized.intervalMinutes, normalized.hour, normalized.minute, normalized.dayOfWeek, next, now.toISOString(), identifier);
      return get(identifier);
    });
    await reconcileOne(identifier);
    return schedule;
  }

  async function runNow(identifier) {
    const schedule = await get(identifier);
    if (!schedule) throw httpError(404, "定时任务不存在");
    const job = await runtime.add(schedule.role, schedule.taskIdentifier, {
      scheduleIdentifier: schedule.identifier,
      triggerType: "manual"
    }, { jobId: `manual-${schedule.identifier}-${Date.now()}` });
    return { jobId: String(job.id), identifier, taskIdentifier: schedule.taskIdentifier };
  }

  async function recordTriggered(identifier, at = new Date()) {
    const schedule = await get(identifier);
    if (!schedule) return;
    const now = at.toISOString();
    const next = schedule.enabled ? nextRunAt(schedule, at, schedule.nextRunAt) : null;
    await db.prepare("UPDATE background_task_schedules SET next_run_at=?,last_enqueued_at=?,updated_at=? WHERE identifier=?")
      .run(next, now, now, identifier);
  }

  return { list, get, update, runNow, reconcileOne, reconcileAll, recordTriggered };
}
