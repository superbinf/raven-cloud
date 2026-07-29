const regionCenters = {
  北京: [116.40, 39.90], 天津: [117.20, 39.12], 河北: [114.52, 38.05], 山西: [112.55, 37.87], 内蒙古: [111.75, 40.84],
  辽宁: [123.43, 41.80], 吉林: [125.32, 43.90], 黑龙江: [126.64, 45.76], 上海: [121.47, 31.23], 江苏: [118.80, 32.06],
  浙江: [120.15, 30.27], 安徽: [117.28, 31.86], 福建: [119.30, 26.08], 江西: [115.86, 28.68], 山东: [117.00, 36.67],
  河南: [113.63, 34.75], 湖北: [114.31, 30.59], 湖南: [112.94, 28.23], 广东: [113.27, 23.13], 广西: [108.37, 22.82],
  海南: [110.35, 20.02], 重庆: [106.55, 29.56], 四川: [104.07, 30.67], 贵州: [106.71, 26.58], 云南: [102.71, 25.04],
  西藏: [91.11, 29.65], 陕西: [108.94, 34.34], 甘肃: [103.83, 36.06], 青海: [101.78, 36.62], 宁夏: [106.23, 38.49],
  新疆: [87.62, 43.82], 台湾: [121.51, 25.04], 香港: [114.17, 22.32], 澳门: [113.54, 22.20]
};

const riskRanks = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function text(value) { return value == null ? "" : String(value).trim(); }
function object(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try { const parsed = JSON.parse(text(value)); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}
function risk(value) {
  const normalized = text(value).toLowerCase();
  if (/(critical|严重|极高|致命)/.test(normalized)) return "critical";
  if (/(high|高危|高风险|^高$)/.test(normalized)) return "high";
  if (/(medium|中危|中风险|^中$)/.test(normalized)) return "medium";
  if (/(low|低危|低风险|^低$)/.test(normalized)) return "low";
  return "info";
}

function assetFields(row) {
  if (row?.fields && typeof row.fields === "object") return row.fields;
  return object(row?.fields_json);
}

function assetRegion(fields) {
  const geo = object(fields?.geo);
  const candidates = [geo.province, fields?.province, geo.location, fields?.ipLocation, fields?.ip_location, geo.city]
    .map(text).filter(Boolean);
  return Object.keys(regionCenters).find((name) => candidates.some((candidate) => candidate.includes(name))) || "";
}

export function aggregateAssetRegions(rows = []) {
  const regions = new Map();
  for (const row of rows) {
    const name = assetRegion(assetFields(row));
    if (!name) continue;
    const rowRisk = risk(row?.risk);
    const current = regions.get(name) || { name, value: 0, risk: "info", coordinate: regionCenters[name] };
    current.value += 1;
    if (riskRanks[rowRisk] > riskRanks[current.risk]) current.risk = rowRisk;
    regions.set(name, current);
  }
  return [...regions.values()].sort((left, right) => right.value - left.value || left.name.localeCompare(right.name, "zh-CN"));
}
