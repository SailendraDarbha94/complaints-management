import { type HTMLAttributes } from "react";

export function Card({
  className = "",
  glow = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { glow?: boolean }) {
  return (
    <div
      className={`rounded-xl border border-border bg-surface p-6 ${glow ? "glow-green" : ""} ${className}`}
      {...props}
    />
  );
}
