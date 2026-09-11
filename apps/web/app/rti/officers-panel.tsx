import { fetchRtiOfficers } from '@/lib/api';
import { OfficersForm } from './officers-form';

/**
 * Who holds the two offices the Act names.
 *
 * Nothing here is defaulted. s.19(1) requires the First Appellate Authority to be an
 * officer senior in rank to the Public Information Officer, so the two cannot be the same
 * person, and which of the officer and the Registrar holds which is a question for the
 * Registrar rather than for whoever wrote this file. Until it is answered the panel says
 * plainly what that costs: every refusal issued is defective on its face.
 */
export async function OfficersPanel() {
  const officers = await fetchRtiOfficers().catch(() => ({
    pio: null,
    firstAppellateAuthority: null,
  }));

  const missing = !officers.pio || !officers.firstAppellateAuthority;
  if (!missing) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>The two offices</h2>
        </div>
        <div className="panel-body">
          <dl className="pairs">
            <div>
              <dt>Public Information Officer</dt>
              <dd>
                {officers.pio!.fullName}
                {officers.pio!.designation ? `, ${officers.pio!.designation}` : ''}
              </dd>
            </div>
            <div>
              <dt>First Appellate Authority</dt>
              <dd>
                {officers.firstAppellateAuthority!.fullName}
                {officers.firstAppellateAuthority!.designation
                  ? `, ${officers.firstAppellateAuthority!.designation}`
                  : ''}
              </dd>
            </div>
          </dl>
          <OfficersForm collapsed />
        </div>
      </section>
    );
  }

  return (
    <section className="panel panel-consequential">
      <div className="panel-head">
        <h2>Two offices are not recorded yet</h2>
      </div>
      <div className="panel-body">
        <p className="rti-hint">
          Section 7(8) says a rejection must communicate three things: the reasons, the
          period within which an appeal may be preferred, and the particulars of the
          appellate authority. Until the First Appellate Authority is recorded here, every
          refusal this Council issues is missing the third and is appealable on its face.
        </p>
        <p className="rti-hint">
          Section 19(1) requires the appellate authority to be an officer senior in rank to
          the Public Information Officer, so the two cannot be the same person. Settle it
          with the Registrar before the next application arrives.
        </p>
        <OfficersForm />
      </div>
    </section>
  );
}
