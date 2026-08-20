import { type ReactNode } from "react";

import { Check, Trash2, X } from "lucide-react";
import { type TrendPoint } from "@sentinel/shared";
import { Button, IconButton, Modal, cn } from "@/components/common";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/lib/core";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type ToastState = { tone: "success" | "warning"; text: string } | null;

export function SelectionCell({ control, className = "" }: { control: ReactNode; className?: string }) {
  return <span className={`admin-selection-cell${className ? ` ${className}` : ""}`}>{control}</span>;
}

export function SelectionHeader({ control, className = "" }: { control: ReactNode; className?: string }) {
  return <label className={`admin-selection-cell admin-selection-header${className ? ` ${className}` : ""}`}>{control}<span>选择</span></label>;
}

export function SequenceCell({ value, className = "" }: { value: number | string; className?: string }) {
  return <span className={`admin-sequence-cell${className ? ` ${className}` : ""}`}><span className="admin-sequence-number">{value}</span></span>;
}

export function SequenceHeader({ className = "" }: { className?: string }) {
  return <span className={`admin-sequence-cell admin-sequence-header${className ? ` ${className}` : ""}`}><span>序号</span></span>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="admin-page-header"><div><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function Toast({ value, onClose }: { value: ToastState; onClose: () => void }) {
  if (!value) return null;
  return <div className={cn("toast", `toast-${value.tone}`)} role="status"><Check size={17} /><span>{value.text}</span><IconButton label="关闭" onClick={onClose}><X size={15} /></IconButton></div>;
}

export function DeleteConfirmation({ open, title, subject, warning, confirming, onClose, onConfirm }: { open: boolean; title: string; subject: string; warning: string; confirming: boolean; onClose: () => void; onConfirm: () => void }) {
  const close = () => { if (!confirming) onClose(); };
  return <Modal open={open} title={title} onClose={close} footer={<><Button variant="ghost" onClick={close} disabled={confirming}>取消</Button><Button variant="danger" onClick={onConfirm} disabled={confirming}><Trash2 size={16} />{confirming ? "删除中..." : "确认删除"}</Button></>}><div className="delete-confirmation"><span><Trash2 size={22} /></span><div><strong>{subject}</strong><p>{warning}</p></div></div></Modal>;
}

export function AdminTrendChart({ data }: { data: TrendPoint[] }) {
  const option = {
    animationDuration: 420,
    tooltip: {
      trigger: "axis",
      backgroundColor: "#0a1728",
      borderColor: "rgba(86,136,220,.38)",
      padding: [10, 12],
      textStyle: { color: "#d9e5f1", fontSize: 12 }
    },
    legend: { right: 8, top: 2, itemWidth: 18, itemHeight: 8, data: ["入库总量", "高危风险"], textStyle: { color: "#95a8bd", fontSize: 11 } },
    grid: { left: 54, right: 52, top: 48, bottom: 34 },
    xAxis: { type: "category", boundaryGap: true, data: data.map((point) => point.date), axisLine: { lineStyle: { color: "rgba(86,136,220,.18)" } }, axisLabel: { color: "#7f92a8", margin: 12 }, axisTick: { show: false } },
    yAxis: [
      { type: "value", name: "入库 / 条", nameTextStyle: { color: "#6f8299", fontSize: 10, padding: [0, 0, 6, 0] }, axisLabel: { color: "#6f8299", formatter: (value: number) => value >= 10000 ? `${Math.round(value / 1000)}k` : value.toLocaleString("zh-CN") }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: "rgba(86,136,220,.1)" } } },
      { type: "value", name: "高危 / 条", nameTextStyle: { color: "#a9825f", fontSize: 10, padding: [0, 0, 6, 0] }, axisLabel: { color: "#a9825f" }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } }
    ],
    series: [
      { name: "入库总量", type: "bar", yAxisIndex: 0, data: data.map((point) => point.total), barMaxWidth: 22, itemStyle: { color: "#527ff0", borderRadius: [3, 3, 0, 0] }, emphasis: { itemStyle: { color: "#7398ff" } } },
      { name: "高危风险", type: "line", yAxisIndex: 1, smooth: 0.3, symbol: "circle", symbolSize: 7, data: data.map((point) => point.critical + point.high), lineStyle: { color: "#f3a24f", width: 2 }, itemStyle: { color: "#f3a24f", borderColor: "#07111f", borderWidth: 2 }, areaStyle: { color: "rgba(243,162,79,.07)" } }
    ]
  };
  return <div className="admin-trend-chart" role="img" aria-label="近七日情报入库总量和高危风险双坐标趋势"><ReactEChartsCore echarts={echarts} option={option} style={{ height: 320 }} /></div>;
}
