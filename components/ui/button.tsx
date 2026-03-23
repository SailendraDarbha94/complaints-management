import { type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-black font-semibold hover:bg-accent/90 glow-green",
  secondary:
    "border border-accent/30 text-accent hover:bg-accent/10",
  ghost:
    "text-muted hover:text-foreground hover:bg-surface-light",
  danger:
    "bg-red-600 text-white font-semibold hover:bg-red-700",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none cursor-pointer ${variants[variant]} ${className}`}
      {...props}
    />
  );
}
