"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  AreaChart,
  Area,
} from "recharts";

const COLORS = ["#00ff88", "#00d4ff"];

export function DashboardCharts({
  signupData,
  challengeData,
  exerciseDistribution,
  powerBuckets,
}: {
  signupData: { month: string; count: number }[];
  challengeData: { month: string; count: number }[];
  exerciseDistribution: { name: string; value: number }[];
  powerBuckets: { label: string; count: number }[];
}) {
  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      {/* User Signups Over Time */}
      <ChartCard title="User Signups">
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={signupData}>
            <defs>
              <linearGradient id="signupGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00ff88" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#00ff88" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              dataKey="month"
              tick={{ fill: "#888", fontSize: 12 }}
              stroke="#222"
            />
            <YAxis tick={{ fill: "#888", fontSize: 12 }} stroke="#222" />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0d0d0d",
                border: "1px solid #222",
                borderRadius: 8,
                color: "#e8e8e8",
              }}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke="#00ff88"
              fill="url(#signupGrad)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Challenges Created Over Time */}
      <ChartCard title="Challenges Created">
        <ResponsiveContainer width="100%" height={250}>
          <AreaChart data={challengeData}>
            <defs>
              <linearGradient id="challengeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#00d4ff" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#00d4ff" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              dataKey="month"
              tick={{ fill: "#888", fontSize: 12 }}
              stroke="#222"
            />
            <YAxis tick={{ fill: "#888", fontSize: 12 }} stroke="#222" />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0d0d0d",
                border: "1px solid #222",
                borderRadius: 8,
                color: "#e8e8e8",
              }}
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke="#00d4ff"
              fill="url(#challengeGrad)"
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Exercise Distribution */}
      <ChartCard title="Exercise Distribution">
        <ResponsiveContainer width="100%" height={250}>
          <PieChart>
            <Pie
              data={exerciseDistribution}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={90}
              paddingAngle={5}
              dataKey="value"
              label={({ name, percent }) =>
                `${name} ${((percent ?? 0) * 100).toFixed(0)}%`
              }
            >
              {exerciseDistribution.map((_, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={COLORS[index % COLORS.length]}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: "#0d0d0d",
                border: "1px solid #222",
                borderRadius: 8,
                color: "#e8e8e8",
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Power Level Distribution */}
      <ChartCard title="Power Level Distribution">
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={powerBuckets}>
            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
            <XAxis
              dataKey="label"
              tick={{ fill: "#888", fontSize: 12 }}
              stroke="#222"
            />
            <YAxis tick={{ fill: "#888", fontSize: 12 }} stroke="#222" />
            <Tooltip
              contentStyle={{
                backgroundColor: "#0d0d0d",
                border: "1px solid #222",
                borderRadius: 8,
                color: "#e8e8e8",
              }}
            />
            <Bar dataKey="count" fill="#00ff88" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-6">
      <h3 className="mb-4 text-sm font-semibold text-muted">{title}</h3>
      {children}
    </div>
  );
}
