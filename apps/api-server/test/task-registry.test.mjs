import assert from "node:assert/strict";
import test from "node:test";
import { BACKGROUND_TASK_CATALOG, mergeTaskLists } from "../src/modules/background/task-registry.mjs";
import { nextRunAt, normalizeSchedule } from "../src/modules/background/schedule-service.mjs";

test("统一后台任务注册表拒绝重名并声明完整 BullMQ 角色", () => {
  assert.deepEqual(Object.keys(mergeTaskLists({ one: () => {} }, { two: () => {} })).sort(), ["one", "two"]);
  assert.throws(() => mergeTaskLists({ repeated: () => {} }, { repeated: () => {} }), /后台任务标识重复/);

  assert.equal(BACKGROUND_TASK_CATALOG.length, 8);
  assert.deepEqual([...new Set(BACKGROUND_TASK_CATALOG.map((item) => item.role))].sort(), ["io", "maintenance", "scheduler", "snapshot"]);
  assert.equal(new Set(BACKGROUND_TASK_CATALOG.map((item) => item.identifier)).size, BACKGROUND_TASK_CATALOG.length);
});

test("后台计划按北京时间计算间隔、每日和每周的下次执行", () => {
  const now = new Date("2026-07-20T01:00:00.000Z");
  assert.equal(nextRunAt(normalizeSchedule({ scheduleType: "interval", intervalMinutes: 15 }), now), "2026-07-20T01:15:00.000Z");
  assert.equal(nextRunAt(normalizeSchedule({ scheduleType: "daily", hour: 10, minute: 30 }), now), "2026-07-20T02:30:00.000Z");
  assert.equal(nextRunAt(normalizeSchedule({ scheduleType: "weekly", dayOfWeek: 1, hour: 9, minute: 0 }), now), "2026-07-27T01:00:00.000Z");
  assert.throws(() => normalizeSchedule({ scheduleType: "interval", intervalMinutes: 0 }), /执行间隔/);
});
