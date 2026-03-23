"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const initialState: LoginState = {};

export default function AdminLoginPage() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background bg-grid">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-border bg-surface p-8 glow-green">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold">
              <span className="text-accent">Co</span>grow
            </h1>
            <p className="mt-1 text-sm text-muted">Admin Panel</p>
          </div>

          {state.error && (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              {state.error}
            </div>
          )}

          <form action={formAction} className="space-y-4">
            <Input
              name="email"
              type="email"
              label="Email"
              placeholder="admin@cogrow.app"
              autoComplete="email"
              error={state.fieldErrors?.email?.[0]}
            />
            <Input
              name="password"
              type="password"
              label="Password"
              placeholder="••••••••"
              autoComplete="current-password"
              error={state.fieldErrors?.password?.[0]}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={pending}
            >
              {pending ? "Signing in..." : "Sign In"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
