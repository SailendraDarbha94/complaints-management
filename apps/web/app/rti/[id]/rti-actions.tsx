'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RTI_DECISIONS, RTI_EXEMPTIONS, requiresExemption, type RtiDecision } from '@ksdc/contracts';
import type { RtiClock, RtiRequest } from '@/lib/api';
import { RTI_DECISION_LABEL, formatDate } from '@/lib/labels';
import { PUBLIC_API_URL } from '@/lib/public-api';
import { today } from '@/lib/today';

/**
 * Everything on an RTI file that writes.
 *
 * One client module rather than five, because these forms share the same posting and
 * error handling and there is no sense in five copies of it. What they do NOT share is the
 * shape of the decision: each one refuses in its own way, and each refusal is a sentence
 * the officer can act on rather than a red outline round a box.
 */

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${PUBLIC_API_URL}/v1/rti${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new Error(payload.message ?? 'That did not go through.');
  return payload as Record<string, unknown>;
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  async function run(fn: () => Promise<Record<string, unknown>>, refresh = true) {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      setWarnings(Array.isArray(out.warnings) ? (out.warnings as string[]) : []);
      if (refresh) router.refresh();
      return out;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, warnings, run, setError };
}

function Messages({ error, warnings }: { error: string | null; warnings: string[] }) {
  return (
    <>
      {error && <p className="rti-error">{error}</p>}
      {warnings.map((w) => (
        <div className="rti-warn" key={w}>
          {w}
        </div>
      ))}
    </>
  );
}

// ─── The decision ────────────────────────────────────────────────────────────

interface Ground {
  section: string;
  appliesTo: string;
  reasoning: string;
}

/**
 * The grounds picker offers section 8(1)(a) to (j) and section 9. It does not offer
 * section 11, and could not: the enum behind the column has no such value, so a refusal
 * under it cannot be composed, stored, or sent.
 *
 * The four clauses that actually arise on a dental council's files are listed first, with
 * the rest after a divider. Offering eleven clauses in statutory order to somebody looking
 * for the one about personal information is how the wrong one gets cited.
 */
const COMMON = RTI_EXEMPTIONS.filter((e) => e.commonHere);
const RARE = RTI_EXEMPTIONS.filter((e) => !e.commonHere);

export function DecisionForm({
  rtiRequestId,
  current,
}: {
  rtiRequestId: string;
  current: string | null;
}) {
  const { busy, error, warnings, run } = useAction();
  const [open, setOpen] = useState(!current);
  const [decision, setDecision] = useState<RtiDecision>((current as RtiDecision) ?? 'refused');
  const [decidedOn, setDecidedOn] = useState(today);
  const [reasons, setReasons] = useState('');
  const [grounds, setGrounds] = useState<Ground[]>([]);

  const needsGround = requiresExemption(decision);
  const chosen = RTI_EXEMPTIONS.find((e) => e.section === grounds[grounds.length - 1]?.section);

  if (!open) {
    return (
      <button type="button" className="link-like" onClick={() => setOpen(true)}>
        {current ? 'Change the decision' : 'Record the decision'}
      </button>
    );
  }

  return (
    <form
      className="rti-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() =>
          post(`/${rtiRequestId}/decide`, {
            decision,
            decidedOn,
            reasons: reasons || null,
            exemptions: needsGround ? grounds : [],
          }),
        );
      }}
    >
      <div className="two">
        <div>
          <label htmlFor="decision">Decision</label>
          <select
            id="decision"
            value={decision}
            onChange={(e) => setDecision(e.target.value as RtiDecision)}
          >
            {RTI_DECISIONS.map((d) => (
              <option value={d} key={d}>
                {RTI_DECISION_LABEL[d] ?? d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="decidedOn">Decided on</label>
          <input
            id="decidedOn"
            type="date"
            value={decidedOn}
            onChange={(e) => setDecidedOn(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label htmlFor="reasons">
          {needsGround ? 'The decision, in your own words' : 'The substance of the answer'}
        </label>
        <textarea id="reasons" value={reasons} onChange={(e) => setReasons(e.target.value)} />
      </div>

      {needsGround && (
        <>
          <p className="rti-hint">
            Information may be withheld only under section 8(1) or section 9. Section 11 is
            not on this list because it is not a ground: it is the procedure to follow before
            disclosing a third party&rsquo;s information, and a refusal resting on it is
            defective on its face.
          </p>

          {grounds.map((g, i) => (
            <div className="rti-ground" key={i}>
              <div>
                <label htmlFor={`section-${i}`}>Ground</label>
                <select
                  id={`section-${i}`}
                  value={g.section}
                  onChange={(e) => setGrounds(patch(grounds, i, { section: e.target.value }))}
                >
                  <optgroup label="Usually the ones that apply here">
                    {COMMON.map((e) => (
                      <option value={e.section} key={e.section}>
                        {e.cite} - {short(e.text)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="The rest of section 8(1), and section 9">
                    {RARE.map((e) => (
                      <option value={e.section} key={e.section}>
                        {e.cite} - {short(e.text)}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
              <Caution section={g.section} />
              <div>
                <label htmlFor={`applies-${i}`}>Which part of the request it answers</label>
                <input
                  id={`applies-${i}`}
                  type="text"
                  value={g.appliesTo}
                  onChange={(e) => setGrounds(patch(grounds, i, { appliesTo: e.target.value }))}
                  placeholder="Point 2, the treatment records"
                />
              </div>
              <div>
                <label htmlFor={`why-${i}`}>Why, on these facts</label>
                <textarea
                  id={`why-${i}`}
                  value={g.reasoning}
                  onChange={(e) => setGrounds(patch(grounds, i, { reasoning: e.target.value }))}
                  style={{ minHeight: 84 }}
                />
                <p className="rti-hint">
                  Section 7(8)(i) requires the reasons for the rejection. Naming the clause is
                  not a reason, and a refusal that gives none is set aside on appeal.
                </p>
              </div>
              <button
                type="button"
                className="link-like"
                onClick={() => setGrounds(grounds.filter((_, j) => j !== i))}
              >
                Remove this ground
              </button>
            </div>
          ))}

          <button
            type="button"
            className="link-like"
            onClick={() =>
              setGrounds([...grounds, { section: 's8_1_j', appliesTo: '', reasoning: '' }])
            }
          >
            Add a ground
          </button>
        </>
      )}

      <Messages error={error} warnings={warnings} />

      <div className="action-row">
        <button type="submit" disabled={busy}>
          {busy ? 'Recording\u2026' : 'Record the decision'}
        </button>
        {current && (
          <button type="button" className="link-like" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
      </div>
      {chosen ? null : null}
    </form>
  );
}

function Caution({ section }: { section: string }) {
  const clause = RTI_EXEMPTIONS.find((e) => e.section === section);
  if (!clause) return null;
  return (
    <>
      <p className="statute">&ldquo;{clause.text}&rdquo;</p>
      {clause.caution && <div className="rti-warn">{clause.caution}</div>}
    </>
  );
}

function patch(list: Ground[], i: number, change: Partial<Ground>): Ground[] {
  return list.map((g, j) => (i === j ? { ...g, ...change } : g));
}

function short(text: string): string {
  return text.length <= 64 ? text : `${text.slice(0, 63)}\u2026`;
}

// ─── The reply ───────────────────────────────────────────────────────────────

interface Draft {
  subject: string;
  body: string;
  defects: string[];
  correspondenceId: string;
}

/**
 * Compose, read, send.
 *
 * The defect list is deliberately the loudest thing here. Every item on it is something
 * the officer can fix in a minute, and every one of them is a ground of appeal if it goes
 * out unfixed - so it is shown above the letter rather than behind a validation error the
 * officer meets only at the moment they press send.
 */
export function ReplyPanel({
  rtiRequestId,
  despatchedOn,
  hasDecision,
}: {
  rtiRequestId: string;
  despatchedOn: string | null;
  hasDecision: boolean;
}) {
  const { busy, error, warnings, run } = useAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [despatchOn, setDespatchOn] = useState(today);
  const [despatchNo, setDespatchNo] = useState('');
  const [forceReason, setForceReason] = useState('');

  if (despatchedOn) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>The reply</h2>
          <span className="n">sent {formatDate(despatchedOn)}</span>
        </div>
        <div className="panel-body">
          <p className="rti-hint">
            Despatched on {formatDate(despatchedOn)}. An appeal under s.19(1) lies within
            thirty days of the applicant&rsquo;s receipt, and that period is condonable, so
            this file stays open to being reopened well past it.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel panel-consequential">
      <div className="panel-head">
        <h2>The reply</h2>
      </div>
      <div className="panel-body">
        {!hasDecision && (
          <p className="rti-hint">
            Record the decision first. The letter is assembled from it.
          </p>
        )}

        <div className="action-row">
          <button
            type="button"
            disabled={busy || !hasDecision}
            onClick={() => {
              void run(async () => {
                const out = await post(`/${rtiRequestId}/reply`, {});
                setDraft(out as unknown as Draft);
                return out;
              }, false);
            }}
          >
            {busy ? 'Composing\u2026' : draft ? 'Compose again' : 'Compose the reply'}
          </button>
        </div>

        {draft && (
          <>
            {draft.defects.length > 0 ? (
              <div className="rti-defects">
                <h3>
                  This letter is defective as it stands, and cannot be recorded as sent until
                  it is fixed.
                </h3>
                <ul>
                  {draft.defects.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rti-clean">
                The letter carries all three things section 7(8) requires: the reasons, the
                thirty days for an appeal, and the particulars of the First Appellate
                Authority.
              </div>
            )}

            <p className="meta">{draft.subject}</p>
            <div className="rti-letter">{draft.body}</div>

            <form
              className="rti-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  post(`/${rtiRequestId}/despatch`, {
                    despatchedOn: despatchOn,
                    correspondenceId: draft.correspondenceId,
                    despatchNo: despatchNo || null,
                    forceReason: forceReason || null,
                  }),
                );
              }}
            >
              <div className="two">
                <div>
                  <label htmlFor="despatchOn">Despatched on</label>
                  <input
                    id="despatchOn"
                    type="date"
                    value={despatchOn}
                    onChange={(e) => setDespatchOn(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="despatchNo">Outward despatch number, once stamped</label>
                  <input
                    id="despatchNo"
                    type="text"
                    value={despatchNo}
                    onChange={(e) => setDespatchNo(e.target.value)}
                    placeholder="From the office register"
                  />
                </div>
              </div>

              {draft.defects.length > 0 && (
                <div>
                  <label htmlFor="forceReason">
                    Sending it as it stands anyway? Say why.
                  </label>
                  <input
                    id="forceReason"
                    type="text"
                    value={forceReason}
                    onChange={(e) => setForceReason(e.target.value)}
                    placeholder="The Registrar directed that it go out today"
                  />
                  <p className="rti-hint">
                    The reason goes on the file and into the audit trail beside the letter.
                  </p>
                </div>
              )}

              <Messages error={error} warnings={warnings} />

              <div className="action-row">
                <button type="submit" disabled={busy}>
                  I have sent this
                </button>
              </div>
            </form>
          </>
        )}

        {!draft && <Messages error={error} warnings={warnings} />}
      </div>
    </section>
  );
}

// ─── Section 11, in the order the Act puts the steps ─────────────────────────

export function ThirdPartySteps({
  rtiRequestId,
  request,
  clock,
}: {
  rtiRequestId: string;
  request: RtiRequest;
  clock: RtiClock;
}) {
  const { busy, error, warnings, run } = useAction();
  const [name, setName] = useState('');
  const [sentOn, setSentOn] = useState(today);
  const [receivedOn, setReceivedOn] = useState('');
  const [repOn, setRepOn] = useState(today);
  const [objected, setObjected] = useState(true);
  const [note, setNote] = useState('');

  const intended = request.intends_to_disclose_third_party_on;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Third party (s.11)</h2>
      </div>
      <div className="panel-body">
        {!intended ? (
          <>
            <p className="rti-hint">
              Section 11 is engaged when this office <em>intends to disclose</em> information
              that relates to or was supplied by a third party and treated by them as
              confidential - not merely because a third party appears in the file. On these
              files a third party appears in every one, so recording the intention is a
              decision with a date on it, and it is what makes the forty-day period
              available at all.
            </p>
            <form
              className="rti-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  post(`/${rtiRequestId}/third-party`, {
                    action: 'intend',
                    thirdPartyName: name,
                    decidedOn: today,
                  }),
                );
              }}
            >
              <div>
                <label htmlFor="tpName">Whose information</label>
                <input
                  id="tpName"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Dr A. N. Other"
                />
              </div>
              <Messages error={error} warnings={warnings} />
              <div className="action-row">
                <button type="submit" disabled={busy || !name.trim()}>
                  I intend to disclose this
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="rti-step">
              <div className="what">Intention to disclose recorded</div>
              <div className="when">
                {formatDate(intended)} &middot; {request.third_party_name}. The deadline is now
                forty days from receipt, not thirty.
              </div>
            </div>

            <div className="rti-step">
              <div className="what">Notice under s.11(1)</div>
              {request.third_party_notice_sent_on ? (
                <div className="when">
                  Sent {formatDate(request.third_party_notice_sent_on)}
                  {request.third_party_notice_received_on
                    ? `, received by them ${formatDate(request.third_party_notice_received_on)}`
                    : ', receipt not yet recorded'}
                </div>
              ) : (
                <div className="undone">
                  Due within five days of receipt, by {formatDate(clock.thirdPartyNoticeDueOn)}
                </div>
              )}
              <form
                className="rti-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() =>
                    post(`/${rtiRequestId}/third-party`, {
                      action: 'notice',
                      sentOn,
                      receivedOn: receivedOn || null,
                    }),
                  );
                }}
              >
                <div className="two">
                  <div>
                    <label htmlFor="tpSent">Sent on</label>
                    <input
                      id="tpSent"
                      type="date"
                      value={sentOn}
                      onChange={(e) => setSentOn(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor="tpRecd">They received it on</label>
                    <input
                      id="tpRecd"
                      type="date"
                      value={receivedOn}
                      onChange={(e) => setReceivedOn(e.target.value)}
                    />
                  </div>
                </div>
                <p className="rti-hint">
                  Their ten days runs from <em>their</em> receipt, which this office learns
                  from the acknowledgement card. Until that date is entered there is no way
                  to know whether their window closes before or after the statutory deadline.
                </p>
                <div className="action-row">
                  <button type="submit" disabled={busy}>
                    Record the notice
                  </button>
                </div>
              </form>
            </div>

            {request.third_party_notice_sent_on && (
              <div className="rti-step">
                <div className="what">Representation under s.11(2)</div>
                {request.third_party_representation_on ? (
                  <div className="when">
                    {formatDate(request.third_party_representation_on)} &middot;{' '}
                    {request.third_party_objected ? 'objected' : 'no objection'}
                    {request.third_party_representation_note
                      ? ` - ${request.third_party_representation_note}`
                      : ''}
                  </div>
                ) : (
                  <>
                    <div className="undone">
                      {clock.thirdPartyRepresentationDueOn
                        ? `They may reply until ${formatDate(clock.thirdPartyRepresentationDueOn)}`
                        : 'Cannot be computed until their date of receipt is recorded'}
                    </div>
                    <form
                      className="rti-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(() =>
                          post(`/${rtiRequestId}/third-party`, {
                            action: 'representation',
                            receivedOn: repOn,
                            objected,
                            note: note || null,
                          }),
                        );
                      }}
                    >
                      <div className="two">
                        <div>
                          <label htmlFor="repOn">Received on</label>
                          <input
                            id="repOn"
                            type="date"
                            value={repOn}
                            onChange={(e) => setRepOn(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="objected">Their position</label>
                          <select
                            id="objected"
                            value={objected ? 'yes' : 'no'}
                            onChange={(e) => setObjected(e.target.value === 'yes')}
                          >
                            <option value="yes">Objects to disclosure</option>
                            <option value="no">No objection</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label htmlFor="repNote">What they said</label>
                        <textarea
                          id="repNote"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          style={{ minHeight: 84 }}
                        />
                      </div>
                      <div className="action-row">
                        <button type="submit" disabled={busy}>
                          Record it
                        </button>
                      </div>
                    </form>
                  </>
                )}
              </div>
            )}

            <Messages error={error} warnings={warnings} />
          </>
        )}
      </div>
    </section>
  );
}

// ─── The fee, and the transfer ───────────────────────────────────────────────

export function FeeAndTransfer({
  rtiRequestId,
  request,
}: {
  rtiRequestId: string;
  request: RtiRequest;
}) {
  const { busy, error, warnings, run } = useAction();
  const [amount, setAmount] = useState('');
  const [intimatedOn, setIntimatedOn] = useState(today);
  const [paidOn, setPaidOn] = useState(today);
  const [authority, setAuthority] = useState('');
  const [transferredOn, setTransferredOn] = useState(today);
  const [showTransfer, setShowTransfer] = useState(false);

  const done = Boolean(request.reply_despatched_on || request.transferred_on);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Fee and transfer</h2>
      </div>
      <div className="panel-body">
        {request.transferred_on ? (
          <p className="rti-hint">
            Transferred to {request.transferred_to} on {formatDate(request.transferred_on)}.
            That authority answers within thirty days of its own receipt.
          </p>
        ) : request.further_fee_intimated_on && !request.further_fee_paid_on ? (
          <form
            className="rti-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => post(`/${rtiRequestId}/fee`, { action: 'paid', paidOn }));
            }}
          >
            <p className="rti-hint">
              Rs {request.further_fee_amount} intimated on{' '}
              {formatDate(request.further_fee_intimated_on)}. The clock is excluded under
              s.7(3)(a) until it is paid, so the deadline shown on this file is earlier than
              the true one.
            </p>
            <div>
              <label htmlFor="paidOn">Paid on</label>
              <input
                id="paidOn"
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </div>
            <div className="action-row">
              <button type="submit" disabled={busy}>
                Record the payment
              </button>
            </div>
          </form>
        ) : request.further_fee_paid_on ? (
          <p className="rti-hint">
            Rs {request.further_fee_amount} intimated{' '}
            {formatDate(request.further_fee_intimated_on)} and paid{' '}
            {formatDate(request.further_fee_paid_on)}. That period is excluded from the thirty
            days.
          </p>
        ) : (
          !done && (
            <form
              className="rti-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  post(`/${rtiRequestId}/fee`, {
                    action: 'intimate',
                    amount: Number(amount),
                    intimatedOn,
                  }),
                );
              }}
            >
              <p className="rti-hint">
                A further fee under s.7(3) is the only thing in the Act that stops the clock.
                A demand sent after the period has already expired is void under s.7(6) and is
                itself a ground of complaint, so this will refuse one.
              </p>
              <div className="two">
                <div>
                  <label htmlFor="amount">Amount, in rupees</label>
                  <input
                    id="amount"
                    type="number"
                    min="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="intimatedOn">Intimation despatched on</label>
                  <input
                    id="intimatedOn"
                    type="date"
                    value={intimatedOn}
                    onChange={(e) => setIntimatedOn(e.target.value)}
                  />
                </div>
              </div>
              <div className="action-row">
                <button type="submit" disabled={busy || !amount}>
                  Record the fee intimation
                </button>
              </div>
            </form>
          )
        )}

        {!done && !showTransfer && (
          <button type="button" className="link-like" onClick={() => setShowTransfer(true)}>
            This belongs to another public authority (s.6(3))
          </button>
        )}

        {!done && showTransfer && (
          <form
            className="rti-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                post(`/${rtiRequestId}/transfer`, {
                  toAuthority: authority,
                  transferredOn,
                }),
              );
            }}
          >
            <p className="rti-hint">
              Section 6(3) allows five days from receipt. A later transfer is still lawful,
              but the delay up to the date of transfer stays with this office.
            </p>
            <div>
              <label htmlFor="authority">Transferred to</label>
              <input
                id="authority"
                type="text"
                value={authority}
                onChange={(e) => setAuthority(e.target.value)}
                placeholder="Dental Council of India"
              />
            </div>
            <div>
              <label htmlFor="transferredOn">On</label>
              <input
                id="transferredOn"
                type="date"
                value={transferredOn}
                onChange={(e) => setTransferredOn(e.target.value)}
              />
            </div>
            <div className="action-row">
              <button type="submit" disabled={busy || !authority.trim()}>
                Record the transfer
              </button>
              <button type="button" className="link-like" onClick={() => setShowTransfer(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        <Messages error={error} warnings={warnings} />
      </div>
    </section>
  );
}
