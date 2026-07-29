function comparableAssetState(key, value) {
  const normalized = value === null || value === undefined ? "" : String(value).trim().toLowerCase();
  if (key !== "alive") return normalized;
  if (["true", "1", "alive", "up", "存活"].includes(normalized)) return "alive";
  if (["false", "0", "dead", "down", "未存活"].includes(normalized)) return "dead";
  return normalized;
}

export function assetChangedFields(previousFields, nextFields) {
  return ["alive", "statusCode"].filter((key) => (
    Object.prototype.hasOwnProperty.call(previousFields || {}, key)
    && Object.prototype.hasOwnProperty.call(nextFields || {}, key)
    && comparableAssetState(key, previousFields[key]) !== comparableAssetState(key, nextFields[key])
  ));
}
