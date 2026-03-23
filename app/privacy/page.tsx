import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Cogrow",
  description: "Privacy Policy for the Cogrow mobile application.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <Link
          href="/"
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back to home
        </Link>

        <h1 className="mt-8 text-4xl font-bold">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted">
          Last updated: March 22, 2026
        </p>

        <div className="mt-10 space-y-8 text-sm text-muted leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              1. Introduction
            </h2>
            <p>
              Cogrow (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;)
              is committed to protecting your privacy. This Privacy Policy
              explains how we collect, use, disclose, and safeguard your
              information when you use the Cogrow mobile application (the
              &ldquo;App&rdquo;).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              2. Information We Collect
            </h2>
            <h3 className="font-medium text-foreground/80 mt-4 mb-2">
              2.1 Account Information
            </h3>
            <p>
              When you create an account, we collect your email address, display
              name, and optional profile avatar. Authentication is handled
              securely through our backend provider (Supabase).
            </p>

            <h3 className="font-medium text-foreground/80 mt-4 mb-2">
              2.2 Exercise & Challenge Data
            </h3>
            <p>
              We collect data about the challenges you create and participate in,
              including exercise type (pushups, planks), rep counts, duration,
              challenge timeframes, and results. This data is used to calculate
              your Power Level, Strength, Stamina, and tier ranking.
            </p>

            <h3 className="font-medium text-foreground/80 mt-4 mb-2">
              2.3 Video Submissions
            </h3>
            <p>
              When you submit video proof for challenges, the video is uploaded
              and stored securely. Videos are accessible only to relevant
              challenge participants for verification purposes.
            </p>

            <h3 className="font-medium text-foreground/80 mt-4 mb-2">
              2.4 Push Notification Tokens
            </h3>
            <p>
              If you enable push notifications, we store your device&apos;s push
              notification token (via Expo Push Notification Service) to send you
              challenge updates, friend requests, and other relevant
              notifications.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              3. How We Use Your Information
            </h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>Provide and maintain the App&apos;s functionality</li>
              <li>
                Calculate and display your Power Level, stats, and leaderboard
                position
              </li>
              <li>Facilitate challenges between you and other users</li>
              <li>
                Send push notifications about challenge updates and friend
                activity
              </li>
              <li>Improve the App and develop new features</li>
              <li>Monitor and analyze usage trends</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              4. Data Sharing & Third-Party Services
            </h2>
            <p>We use the following third-party services:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>
                <strong className="text-foreground/80">Supabase</strong> — database,
                authentication, and file storage
              </li>
              <li>
                <strong className="text-foreground/80">Expo</strong> — push
                notification delivery service
              </li>
            </ul>
            <p className="mt-3">
              We do not sell your personal information to third parties. We may
              share anonymized, aggregated data for analytics purposes.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              5. Data Security
            </h2>
            <p>
              We implement appropriate technical and organizational security
              measures to protect your personal information. However, no method
              of electronic transmission or storage is 100% secure, and we
              cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              6. Data Retention
            </h2>
            <p>
              We retain your personal information for as long as your account is
              active or as needed to provide you services. You may request
              deletion of your account and associated data at any time by
              contacting us.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              7. Your Rights
            </h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Withdraw consent for push notifications at any time</li>
              <li>Export your data in a portable format</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              8. Children&apos;s Privacy
            </h2>
            <p>
              The App is not intended for children under 13 years of age. We do
              not knowingly collect personal information from children under 13.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              9. Changes to This Policy
            </h2>
            <p>
              We may update this Privacy Policy from time to time. We will
              notify you of any changes by posting the new Privacy Policy in the
              App and updating the &ldquo;Last updated&rdquo; date.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              10. Contact Us
            </h2>
            <p>
              If you have questions about this Privacy Policy, please contact us
              at{" "}
              <a
                href="mailto:support@cogrow.app"
                className="text-accent hover:underline"
              >
                support@cogrow.app
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
