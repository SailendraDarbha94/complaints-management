'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The draft composer.
 *
 * Pick a letter, read it, copy it, send it from council webmail, then say so. The last
 * step is the one that matters: it records the despatch AND applies what sending that
 * letter means for the case, in one transaction.
 */

interface TemplateOption {
  kind: string;
  name: string;
  requiresRegistrarSignature: boolean;
}

interface Draft {
  correspondenceId: string;
  kind: string;
  subject: string;
  body: string;
  to: { name: string | null; email: string | null };
  attachments: Array<{ documentId: string; title: string; filename: string }>;
  requiresRegistrarSignature: boolean;
}

const SERVICE_MODES = [
  ['email', 'Email'],
  ['registered_post_ad', 'Registered post with acknowledgement due'],
  ['speed_post', 'Speed post'],
  ['courier', 'Courier'],
  ['hand_delivery', 'By hand'],
  ['whatsapp', 'WhatsApp'],
] as const;

const RESPONDENT_KINDS = new Set([
  'respondent_explanation_sought',
  'respondent_reminder',
  'respondent_final_notice',
  'ethics_explanation',
  'ethics_cease_desist',
]);

function todayInKolkata(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function Composer({
  caseId,
  apiUrl,
  templates,
  respondents,
}: {
  caseId: string;
  apiUrl: string;
  templates: TemplateOption[];
  respondents: Array<{ id: string; name: string; noticeCount: number }>;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<string>(templates[0]?.kind ?? '');
  const [respondentId, setRespondentId] = useState<string>(respondents[0]?.id ?? '');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sentOn, setSentOn] = useState(todayInKolkata());
  const [serviceMode, setServiceMode] = useState<string>('email');
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const needsRespondent = RESPONDENT_KINDS.has(kind);

  async function compose(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/cases/${caseId}/letters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          kind,
          caseRespondentId: needsRespondent ? respondentId : null,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? 'Could not draft that letter.');
      }
      const d = (await res.json()) as Draft;
      setDraft(d);
      setAttached(new Set());
      setServiceMode(d.requiresRegistrarSignature ? 'speed_post' : 'email');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(what: 'subject' | 'body' | 'both') {
    if (!draft) return;
    const text =
      what === 'subject' ? draft.subject : what === 'body' ? draft.body : `${draft.subject}\n\n${draft.body}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError('Could not reach the clipboard. Select the text and copy it by hand.');
    }
  }

  async function confirmSent(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/letters/${draft.correspondenceId}/sent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          sentAt: sentOn,
          serviceMode,
          caseRespondentId: needsRespondent ? respondentId : null,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? 'Could not record that.');
      }
      setDone(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="panel">
        <div className="panel-body">
          <p className="done-message">
            <strong>Recorded as sent on {sentOn}.</strong> The clock has started, and the
            case has moved on.
          </p>
          <div className="action-buttons">
            <a className="button-link" href={`/cases/${caseId}`}>
              Back to the case
            </a>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setDone(false);
                setDraft(null);
              }}
            >
              Draft another
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>1. Which letter</h2>
        </div>
        <div className="panel-body">
          {templates.length === 0 ? (
            <p className="muted">No letters apply to this kind of case.</p>
          ) : (
            <form className="compose-pick" onSubmit={compose}>
              <label>
                Letter
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setDraft(null);
                  }}
                >
                  {templates.map((t) => (
                    <option key={t.kind} value={t.kind}>
                      {t.name}
                      {t.requiresRegistrarSignature ? ' (Registrar signs)' : ''}
                    </option>
                  ))}
                </select>
              </label>

              {needsRespondent &&
                (respondents.length === 0 ? (
                  <p className="form-error">No dentist has been named on this case yet.</p>
                ) : (
                  <label>
                    To which dentist
                    <select
                      value={respondentId}
                      onChange={(e) => {
                        setRespondentId(e.target.value);
                        setDraft(null);
                      }}
                    >
                      {respondents.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name} — {r.noticeCount === 0 ? 'no notice yet' : `${r.noticeCount} sent`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}

              <button type="submit" disabled={busy || (needsRespondent && respondents.length === 0)}>
                {busy && !draft ? 'Drafting…' : 'Draft it'}
              </button>
            </form>
          )}
          {error && !draft && <p className="form-error">{error}</p>}
        </div>
      </section>

      {draft && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>2. Copy it into the council mailbox</h2>
              <button type="button" className="button-link" onClick={() => copy('both')}>
                {copied === 'both' ? 'Copied' : 'Copy subject and body'}
              </button>
            </div>
            <div className="panel-body">
              {draft.requiresRegistrarSignature && (
                <div className="banner banner-demo">
                  <span className="tag">Wet signature</span>
                  <span>
                    This letter is printed on the letterhead, signed and sealed by the
                    Registrar, then scanned back. The scan — not this draft — is the record
                    copy. Printing is Phase 3; for now, print this text.
                  </span>
                </div>
              )}

              <dl className="pairs">
                <div>
                  <dt>To</dt>
                  <dd>
                    {draft.to.name ?? '-'}
                    {draft.to.email && <span className="meta wrap">{draft.to.email}</span>}
                  </dd>
                </div>
              </dl>

              <div className="copy-block">
                <div className="copy-head">
                  <span className="copy-label">Subject</span>
                  <button type="button" className="link-button" onClick={() => copy('subject')}>
                    {copied === 'subject' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="copy-text subject">{draft.subject}</pre>
              </div>

              <div className="copy-block">
                <div className="copy-head">
                  <span className="copy-label">Body</span>
                  <button type="button" className="link-button" onClick={() => copy('body')}>
                    {copied === 'body' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="copy-text">{draft.body}</pre>
              </div>

              {draft.body.includes('__________') && (
                <p className="form-note warn">
                  This draft has blanks in it. Each one is a fact the register does not
                  hold — fill them in before sending, or add the missing detail to the case
                  and draft again.
                </p>
              )}

              {draft.attachments.length > 0 && (
                <div className="attachments">
                  <p className="copy-label">Attach these before you send</p>
                  <ul className="plain">
                    {draft.attachments.map((a) => (
                      <li key={a.documentId}>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={attached.has(a.documentId)}
                            onChange={(e) => {
                              const next = new Set(attached);
                              if (e.target.checked) next.add(a.documentId);
                              else next.delete(a.documentId);
                              setAttached(next);
                            }}
                          />
                          {a.title}
                          <span className="meta mono">{a.filename}</span>
                        </label>
                        <a
                          className="link-like"
                          href={`${apiUrl}/v1/documents/${a.documentId}/download`}
                        >
                          Open
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>

          <section className="panel panel-consequential">
            <div className="panel-head">
              <h2>3. Say that you sent it</h2>
            </div>
            <div className="panel-body">
              <p className="form-note">
                This is what starts the clock. Nothing is counted as sent until you
                confirm it here, and the date you give is the date the deadline runs from.
              </p>

              <form className="compose-sent" onSubmit={confirmSent}>
                <label>
                  Sent on
                  <input
                    type="date"
                    value={sentOn}
                    max={todayInKolkata()}
                    onChange={(e) => setSentOn(e.target.value)}
                    required
                  />
                </label>

                <label>
                  How it went
                  <select value={serviceMode} onChange={(e) => setServiceMode(e.target.value)}>
                    {SERVICE_MODES.map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </label>

                {needsRespondent && (
                  <p className="form-note">
                    Recording this will move {respondents.find((r) => r.id === respondentId)?.name}
                    &rsquo;s notice count. That count is what an ex parte finding rests on,
                    so only confirm a letter that has actually gone.
                  </p>
                )}

                {error && <p className="form-error">{error}</p>}

                <button type="submit" disabled={busy}>
                  {busy ? 'Recording…' : 'I have sent this'}
                </button>
              </form>
            </div>
          </section>
        </>
      )}
    </>
  );
}
