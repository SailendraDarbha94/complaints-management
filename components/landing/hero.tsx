import { Zap } from "lucide-react";

export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center bg-grid overflow-hidden">
      {/* Gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-background pointer-events-none" />

      <div className="relative mx-auto max-w-6xl px-6 pt-24 pb-20 text-center">
        {/* Badge */}
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-4 py-1.5 text-sm text-accent">
          <Zap size={14} />
          <span>Level up your fitness with friends</span>
        </div>

        {/* Heading */}
        <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-tight tracking-tight sm:text-6xl lg:text-7xl">
          Challenge. Compete.{" "}
          <span className="text-accent glow-text-green">Grow.</span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-lg text-muted leading-relaxed">
          Take on 1v1 and group fitness challenges with friends. Push your
          limits with pushups, planks, and more — earn your{" "}
          <span className="text-accent-secondary">Power Level</span> and rise
          through the ranks.
        </p>

        {/* CTA buttons */}
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center" id="download">
          <a
            href="#"
            className="inline-flex items-center gap-3 rounded-xl bg-accent px-6 py-3.5 text-base font-semibold text-black transition-all hover:bg-accent/90 glow-green"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
            </svg>
            Download for iOS
          </a>
          <a
            href="#"
            className="inline-flex items-center gap-3 rounded-xl border border-border px-6 py-3.5 text-base font-medium text-foreground transition-all hover:border-accent/30 hover:bg-surface-light"
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3.18 23.27c.35.47.82.73 1.3.73.35 0 .71-.12 1.08-.37L22.88 13.1c.49-.33.74-.67.74-1.1 0-.43-.25-.77-.74-1.1L5.56.37C5.19.12 4.83 0 4.48 0c-.48 0-.95.26-1.3.73C2.84 1.17 2.72 1.84 2.72 2.6v18.8c0 .76.12 1.43.46 1.87z" />
            </svg>
            Download for Android
          </a>
        </div>

        {/* Power Level visual */}
        <div className="mt-20 flex justify-center">
          <div className="relative">
            <div className="power-pulse absolute -inset-6 rounded-full bg-accent/10 blur-2xl" />
            <div className="relative flex h-40 w-40 flex-col items-center justify-center rounded-full border-2 border-accent/30 bg-surface glow-green">
              <span className="text-xs font-medium uppercase tracking-widest text-accent/70">
                Power Level
              </span>
              <span className="mt-1 text-4xl font-bold text-accent glow-text-green">
                9,001
              </span>
              <span className="mt-0.5 text-xs text-muted">Legendary</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
