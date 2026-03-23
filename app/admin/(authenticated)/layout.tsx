import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LayoutDashboard, Bell, Users, Swords, LogOut } from "lucide-react";

async function AdminNav() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/admin/login");
  }

  return (
    <aside className="fixed left-0 top-0 bottom-0 z-40 flex w-64 flex-col border-r border-border bg-surface">
      {/* Logo */}
      <div className="flex h-16 items-center border-b border-border px-6">
        <Link href="/admin/dashboard" className="text-xl font-bold">
          <span className="text-accent">Co</span>grow
          <span className="ml-2 text-xs font-normal text-muted">Admin</span>
        </Link>
      </div>

      {/* Nav links */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-1">
          <NavLink href="/admin/dashboard" icon={LayoutDashboard}>
            Dashboard
          </NavLink>
          <NavLink href="/admin/dashboard/users" icon={Users}>
            Users
          </NavLink>
          <NavLink href="/admin/dashboard/challenges" icon={Swords}>
            Challenges
          </NavLink>
          <NavLink href="/admin/notifications" icon={Bell}>
            Push Notifications
          </NavLink>
        </div>
      </nav>

      {/* User section */}
      <div className="border-t border-border px-4 py-4">
        <p className="truncate text-sm text-muted">{user.email}</p>
        <form action={logoutAction}>
          <button
            type="submit"
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted transition-colors hover:bg-surface-light hover:text-foreground cursor-pointer"
          >
            <LogOut size={16} />
            Sign Out
          </button>
        </form>
      </div>
    </aside>
  );
}

function NavLink({
  href,
  icon: Icon,
  children,
}: {
  href: string;
  icon: React.ComponentType<{ size?: number }>;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-light hover:text-foreground"
    >
      <Icon size={18} />
      {children}
    </Link>
  );
}

async function logoutAction() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <AdminNav />
      <main className="ml-64 min-h-screen">
        <div className="px-8 py-8">{children}</div>
      </main>
    </div>
  );
}
