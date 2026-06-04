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

interface CategoryDistribution {
  category: string;
  count: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  coding: "#1b6ef3",
  math: "#006d3d",
  general: "#ba1a1a",
  explanation: "#7b2e8a",
  writing: "#8d5000",
  creative: "#005a6e",
  advice: "#4a4541",
};

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? "var(--color-outline, #747775)";
}

export default function CategoryDistributionChart({
  data,
}: {
  data: CategoryDistribution[];
}) {
  const chartData = data.map((d) => ({
    category: d.category,
    count: d.count,
    fill: categoryColor(d.category),
  }));

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 8, right: 8, bottom: 8, left: 16 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-outline-variant, #c4c7c5)" opacity={0.3} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: "var(--color-outline, #747775)" }}
          tickLine={false}
          axisLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="category"
          tick={{ fontSize: 11, fill: "var(--color-outline, #747775)" }}
          tickLine={false}
          axisLine={false}
          width={90}
        />
        <Tooltip
          contentStyle={{
            borderRadius: "12px",
            border: "1px solid var(--color-outline-variant, #c4c7c5)",
            background: "var(--color-surface-container-lowest, #fff)",
            fontSize: "13px",
          }}
        />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
