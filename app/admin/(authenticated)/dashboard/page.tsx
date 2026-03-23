import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/server";
import { DashboardCharts } from "./charts";

export const metadata: Metadata = {
  title: "Dashboard — Cogrow Admin",
};

export const dynamic = "force-dynamic";

async function getStats() {
  const supabase = await createServiceClient();

  const [
    { count: totalUsers },
    { count: activeChallenges },
    { count: activeGroupChallenges },
    { data: challengeStats },
    { data: userStatsAgg },
    { data: recentUsers },
    { data: recentChallenges },
  ] = await Promise.all([
    supabase
      .from("users_master")
      .select("*", { count: "exact", head: true }),
    supabase
      .from("challenges")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("group_challenges")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("challenges")
      .select("type, challenger_count, challengee_count"),
    supabase
      .from("user_stats")
      .select("power_level, strength, stamina"),
    supabase
      .from("users_master")
      .select("created_at")
      .order("created_at", { ascending: true }),
    supabase
      .from("challenges")
      .select("created_at, type")
      .order("created_at", { ascending: true }),
  ]);

  // Compute exercise totals
  let totalPushups = 0;
  let totalPlankSeconds = 0;
  let pushupChallenges = 0;
  let plankChallenges = 0;

  challengeStats?.forEach((c) => {
    const total = (c.challenger_count || 0) + (c.challengee_count || 0);
    if (c.type === "pushup") {
      totalPushups += total;
      pushupChallenges++;
    } else {
      totalPlankSeconds += total;
      plankChallenges++;
    }
  });

  // Compute power level distribution
  const powerBuckets = [
    { label: "0-100", count: 0 },
    { label: "101-500", count: 0 },
    { label: "501-1000", count: 0 },
    { label: "1001-5000", count: 0 },
    { label: "5000+", count: 0 },
  ];

  userStatsAgg?.forEach((u) => {
    const pl = Number(u.power_level) || 0;
    if (pl <= 100) powerBuckets[0].count++;
    else if (pl <= 500) powerBuckets[1].count++;
    else if (pl <= 1000) powerBuckets[2].count++;
    else if (pl <= 5000) powerBuckets[3].count++;
    else powerBuckets[4].count++;
  });

  // Aggregate signups by month
  const signupsByMonth: Record<string, number> = {};
  recentUsers?.forEach((u) => {
    const month = u.created_at?.slice(0, 7); // YYYY-MM
    if (month) signupsByMonth[month] = (signupsByMonth[month] || 0) + 1;
  });
  const signupData = Object.entries(signupsByMonth).map(([month, count]) => ({
    month,
    count,
  }));

  // Aggregate challenges by month
  const challengesByMonth: Record<string, number> = {};
  recentChallenges?.forEach((c) => {
    const month = c.created_at?.slice(0, 7);
    if (month)
      challengesByMonth[month] = (challengesByMonth[month] || 0) + 1;
  });
  const challengeData = Object.entries(challengesByMonth).map(
    ([month, count]) => ({ month, count })
  );

  return {
    totalUsers: totalUsers || 0,
    activeChallenges: (activeChallenges || 0) + (activeGroupChallenges || 0),
    totalPushups,
    totalPlankSeconds,
    pushupChallenges,
    plankChallenges,
    powerBuckets,
    signupData,
    challengeData,
  };
}

export default async function DashboardPage() {
  const stats = await getStats();

  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-1 text-sm text-muted">
        Overview of Cogrow app analytics
      </p>

      {/* Metric cards */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total Users"
          value={stats.totalUsers.toLocaleString()}
          accent="green"
        />
        <MetricCard
          label="Active Challenges"
          value={stats.activeChallenges.toLocaleString()}
          accent="cyan"
        />
        <MetricCard
          label="Total Pushups"
          value={stats.totalPushups.toLocaleString()}
          accent="green"
        />
        <MetricCard
          label="Plank Seconds"
          value={stats.totalPlankSeconds.toLocaleString()}
          accent="cyan"
        />
      </div>

      {/* Charts */}
      <DashboardCharts
        signupData={stats.signupData}
        challengeData={stats.challengeData}
        exerciseDistribution={[
          { name: "Pushups", value: stats.pushupChallenges },
          { name: "Planks", value: stats.plankChallenges },
        ]}
        powerBuckets={stats.powerBuckets}
      />
    </div>
  );
}

function MetricCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "green" | "cyan";
}) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface p-6 ${
        accent === "green" ? "glow-green" : "glow-cyan"
      }`}
    >
      <p className="text-sm text-muted">{label}</p>
      <p
        className={`mt-2 text-3xl font-bold ${
          accent === "green" ? "text-accent" : "text-accent-secondary"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
