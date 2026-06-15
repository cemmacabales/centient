"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface TimeSeriesPoint {
  hour: string;
  count: number;
}

function formatHourLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function SubmissionVolumeChart({
  data,
}: {
  data: TimeSeriesPoint[];
}) {
  const chartData = data.map((d) => ({
    hour: formatHourLabel(d.hour),
    count: d.count,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline-variant, #c4c7c5)" opacity={0.3} />
        <XAxis
          dataKey="hour"
          tick={{ fontSize: 11, fill: "var(--color-outline, #747775)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--color-outline-variant, #c4c7c5)", opacity: 0.3 }}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--color-outline, #747775)" }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            borderRadius: "12px",
            border: "1px solid var(--color-outline-variant, #c4c7c5)",
            background: "var(--color-surface-container-lowest, #fff)",
            fontSize: "13px",
          }}
        />
        <Bar dataKey="count" fill="var(--color-primary, #006d3d)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
