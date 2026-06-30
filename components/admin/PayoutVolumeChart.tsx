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
import { formatUnits } from "viem";

interface PayoutTimeSeriesPoint {
  hour: string;
  amountUnits: string;
}

function formatHourLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function PayoutVolumeChart({
  data,
  decimals,
  symbol,
}: {
  data: PayoutTimeSeriesPoint[];
  decimals: number;
  symbol: string;
}) {
  const chartData = data.map((d) => ({
    hour: formatHourLabel(d.hour),
    amount: Number(Number(formatUnits(BigInt(d.amountUnits), decimals)).toFixed(4)),
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
        />
        <Tooltip
          formatter={(value: any) => [`${value} ${symbol}`, "Amount"]}
          contentStyle={{
            borderRadius: "12px",
            border: "1px solid var(--color-outline-variant, #c4c7c5)",
            background: "var(--color-surface-container-lowest, #fff)",
            fontSize: "13px",
          }}
        />
        <Bar dataKey="amount" fill="var(--color-secondary, #1b6ef3)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
