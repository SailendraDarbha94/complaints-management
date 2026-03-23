import {
  Swords,
  Users,
  Flame,
  Video,
  Trophy,
  UserPlus,
} from "lucide-react";

const features = [
  {
    icon: Swords,
    title: "1v1 Challenges",
    description:
      "Challenge a friend to a pushup or plank showdown. Set the timeframe — 1 day to 2 weeks — and see who comes out on top.",
    color: "text-accent" as const,
  },
  {
    icon: Users,
    title: "Group Challenges",
    description:
      "Rally up to 10 friends in a group challenge. Compete together, motivate each other, and crown the ultimate winner.",
    color: "text-accent-secondary" as const,
  },
  {
    icon: Flame,
    title: "Power Level System",
    description:
      "Every pushup and plank second earns you Strength and Stamina points that combine into your Power Level. Rise through tiers from Earthling and beyond.",
    color: "text-accent" as const,
  },
  {
    icon: Video,
    title: "Video Verification",
    description:
      "Submit video proof of your exercises. Your opponent or group peers review and verify your submissions — keeping it honest.",
    color: "text-accent-secondary" as const,
  },
  {
    icon: Trophy,
    title: "Win Streaks & Stats",
    description:
      "Track your wins, losses, current streak, and best streak. Watch your stats grow as you dominate challenge after challenge.",
    color: "text-accent" as const,
  },
  {
    icon: UserPlus,
    title: "Friend System",
    description:
      "Add friends, see their Power Levels, and challenge them anytime. Build your fitness crew and hold each other accountable.",
    color: "text-accent-secondary" as const,
  },
];

export function Features() {
  return (
    <section id="features" className="relative py-24 bg-surface">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center">
          <h2 className="text-3xl font-bold sm:text-4xl">
            Built for{" "}
            <span className="text-accent glow-text-green">growth</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-muted">
            Everything you need to turn fitness into a competitive, social, and
            rewarding experience.
          </p>
        </div>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="group rounded-xl border border-border bg-background p-6 transition-all duration-300 hover:border-accent/20 hover:glow-green"
            >
              <div
                className={`inline-flex rounded-lg bg-surface-light p-2.5 ${feature.color}`}
              >
                <feature.icon size={22} />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
