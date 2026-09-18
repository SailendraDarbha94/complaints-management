import { PendingLink } from '../../components/pending-link';
import { RtiIntakeForm } from './intake-form';

export const dynamic = 'force-dynamic';

/**
 * Logging an application.
 *
 * The date at the top is the one that matters: every period in the Act runs from the
 * Council's own inward date, so a postal application that sat in a tray for a fortnight
 * arrives here already fourteen days old, and the form says so rather than quietly
 * starting the clock today.
 */
export default function NewRtiPage() {
  return (
    <main className="shell">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/rti">RTI</PendingLink>
        <span aria-hidden="true">/</span>
        <span className="here">New</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>Log an RTI application</h1>
          <p className="case-summary">
            Thirty days, counted in calendar days from the date below. There is nowhere here
            to record why the applicant wants the information, because section 6(2) forbids
            asking.
          </p>
        </div>
      </header>

      <RtiIntakeForm />
    </main>
  );
}
