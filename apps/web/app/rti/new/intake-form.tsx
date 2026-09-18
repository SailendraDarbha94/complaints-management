'use client';

import { useState } from 'react';
import { PUBLIC_API_URL } from '@/lib/public-api';
import { today } from '@/lib/today';
import { BusyButton } from '../../components/busy-button';
import { PendingLink } from '../../components/pending-link';
import { useAction } from '../../components/use-action';

interface Received {
  rtiRequestId: string;
  rtiNo: string;
  dueOn: string;
  warnings: string[];
}

export function RtiIntakeForm() {
  const action = useAction();
  const [receivedOn, setReceivedOn] = useState(today);
  const [receivedVia, setReceivedVia] = useState('email');
  const [applicantName, setApplicantName] = useState('');
  const [address, setAddress] = useState('');
  const [applicantEmail, setApplicantEmail] = useState('');
  const [applicantPhone, setApplicantPhone] = useState('');
  const [requestText, setRequestText] = useState('');
  const [externalRefNo, setExternalRefNo] = useState('');
  const [feeReceived, setFeeReceived] = useState(true);
  const [isBpl, setIsBpl] = useState(false);
  const [lifeOrLiberty, setLifeOrLiberty] = useState(false);
  const [lifeReason, setLifeReason] = useState('');
  const [done, setDone] = useState<Received | null>(null);

  // The clock has already been running if this came by post. Say so while they type.
  const elapsed = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${receivedOn}T00:00:00Z`)) / 86_400_000,
  );

  function submit(e: React.FormEvent) {
    e.preventDefault();
    action.run(
      async () => {
        const res = await fetch(`${PUBLIC_API_URL}/v1/rti`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            receivedOn,
            receivedVia,
            applicantName,
            applicantAddressLines: address.split('\n').map((l) => l.trim()).filter(Boolean),
            applicantEmail: applicantEmail || null,
            applicantPhone: applicantPhone || null,
            requestText,
            externalRefNo: externalRefNo || null,
            applicationFeeReceived: feeReceived,
            isBpl,
            lifeOrLiberty,
            lifeOrLibertyReason: lifeOrLiberty ? lifeReason : null,
            dateSource: elapsed > 0 ? 'recorded' : 'recorded',
          }),
        });
        const payload = (await res.json().catch(() => ({}))) as Received & { message?: string };
        if (!res.ok) throw new Error(payload.message ?? 'That did not go through.');
        return payload;
      },
      // The form gives way to the RTI number in the same render as the refresh, so the button
      // spins until there is something else on screen - a second press would be a second file.
      (payload, router) => {
        setDone(payload);
        router.refresh();
      },
    );
  }

  if (done) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Entered as {done.rtiNo}</h2>
        </div>
        <div className="panel-body">
          <p className="rti-hint">
            The reply must be dispatched by <strong>{done.dueOn}</strong>. Two reminders are
            now on the Today screen: the working task, and the statutory date itself.
          </p>
          {done.warnings.map((w) => (
            <div className="rti-warn" key={w}>
              {w}
            </div>
          ))}
          <div className="action-row">
            <PendingLink className="action" href={`/rti/${done.rtiRequestId}`}>
              Open the file
            </PendingLink>
            <PendingLink className="link-like" href="/rti">
              Back to the register
            </PendingLink>
          </div>
        </div>
      </section>
    );
  }

  return (
    <form className="panel" onSubmit={submit}>
      <div className="panel-body">
        <div className="rti-form">
          <div className="two">
            <div>
              <label htmlFor="receivedOn">Received in this office on</label>
              <input
                id="receivedOn"
                type="date"
                value={receivedOn}
                max={today}
                onChange={(e) => setReceivedOn(e.target.value)}
                required
              />
              {elapsed > 0 && (
                <p className="rti-hint">
                  {elapsed} {elapsed === 1 ? 'day' : 'days'} of the thirty have already run.
                  The clock starts from this date, not from today.
                </p>
              )}
            </div>
            <div>
              <label htmlFor="receivedVia">How it arrived</label>
              <select
                id="receivedVia"
                value={receivedVia}
                onChange={(e) => setReceivedVia(e.target.value)}
              >
                <option value="email">By email</option>
                <option value="post">By post</option>
                <option value="by_hand">By hand</option>
                <option value="transferred_in">Transferred to us by another authority</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div className="two">
            <div>
              <label htmlFor="applicantName">Applicant</label>
              <input
                id="applicantName"
                type="text"
                value={applicantName}
                onChange={(e) => setApplicantName(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="externalRefNo">Their reference, if any</label>
              <input
                id="externalRefNo"
                type="text"
                value={externalRefNo}
                onChange={(e) => setExternalRefNo(e.target.value)}
                placeholder="Postal registration or portal number"
              />
            </div>
          </div>

          <div>
            <label htmlFor="address">Address for the reply, one line per line</label>
            <textarea
              id="address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              style={{ minHeight: 84 }}
            />
          </div>

          <div className="two">
            <div>
              <label htmlFor="applicantEmail">Email</label>
              <input
                id="applicantEmail"
                type="email"
                value={applicantEmail}
                onChange={(e) => setApplicantEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="applicantPhone">Phone</label>
              <input
                id="applicantPhone"
                type="text"
                value={applicantPhone}
                onChange={(e) => setApplicantPhone(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label htmlFor="requestText">What they asked for, in their words</label>
            <textarea
              id="requestText"
              value={requestText}
              onChange={(e) => setRequestText(e.target.value)}
              style={{ minHeight: 180 }}
              required
            />
            <p className="rti-hint">
              Paste the email, or type the letter. Not a summary: the scope of the request
              is what every later argument turns on, and a summary would be the office&rsquo;s
              account of the question it then answered.
            </p>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={feeReceived}
              onChange={(e) => setFeeReceived(e.target.checked)}
            />
            <span>
              The ten-rupee application fee came with it. If it did not, log the application
              anyway - the authority is contradictory on whether that makes it invalid, and
              the safe reading is that the clock runs either way.
            </span>
          </label>

          <label className="check">
            <input type="checkbox" checked={isBpl} onChange={(e) => setIsBpl(e.target.checked)} />
            <span>
              The applicant states they are below the poverty line. No fee of any kind is
              then payable (proviso to s.7(5)).
            </span>
          </label>

          <label className="check">
            <input
              type="checkbox"
              checked={lifeOrLiberty}
              onChange={(e) => setLifeOrLiberty(e.target.checked)}
            />
            <span>
              This concerns the life or liberty of a person, and the reply is due within
              forty-eight hours.
            </span>
          </label>

          {lifeOrLiberty && (
            <div>
              <label htmlFor="lifeReason">
                Why this office accepts that claim
              </label>
              <textarea
                id="lifeReason"
                value={lifeReason}
                onChange={(e) => setLifeReason(e.target.value)}
                style={{ minHeight: 84 }}
                required
              />
              <p className="rti-hint">
                The claim is made by the applicant; accepting it is a decision of this
                office, and the proviso to s.7(1) applies only on demonstrably proven danger.
              </p>
            </div>
          )}

          {action.error && <p className="rti-error">{action.error}</p>}

          <div className="action-row">
            <BusyButton
              type="submit"
              busy={action.pending}
              busyLabel={'Entering\u2026'}
              disabled={!applicantName.trim() || !requestText.trim()}
            >
              Enter in the register
            </BusyButton>
          </div>
        </div>
      </div>
    </form>
  );
}
