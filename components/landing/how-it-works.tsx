import {
  Target,
  Dumbbell,
  Upload,
  CheckCircle,
  Star,
  TrendingUp,
} from "lucide-react";

const steps = [
  {
    icon: Target,
    title: "Challenge a Friend",
    description: "Pick an exercise, set the timeframe, and send the challenge.",
  },
  {
    icon: Dumbbell,
    title: "Do the Work",
    description: "Complete pushups, hold planks — put in the reps throughout the challenge period.",
  },
  {
    icon: Upload,
    title: "Submit Video Proof",
    description: "Record yourself and submit video evidence of your exercise sets.",
  },
  {
    icon: CheckCircle,
    title: "Get Verified",
    description: "Your challenger reviews your submission and approves or disputes it.",
  },
  {
    icon: Star,
    title: "Earn Points",
    description: "Every verified rep and second earns Strength and Stamina points toward your Power Level.",
  },
  {
    icon: TrendingUp,
    title: "Level Up",
    description: "Watch your Power Level grow, climb tiers, and build an unbreakable streak.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative py-24">
      <div className="mx-auto max-w-4xl px-6">
        <div className="text-center">
          <h2 className="text-3xl font-bold sm:text-4xl">
            How it{" "}
            <span className="text-accent-secondary glow-text-cyan">works</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-muted">
            From challenge to glory in six simple steps.
          </p>
        </div>

        <div className="relative mt-16">
          {/* Vertical line */}
          <div className="absolute left-6 top-0 bottom-0 w-px bg-gradient-to-b from-accent via-accent-secondary to-accent/0 sm:left-1/2 sm:-translate-x-px" />

          <div className="space-y-12">
            {steps.map((step, idx) => (
              <div
                key={step.title}
                className={`relative flex items-start gap-6 sm:gap-12 ${
                  idx % 2 === 0 ? "sm:flex-row" : "sm:flex-row-reverse"
                }`}
              >
                {/* Step content */}
                <div
                  className={`flex-1 pl-16 sm:pl-0 ${
                    idx % 2 === 0 ? "sm:text-right" : "sm:text-left"
                  }`}
                >
                  <h3 className="text-lg font-semibold">{step.title}</h3>
                  <p className="mt-1 text-sm text-muted leading-relaxed">
                    {step.description}
                  </p>
                </div>

                {/* Icon node */}
                <div className="absolute left-0 sm:relative sm:left-auto flex-shrink-0">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border border-accent/30 bg-surface text-accent">
                    <step.icon size={20} />
                  </div>
                </div>

                {/* Spacer for alternating layout */}
                <div className="hidden flex-1 sm:block" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
