import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Challenges — Cogrow Admin",
};

export const dynamic = "force-dynamic";

export default async function ChallengesPage(props: {
  searchParams: Promise<{ status?: string; type?: string; page?: string }>;
}) {
  const searchParams = await props.searchParams;
  const statusFilter = searchParams.status || "all";
  const typeFilter = searchParams.type || "all";
  const page = Math.max(1, parseInt(searchParams.page || "1", 10));
  const perPage = 25;
  const offset = (page - 1) * perPage;

  const supabase = await createServiceClient();

  // 1v1 challenges
  let query = supabase
    .from("challenges")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + perPage - 1);

  if (statusFilter !== "all") {
    query = query.eq("status", statusFilter);
  }
  if (typeFilter !== "all") {
    query = query.eq("type", typeFilter);
  }

  const { data: challenges, count } = await query;

  // Get user names for display
  const userIds = new Set<string>();
  challenges?.forEach((c) => {
    userIds.add(c.challenger_id);
    userIds.add(c.challengee_id);
    if (c.winner_id) userIds.add(c.winner_id);
  });

  const { data: users } = await supabase
    .from("users_master")
    .select("id, full_name, email")
    .in("id", Array.from(userIds));

  const userMap = new Map(users?.map((u) => [u.id, u]));
  const totalPages = Math.ceil((count || 0) / perPage);

  const getUserName = (id: string) => {
    const u = userMap.get(id);
    return u?.full_name || u?.email || id.slice(0, 8);
  };

  const statusColors: Record<string, string> = {
    pending: "bg-yellow-500/10 text-yellow-400",
    active: "bg-accent/10 text-accent",
    completed: "bg-accent-secondary/10 text-accent-secondary",
  };

  return (
    <div>
      <h1 className="text-2xl font-bold">Challenges</h1>
      <p className="mt-1 text-sm text-muted">
        {count?.toLocaleString() || 0} total 1v1 challenges
      </p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap gap-3">
        <FilterGroup
          label="Status"
          param="status"
          current={statusFilter}
          options={["all", "pending", "active", "completed"]}
          otherParams={`&type=${typeFilter}`}
        />
        <FilterGroup
          label="Type"
          param="type"
          current={typeFilter}
          options={["all", "pushup", "plank"]}
          otherParams={`&status=${statusFilter}`}
        />
      </div>

      {/* Table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="px-4 py-3 text-left font-medium text-muted">
                Type
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Challenger
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Challengee
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Timeframe
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Score
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Status
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Winner
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {challenges?.map((c) => (
              <tr
                key={c.id}
                className="border-b border-border/50 transition-colors hover:bg-surface-light"
              >
                <td className="px-4 py-3">
                  <span className="rounded bg-surface-light px-2 py-0.5 text-xs font-medium capitalize">
                    {c.type}
                  </span>
                </td>
                <td className="px-4 py-3">{getUserName(c.challenger_id)}</td>
                <td className="px-4 py-3">{getUserName(c.challengee_id)}</td>
                <td className="px-4 py-3 text-xs text-muted">
                  {c.timeframe.replace(/_/g, " ")}
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  {c.challenger_count} vs {c.challengee_count}{" "}
                  <span className="text-muted">{c.unit}</span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs ${statusColors[c.status] || "text-muted"}`}
                  >
                    {c.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs">
                  {c.winner_id ? getUserName(c.winner_id) : "—"}
                </td>
                <td className="px-4 py-3 text-xs text-muted">
                  {c.created_at
                    ? new Date(c.created_at).toLocaleDateString()
                    : "—"}
                </td>
              </tr>
            ))}
            {(!challenges || challenges.length === 0) && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-muted"
                >
                  No challenges found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm">
          <p className="text-muted">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            {page > 1 && (
              <a
                href={`?status=${statusFilter}&type=${typeFilter}&page=${page - 1}`}
                className="rounded-lg border border-border px-3 py-1.5 text-muted transition-colors hover:bg-surface-light hover:text-foreground"
              >
                Previous
              </a>
            )}
            {page < totalPages && (
              <a
                href={`?status=${statusFilter}&type=${typeFilter}&page=${page + 1}`}
                className="rounded-lg border border-border px-3 py-1.5 text-muted transition-colors hover:bg-surface-light hover:text-foreground"
              >
                Next
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  param,
  current,
  options,
  otherParams,
}: {
  label: string;
  param: string;
  current: string;
  options: string[];
  otherParams: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted">{label}:</span>
      <div className="flex gap-1">
        {options.map((opt) => (
          <a
            key={opt}
            href={`?${param}=${opt}${otherParams}`}
            className={`rounded-lg px-3 py-1 text-xs capitalize transition-colors ${
              current === opt
                ? "bg-accent/10 text-accent"
                : "text-muted hover:bg-surface-light hover:text-foreground"
            }`}
          >
            {opt}
          </a>
        ))}
      </div>
    </div>
  );
}
