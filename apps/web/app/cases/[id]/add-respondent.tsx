'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
 */
export function AddRespondent({ caseId, disabled }: { caseId: string; disabled?: boolean }) {
  const router = useRouter();
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

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function add(body: unknown) {
    setBusy(true);
    setError(null);
    try {
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
      setOpen(false);
      setQuery('');
      setFullName('');
      setRegistrationNo('');
      setClinicName('');
      setEmail('');
      setMobile('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (disabled) return null;

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Name a dentist
      </button>
    );
  }

  return (
    <form
      className="action-form"
      onSubmit={(e) => {
        e.preventDefault();
        void add({
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
            // The search box doubles as the name field: what they type is almost always
            // the name, and making them type it twice would be silly.
            if (!fullName || fullName === query) setFullName(e.target.value);
          }}
          placeholder="Name, registration number or phone"
          autoFocus
        />
        <p className="rti-hint">
          {searching
            ? 'Looking\u2026'
            : 'Search first. If the Council has dealt with this dentist before, picking them ' +
              'here is what makes their history visible to the committee.'}
        </p>
      </div>

      {candidates.length > 0 && (
        <div>
          {candidates.map((c) => (
            <div className="rti-ground" key={c.partyId || c.registeredDentistId}>
              <div className="cite">{c.fullName}</div>
              <p className="because">
                {c.because}
                {c.registrationNo && ` · Reg. ${c.registrationNo}`}
                {c.clinicName && ` · ${c.clinicName}`}
                {c.email && ` · ${c.email}`}
              </p>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() =>
                  void add(
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
              </button>
            </div>
          ))}
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
          Worth chasing: it is unique in the Council&rsquo;s register, so recording it now is
          what joins this dentist to the register of dentists later without re-typing.
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

      <label className="check">
        <input
          type="checkbox"
          checked={isEstablishment}
          onChange={(e) => setIsEstablishment(e.target.checked)}
        />
        <span>This is a clinic or a chain rather than an individual dentist.</span>
      </label>

      {error && <p className="rti-error">{error}</p>}

      <div className="action-buttons">
        <button type="submit" disabled={busy || !fullName.trim()}>
          {busy ? 'Adding\u2026' : 'Name them on this case'}
        </button>
        <button type="button" className="link-button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
