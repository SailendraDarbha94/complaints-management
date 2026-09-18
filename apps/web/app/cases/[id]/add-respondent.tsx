'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { BusyButton } from '@/app/components/busy-button';
import { Spinner } from '@/app/components/spinner';
import { useAction } from '@/app/components/use-action';
import type { RespondentCandidate } from '@/lib/api';
import { PUBLIC_API_URL } from '@/lib/public-api';

/**
 * Naming the dentist a complaint is about.
 *
 * Search first, type second, and that order is the whole design. The Council's interest is
 * in whether this is the third complaint against the same dentist, and that only becomes
 * visible if the three complaints point at one person — so the form looks for them before
 * it offers to create anybody, and says how many cases each candidate already carries.
 *
 * It does not merge on a name by itself. Two dentists share a name, and putting one
 * person's notice history in front of a committee deciding about the other is a worse
 * mistake than typing a name twice.
 *
 * It owns the whole Respondents panel, not just a button in its header, because the form
 * does not fit in a header: in the 300px side column it opened beside the heading, squeezed
 * into what was left and clipped at the panel's edge. The button stays in the header; the
 * form opens in the body, above the list the page renders and passes in as children. The
 * markup is the case page's Section helper's, so it still looks like every other panel.
 */
export function RespondentsPanel({
  caseId,
  title,
  disabled,
  children,
}: {
  caseId: string;
  title: string;
  /** A closed case: the list still shows, but nobody new can be named on it. */
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<RespondentCandidate[]>([]);
  const [searching, setSearching] = useState(false);

  const [fullName, setFullName] = useState('');
  const [registrationNo, setRegistrationNo] = useState('');
  const [clinicName, setClinicName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [isEstablishment, setIsEstablishment] = useState(false);

  const action = useAction();
  // Which button started the add in flight - the form's own, or one candidate's - so the
  // spinner is on the one that was pressed while every other way of adding is shut.
  const [adding, setAdding] = useState<string | null>(null);

  // Look as they type, but not on every keystroke.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setCandidates([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `${PUBLIC_API_URL}/v1/cases/${caseId}/respondents?q=${encodeURIComponent(query)}`,
          { credentials: 'include' },
        );
        if (res.ok) {
          const payload = (await res.json()) as { candidates: RespondentCandidate[] };
          setCandidates(payload.candidates);
        }
      } catch {
        // A failed lookup is not worth an error message: the officer can still type the
        // name in full, which is the fallback this form is built around anyway.
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, open, caseId]);

  function add(from: string, body: unknown) {
    setAdding(from);
    action.run(
      async () => {
        const res = await fetch(`${PUBLIC_API_URL}/v1/cases/${caseId}/respondents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(payload.message ?? 'That did not go through.');
        }
      },
      (_result, router) => {
        // Closed and cleared in the same render as the refreshed list, so the dentist just
        // named appears as the form goes rather than a beat after it.
        setOpen(false);
        setQuery('');
        setFullName('');
        setRegistrationNo('');
        setClinicName('');
        setEmail('');
        setMobile('');
        setIsEstablishment(false);
        router.refresh();
      },
    );
  }

  const busy = action.pending;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {!disabled && !open && (
          <button type="button" className="link-button" onClick={() => setOpen(true)}>
            Name a dentist
          </button>
        )}
      </div>
      <div className="panel-body">
        {!disabled && open && (
          <form
            className="action-form respondent-form"
            onSubmit={(e) => {
              e.preventDefault();
              add('form', {
                fullName,
                registrationNo: registrationNo || null,
                clinicName: clinicName || null,
                email: email || null,
                mobile: mobile || null,
                isEstablishment,
              });
            }}
          >
            <div>
              <label htmlFor="who">Which dentist?</label>
              <input
                id="who"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  // The search box doubles as the name field: what they type is almost
                  // always the name, and making them type it twice would be silly.
                  if (!fullName || fullName === query) setFullName(e.target.value);
                }}
                placeholder="Name, registration number or phone"
                autoFocus
              />
              <p className="rti-hint">
                {searching ? (
                  <>
                    <Spinner />
                    Looking&hellip;
                  </>
                ) : (
                  'Search first. If the Council has dealt with this dentist before, picking ' +
                  'them here is what makes their history visible to the committee.'
                )}
              </p>
            </div>

            {candidates.length > 0 && (
              <div>
                {candidates.map((c) => {
                  const key = c.partyId || c.registeredDentistId || c.fullName;
                  return (
                    <div className="rti-ground" key={key}>
                      <div className="cite">{c.fullName}</div>
                      <p className="because wrap">
                        {c.because}
                        {c.registrationNo && ` · Reg. ${c.registrationNo}`}
                        {c.clinicName && ` · ${c.clinicName}`}
                        {c.email && ` · ${c.email}`}
                      </p>
                      <BusyButton
                        type="button"
                        className="link-button"
                        busy={busy && adding === key}
                        busyLabel="Adding…"
                        disabled={busy}
                        onClick={() =>
                          add(
                            key,
                            c.partyId
                              ? { partyId: c.partyId }
                              : {
                                  fullName: c.fullName,
                                  registrationNo: c.registrationNo,
                                  clinicName: c.clinicName,
                                  email: c.email,
                                  mobile: c.mobile,
                                },
                          )
                        }
                      >
                        {c.partyId ? 'This is the same dentist' : 'Use this register entry'}
                      </BusyButton>
                    </div>
                  );
                })}
              </div>
            )}

            <div>
              <label htmlFor="reg">Registration number</label>
              <input
                id="reg"
                value={registrationNo}
                onChange={(e) => setRegistrationNo(e.target.value)}
                placeholder="KA-11234"
              />
              <p className="rti-hint">
                Worth chasing: it is unique in the Council&rsquo;s register, so recording it
                now is what joins this dentist to the register of dentists later without
                re-typing.
              </p>
            </div>

            <div>
              <label htmlFor="clinic">Clinic</label>
              <input id="clinic" value={clinicName} onChange={(e) => setClinicName(e.target.value)} />
            </div>

            <div>
              <label htmlFor="remail">Email</label>
              <input id="remail" value={email} onChange={(e) => setEmail(e.target.value)} />
              <p className="rti-hint">
                Worth having for a second reason: with it on file, a reply from this dentist
                arriving in the inward mail can be matched to this case.
              </p>
            </div>

            <div>
              <label htmlFor="rmobile">Phone</label>
              <input id="rmobile" value={mobile} onChange={(e) => setMobile(e.target.value)} />
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={isEstablishment}
                onChange={(e) => setIsEstablishment(e.target.checked)}
              />
              <span>This is a clinic or a chain rather than an individual dentist.</span>
            </label>

            {action.error && <p className="rti-error">{action.error}</p>}

            <div className="action-buttons">
              <BusyButton
                type="submit"
                busy={busy && adding === 'form'}
                busyLabel="Adding…"
                disabled={busy || !fullName.trim()}
              >
                Name them on this case
              </BusyButton>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {children}
      </div>
    </section>
  );
}
