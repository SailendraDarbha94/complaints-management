import type { Metadata } from "next";
import { createServiceClient } from "@/lib/supabase/server";
import { Search } from "lucide-react";

export const metadata: Metadata = {
  title: "Users — Cogrow Admin",
};

export const dynamic = "force-dynamic";

export default async function UsersPage(props: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const searchParams = await props.searchParams;
  const query = searchParams.q || "";
  const page = Math.max(1, parseInt(searchParams.page || "1", 10));
  const perPage = 25;
  const offset = (page - 1) * perPage;

  const supabase = await createServiceClient();

  let dbQuery = supabase
    .from("users_master")
    .select(
      "id, email, full_name, power_level, strength, stamina, avatar_url, created_at",
      { count: "exact" }
    )
    .order("power_level", { ascending: false })
    .range(offset, offset + perPage - 1);

  if (query) {
    dbQuery = dbQuery.or(
      `full_name.ilike.%${query}%,email.ilike.%${query}%`
    );
  }

  const { data: users, count } = await dbQuery;

  // Fetch user_stats for these users
  const userIds = users?.map((u) => u.id) || [];
  const { data: stats } = await supabase
    .from("user_stats")
    .select("user_id, wins, losses, ties, current_streak, best_streak, tier")
    .in("user_id", userIds);

  const statsMap = new Map(stats?.map((s) => [s.user_id, s]));
  const totalPages = Math.ceil((count || 0) / perPage);

  return (
    <div>
      <h1 className="text-2xl font-bold">Users</h1>
      <p className="mt-1 text-sm text-muted">
        {count?.toLocaleString() || 0} total users
      </p>

      {/* Search */}
      <form className="mt-6">
        <div className="relative max-w-md">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            name="q"
            defaultValue={query}
            placeholder="Search by name or email..."
            className="w-full rounded-lg border border-border bg-surface-light py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted/50 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
          />
        </div>
      </form>

      {/* Table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface">
              <th className="px-4 py-3 text-left font-medium text-muted">
                User
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Power Level
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Tier
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Strength
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Stamina
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                W/L/T
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Streak
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted">
                Joined
              </th>
            </tr>
          </thead>
          <tbody>
            {users?.map((user) => {
              const s = statsMap.get(user.id);
              return (
                <tr
                  key={user.id}
                  className="border-b border-border/50 transition-colors hover:bg-surface-light"
                >
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium">
                        {user.full_name || "Unnamed"}
                      </p>
                      <p className="text-xs text-muted">{user.email}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-accent">
                    {Number(user.power_level || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs text-accent">
                      {s?.tier || "Earthling"}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {Number(user.strength || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {Number(user.stamina || 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {s ? `${s.wins}/${s.losses}/${s.ties}` : "0/0/0"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {s?.current_streak || 0}{" "}
                    <span className="text-muted">
                      (best: {s?.best_streak || 0})
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {user.created_at
                      ? new Date(user.created_at).toLocaleDateString()
                      : "—"}
                  </td>
                </tr>
              );
            })}
            {(!users || users.length === 0) && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-muted"
                >
                  No users found
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
                href={`?q=${encodeURIComponent(query)}&page=${page - 1}`}
                className="rounded-lg border border-border px-3 py-1.5 text-muted transition-colors hover:bg-surface-light hover:text-foreground"
              >
                Previous
              </a>
            )}
            {page < totalPages && (
              <a
                href={`?q=${encodeURIComponent(query)}&page=${page + 1}`}
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
