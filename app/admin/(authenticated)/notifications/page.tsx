"use client";

import { useActionState, useState, useTransition } from "react";
import {
  sendNotification,
  searchUsers,
  type NotificationState,
} from "./actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Send, Users, User } from "lucide-react";

const initialState: NotificationState = {};

export default function NotificationsPage() {
  const [state, formAction, pending] = useActionState(
    sendNotification,
    initialState
  );
  const [target, setTarget] = useState<"all" | "user">("all");
  const [userSearch, setUserSearch] = useState("");
  const [userResults, setUserResults] = useState<
    { id: string; full_name: string | null; email: string | null }[]
  >([]);
  const [selectedUser, setSelectedUser] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [, startTransition] = useTransition();

  const handleUserSearch = (value: string) => {
    setUserSearch(value);
    setSelectedUser(null);

    if (value.length >= 2) {
      startTransition(async () => {
        const results = await searchUsers(value);
        setUserResults(results);
      });
    } else {
      setUserResults([]);
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold">Push Notifications</h1>
      <p className="mt-1 text-sm text-muted">
        Send push notifications to users via Expo
      </p>

      <div className="mt-8 max-w-lg">
        {state.success && (
          <div className="mb-6 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
            {state.success}
          </div>
        )}
        {state.error && (
          <div className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {state.error}
          </div>
        )}

        <form action={formAction} className="space-y-6">
          {/* Target selector */}
          <div>
            <label className="mb-2 block text-sm font-medium text-muted">
              Target
            </label>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setTarget("all");
                  setSelectedUser(null);
                }}
                className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm transition-colors cursor-pointer ${
                  target === "all"
                    ? "border-accent/30 bg-accent/10 text-accent"
                    : "border-border text-muted hover:border-accent/20"
                }`}
              >
                <Users size={16} />
                All Users
              </button>
              <button
                type="button"
                onClick={() => setTarget("user")}
                className={`flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm transition-colors cursor-pointer ${
                  target === "user"
                    ? "border-accent/30 bg-accent/10 text-accent"
                    : "border-border text-muted hover:border-accent/20"
                }`}
              >
                <User size={16} />
                Specific User
              </button>
            </div>
            <input type="hidden" name="target" value={target} />
          </div>

          {/* User search (only for specific user) */}
          {target === "user" && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-muted">
                Search User
              </label>
              <input
                type="text"
                value={selectedUser ? selectedUser.label : userSearch}
                onChange={(e) => handleUserSearch(e.target.value)}
                placeholder="Search by name or email..."
                className="w-full rounded-lg border border-border bg-surface-light px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
              <input
                type="hidden"
                name="userId"
                value={selectedUser?.id || ""}
              />

              {/* Search results dropdown */}
              {userResults.length > 0 && !selectedUser && (
                <div className="mt-1 rounded-lg border border-border bg-surface overflow-hidden">
                  {userResults.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-left transition-colors hover:bg-surface-light cursor-pointer"
                      onClick={() => {
                        setSelectedUser({
                          id: user.id,
                          label:
                            user.full_name || user.email || user.id.slice(0, 8),
                        });
                        setUserSearch("");
                        setUserResults([]);
                      }}
                    >
                      <div>
                        <p className="font-medium">
                          {user.full_name || "Unnamed"}
                        </p>
                        <p className="text-xs text-muted">{user.email}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <Input
            name="title"
            label="Notification Title"
            placeholder="e.g., New Challenge Feature!"
            error={state.fieldErrors?.title?.[0]}
          />

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-muted">Message</label>
            <textarea
              name="body"
              rows={3}
              placeholder="e.g., Check out the new group challenges feature..."
              className="rounded-lg border border-border bg-surface-light px-4 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/30 resize-none"
            />
            {state.fieldErrors?.body?.[0] && (
              <p className="text-xs text-red-400">
                {state.fieldErrors.body[0]}
              </p>
            )}
          </div>

          <Button type="submit" disabled={pending} className="w-full">
            <Send size={16} />
            {pending ? "Sending..." : "Send Notification"}
          </Button>
        </form>
      </div>
    </div>
  );
}
