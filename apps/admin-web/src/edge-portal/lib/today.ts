export function todayStartIso(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

export function isTodayNew(value?: string, now = new Date()) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
