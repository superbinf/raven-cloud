import * as echarts from "echarts/core";
import { BarChart, EffectScatterChart, LineChart, LinesChart, MapChart, PieChart, ScatterChart } from "echarts/charts";
import { GeoComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/lib/core";
import { ChinaData } from "china-map-geojson";
import type { ExposurePoint, SourceDistributionItem, ThreatRegionPoint, TrendPoint } from "@sentinel/shared";

echarts.use([BarChart, EffectScatterChart, LineChart, LinesChart, MapChart, PieChart, ScatterChart, GeoComponent, GridComponent, LegendComponent, TooltipComponent, VisualMapComponent, CanvasRenderer]);
echarts.registerMap("sentinel-china", ChinaData as unknown as Parameters<typeof echarts.registerMap>[1]);

const axisColor = "#6f8299";
const splitColor = "rgba(86, 136, 220, 0.12)";
const severityChartColors = {
  critical: "#D20000",
  high: "#FF6B67",
  medium: "#FFBD00",
  low: "#00B342",
  info: "#2563eb"
} as const;
const severityChartPalette = [
  severityChartColors.critical,
  severityChartColors.high,
  severityChartColors.medium,
  severityChartColors.low,
  severityChartColors.info
];

export function ThreatTrendChart({ data, compact = false }: { data: TrendPoint[]; compact?: boolean }) {
  const riskAxisMax = Math.max(...data.flatMap((item) => [item.critical, item.high, item.medium]), 1);
  const option = {
    animationDuration: 450,
    backgroundColor: "transparent",
    tooltip: { trigger: "axis", backgroundColor: "#0a1728", borderColor: "rgba(86,136,220,.35)", textStyle: { color: "#d9e5f1" } },
    legend: { right: 8, top: 0, textStyle: { color: "#95a8bd" }, data: ["情报总量", "严重", "高危", "中危"] },
    grid: { left: 44, right: 44, top: 42, bottom: 30 },
    xAxis: { type: "category", boundaryGap: false, data: data.map((item) => item.date), axisLine: { lineStyle: { color: splitColor } }, axisLabel: { color: axisColor }, axisTick: { show: false } },
    yAxis: [
      { type: "value", axisLabel: { color: axisColor }, splitLine: { lineStyle: { color: splitColor } } },
      { type: "value", max: Math.ceil(riskAxisMax * 1.2), axisLabel: { color: axisColor }, splitLine: { show: false } }
    ],
    series: [
      { name: "情报总量", type: "line", smooth: true, symbolSize: 7, data: data.map((item) => item.total), lineStyle: { color: severityChartColors.info, width: 2 }, itemStyle: { color: severityChartColors.info }, areaStyle: { color: "rgba(37,99,235,.08)" } },
      { name: "严重", type: "line", yAxisIndex: 1, smooth: true, symbolSize: 6, data: data.map((item) => item.critical), lineStyle: { color: severityChartColors.critical, width: 2 }, itemStyle: { color: severityChartColors.critical } },
      { name: "高危", type: "line", yAxisIndex: 1, smooth: true, symbolSize: 6, data: data.map((item) => item.high), lineStyle: { color: severityChartColors.high, width: 2 }, itemStyle: { color: severityChartColors.high } },
      { name: "中危", type: "line", yAxisIndex: 1, smooth: true, symbolSize: 5, data: data.map((item) => item.medium), lineStyle: { color: severityChartColors.medium, width: 1.5, type: "dashed" }, itemStyle: { color: severityChartColors.medium } }
    ]
  };
  return <div className="chart" role="img" aria-label="近七日情报总量及严重、高危、中危数量趋势折线图"><ReactEChartsCore echarts={echarts} option={option} style={{ height: compact ? 190 : 300 }} notMerge /></div>;
}

const regionRiskLabels = { critical: "严重", high: "高危", medium: "中危", low: "低危", info: "信息" } as const;
const regionRiskRanks = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

export function ChinaThreatMap({ data }: { data: ThreatRegionPoint[] }) {
  const regionData = data.map((region) => ({ name: region.name, value: region.value }));
  const maxRegionValue = Math.max(...regionData.map((item) => item.value), 1);
  const nodeColor = (risk: ThreatRegionPoint["risk"]) => severityChartColors[risk];
  const nodeSize = (value: number) => 6 + Math.min(6, Math.sqrt(value / maxRegionValue) * 6);
  const highestRisk = [...data].sort((left, right) => {
    return regionRiskRanks[right.risk] - regionRiskRanks[left.risk] || right.value - left.value;
  })[0];
  const activeRegions = [...data]
    .sort((left, right) => regionRiskRanks[right.risk] - regionRiskRanks[left.risk] || right.value - left.value)
    .slice(0, 8);
  const monitoringRoutes = highestRisk
    ? [...data]
        .filter((region) => region.name !== highestRisk.name)
        .sort((left, right) => regionRiskRanks[right.risk] - regionRiskRanks[left.risk] || right.value - left.value)
        .map((region) => ({
          fromName: region.name,
          toName: highestRisk.name,
          coords: [region.coordinate, highestRisk.coordinate],
          lineStyle: { color: nodeColor(region.risk), curveness: 0.2 }
        }))
    : [];
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const option = {
    animation: !reduceMotion,
    animationDuration: 700,
    animationDurationUpdate: 450,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      backgroundColor: "rgba(3, 14, 24, .96)",
      borderColor: "rgba(95, 135, 255, .42)",
      textStyle: { color: "#dcecf0", fontSize: 12 },
      formatter: (params: { seriesName?: string; name?: string; value?: number | number[] }) => {
        const region = data.find((item) => item.name === params.name);
        if (region) return `${region.name}<br/>资产数量 ${region.value.toLocaleString("zh-CN")}<br/>风险等级 ${regionRiskLabels[region.risk]}`;
        return params.name || "监测节点";
      }
    },
    visualMap: {
      show: false,
      seriesIndex: 0,
      min: 0,
      max: maxRegionValue,
      inRange: { color: ["#0a1728", "#1d3768", "#a5632d", "#b74348"] }
    },
    geo: {
      map: "sentinel-china",
      roam: false,
      silent: true,
      zoom: 1.08,
      center: [104.2, 35.6],
      itemStyle: {
        areaColor: "#0a1728",
        borderColor: "rgba(95, 135, 255, .48)",
        borderWidth: 0.9,
        shadowColor: "rgba(95, 135, 255, .16)",
        shadowBlur: 10
      },
      emphasis: { disabled: true }
    },
    series: [
      {
        name: "区域风险热度",
        type: "map",
        map: "sentinel-china",
        geoIndex: 0,
        data: regionData,
        selectedMode: false
      },
      ...(monitoringRoutes.length ? [{
        name: "动态监测链路",
        type: "lines",
        coordinateSystem: "geo",
        silent: true,
        zlevel: 2,
        effect: {
          show: !reduceMotion,
          period: 4.2,
          trailLength: 0.22,
          symbol: "circle",
          symbolSize: 3.4,
          color: "#8ee7ff"
        },
        lineStyle: { width: 1, opacity: 0.48, curveness: 0.2 },
        data: monitoringRoutes
      }] : []),
      ...(data.length ? [{
        name: "监测节点",
        type: "scatter",
        coordinateSystem: "geo",
        zlevel: 3,
        symbolSize: (value: number[]) => nodeSize(Number(value[2] || 0)),
        emphasis: { scale: 1.35 },
        data: data.map((region) => {
          const color = nodeColor(region.risk);
          return {
            name: region.name, value: [...region.coordinate, region.value],
            itemStyle: { color, opacity: 0.94, borderColor: "rgba(235, 246, 255, .9)", borderWidth: 1, shadowBlur: 8, shadowColor: color }
          };
        })
      }] : []),
      ...(activeRegions.length ? [{
        name: "动态风险节点",
        type: "effectScatter",
        coordinateSystem: "geo",
        silent: true,
        zlevel: 4,
        showEffectOn: "render",
        rippleEffect: { period: 3.6, scale: 2.5, brushType: "stroke" },
        symbolSize: (value: number[]) => nodeSize(Number(value[2] || 0)) + 1.5,
        data: activeRegions.map((region) => {
          const color = nodeColor(region.risk);
          return {
            name: region.name,
            value: [...region.coordinate, region.value],
            itemStyle: { color, borderColor: "rgba(235, 246, 255, .9)", borderWidth: 1.1, shadowBlur: 12, shadowColor: color }
          };
        })
      }] : [])
    ]
  };
  return <div className="situation-map-chart" role="img" aria-label={data.length ? `中国区域风险地图，共 ${data.length} 个真实监测区域和 ${monitoringRoutes.length} 条动态监测链路` : "中国地图，当前无可用区域资产数据"}><ReactEChartsCore echarts={echarts} option={option} style={{ height: "100%", width: "100%" }} notMerge /></div>;
}

export function SourceDonutChart({ data }: { data: SourceDistributionItem[] }) {
  const option = {
    tooltip: { trigger: "item", formatter: "{b}: {c}", backgroundColor: "#0a1728", borderColor: "rgba(86,136,220,.35)", textStyle: { color: "#d9e5f1" } },
    legend: { bottom: 0, textStyle: { color: "#95a8bd" }, itemWidth: 10, itemHeight: 10 },
    series: [{
      type: "pie",
      radius: ["46%", "70%"],
      center: ["50%", "43%"],
      label: { show: false },
      itemStyle: { borderWidth: 0 },
      data: data.map((item, index) => ({ value: item.value, name: item.name, itemStyle: { color: severityChartPalette[index % severityChartPalette.length] } }))
    }]
  };
  return <div className="chart" role="img" aria-label="情报来源占比环形图"><ReactEChartsCore echarts={echarts} option={option} style={{ height: 300 }} /></div>;
}

export function ExposureBarChart({ data }: { data: ExposurePoint[] }) {
  const option = {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: "#0a1728", borderColor: "rgba(86,136,220,.35)", textStyle: { color: "#d9e5f1" } },
    grid: { left: 70, right: 20, top: 18, bottom: 24 },
    xAxis: { type: "value", axisLabel: { color: axisColor }, splitLine: { lineStyle: { color: splitColor } } },
    yAxis: { type: "category", data: data.map((item) => item.label), axisLabel: { color: "#95a8bd" }, axisLine: { show: false }, axisTick: { show: false } },
    series: [{ type: "bar", data: data.map((item) => item.value), barWidth: 12, itemStyle: { color: "#25c5d4", borderRadius: [0, 3, 3, 0] } }]
  };
  return <div className="chart" role="img" aria-label="互联网暴露面变化横向柱状图"><ReactEChartsCore echarts={echarts} option={option} style={{ height: 250 }} /></div>;
}
