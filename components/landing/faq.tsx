"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

const faqs = [
  {
    question: "What exercises are supported?",
    answer:
      "Currently, Cogrow supports pushups (measured in reps) and planks (measured in seconds). We're actively working on adding more exercises like meditation, pull-ups, and running in future updates.",
  },
  {
    question: "How does the Power Level work?",
    answer:
      "Your Power Level is a computed score that combines your Strength (earned from pushups) and Stamina (earned from planks/time-based exercises). Every verified rep and second contributes to your stats, and your Power Level determines your tier ranking.",
  },
  {
    question: "What are group challenges?",
    answer:
      "Group challenges let you compete with up to 10 friends at once. The creator sets the exercise type and timeframe, invites participants, and everyone submits video proof of their workouts. The person with the highest verified count wins!",
  },
  {
    question: "Why do I need to submit video proof?",
    answer:
      "Video verification keeps the competition fair and honest. Your challenger or group peers review your submissions to confirm the count. This builds trust and ensures everyone is putting in real effort.",
  },
  {
    question: "What are the challenge timeframes?",
    answer:
      "You can set challenges for 1 day, 3 days, 1 week, or 2 weeks. Choose shorter timeframes for quick bursts of motivation, or longer ones for sustained habit-building.",
  },
  {
    question: "Is Cogrow free?",
    answer:
      "Yes! Cogrow is free to download and use. Challenge your friends, track your Power Level, and grow together without any cost.",
  },
  {
    question: "What tiers can I reach?",
    answer:
      'Everyone starts as an "Earthling." As your Power Level increases, you\'ll unlock higher tiers. Keep challenging yourself and your friends to rise through the ranks!',
  },
];

export function FAQ() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section id="faq" className="relative py-24 bg-surface">
      <div className="mx-auto max-w-3xl px-6">
        <div className="text-center">
          <h2 className="text-3xl font-bold sm:text-4xl">
            Frequently asked{" "}
            <span className="text-accent glow-text-green">questions</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-muted">
            Everything you need to know about Cogrow.
          </p>
        </div>

        <div className="mt-12 space-y-3">
          {faqs.map((faq, idx) => (
            <div
              key={idx}
              className="rounded-xl border border-border bg-background overflow-hidden"
            >
              <button
                className="flex w-full items-center justify-between px-6 py-4 text-left text-sm font-medium transition-colors hover:bg-surface-light cursor-pointer"
                onClick={() => setOpenIndex(openIndex === idx ? null : idx)}
              >
                {faq.question}
                <ChevronDown
                  size={18}
                  className={`flex-shrink-0 text-muted transition-transform duration-200 ${
                    openIndex === idx ? "rotate-180" : ""
                  }`}
                />
              </button>
              {openIndex === idx && (
                <div className="border-t border-border px-6 py-4 text-sm text-muted leading-relaxed">
                  {faq.answer}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
