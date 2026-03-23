import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Cogrow",
  description: "Terms of Service for the Cogrow mobile application.",
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-24">
        <Link
          href="/"
          className="text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; Back to home
        </Link>

        <h1 className="mt-8 text-4xl font-bold">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted">
          Last updated: March 22, 2026
        </p>

        <div className="mt-10 space-y-8 text-sm text-muted leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              1. Acceptance of Terms
            </h2>
            <p>
              By downloading, installing, or using the Cogrow mobile application
              (the &ldquo;App&rdquo;), you agree to be bound by these Terms of
              Service (&ldquo;Terms&rdquo;). If you do not agree to these Terms,
              do not use the App.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              2. Description of Service
            </h2>
            <p>
              Cogrow is a fitness challenge platform that allows users to create
              and participate in 1v1 and group exercise challenges (pushups,
              planks, and future exercises), submit video proof of exercise
              completion, earn Power Level scores, and compete with friends.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              3. Account Registration
            </h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>You must be at least 13 years old to create an account.</li>
              <li>
                You are responsible for maintaining the confidentiality of your
                account credentials.
              </li>
              <li>
                You agree to provide accurate and complete information during
                registration.
              </li>
              <li>
                You are responsible for all activities that occur under your
                account.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              4. Challenge Rules & Fair Play
            </h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                You agree to perform exercises honestly and submit accurate video
                proof.
              </li>
              <li>
                Deliberately submitting fraudulent or misleading video evidence
                is prohibited.
              </li>
              <li>
                You agree to review others&apos; submissions fairly and in good
                faith.
              </li>
              <li>
                Cogrow reserves the right to void challenges or adjust scores in
                cases of verified cheating or abuse.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              5. Video Content Policy
            </h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                Videos must only show exercise-related content relevant to the
                challenge.
              </li>
              <li>
                You must not upload content that is offensive, inappropriate,
                violent, or violates any laws.
              </li>
              <li>
                You grant Cogrow a non-exclusive license to store and display
                your videos to relevant challenge participants for verification
                purposes.
              </li>
              <li>
                Cogrow reserves the right to remove any video content that
                violates these Terms.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              6. Power Level & Scoring
            </h2>
            <p>
              Power Levels, Strength, Stamina, tiers, and other scoring
              mechanisms are for entertainment and motivational purposes. Cogrow
              reserves the right to modify the scoring algorithms, tier
              thresholds, or point values at any time without prior notice.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              7. Prohibited Conduct
            </h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>
                Use the App for any unlawful purpose or in violation of these
                Terms
              </li>
              <li>Harass, bully, or intimidate other users</li>
              <li>
                Attempt to gain unauthorized access to other accounts or App
                systems
              </li>
              <li>
                Use automated systems or bots to interact with the App
              </li>
              <li>
                Interfere with or disrupt the App&apos;s infrastructure
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              8. Health & Safety Disclaimer
            </h2>
            <p>
              Cogrow is a fitness motivation platform, not a medical or fitness
              advisory service. You should consult a healthcare professional
              before beginning any exercise program. You participate in
              challenges at your own risk. Cogrow is not responsible for any
              injuries resulting from exercise activities performed through the
              App.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              9. Account Termination
            </h2>
            <p>
              Cogrow reserves the right to suspend or terminate your account at
              any time for violations of these Terms, fraudulent activity, or
              any other reason at our sole discretion. You may also delete your
              account at any time through the App settings.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              10. Limitation of Liability
            </h2>
            <p>
              To the maximum extent permitted by law, Cogrow shall not be liable
              for any indirect, incidental, special, consequential, or punitive
              damages arising from your use of the App. Our total liability
              shall not exceed the amount you paid to use the App (if any) in
              the twelve months preceding the claim.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              11. Changes to Terms
            </h2>
            <p>
              We may modify these Terms at any time. We will notify users of
              material changes through the App. Your continued use of the App
              after changes constitutes acceptance of the updated Terms.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-foreground mb-3">
              12. Contact
            </h2>
            <p>
              For questions about these Terms, contact us at{" "}
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
