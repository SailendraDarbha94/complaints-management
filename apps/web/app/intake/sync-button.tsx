'use client';

import { useState } from 'react';
import { PUBLIC_API_URL } from '@/lib/public-api';
import { BusyButton } from '@/app/components/busy-button';
import { useAction } from '@/app/components/use-action';

/**
 * "Check now."
 *
 * The reader polls every half minute on its own. This is for the moment just after you
 * have forwarded something and would rather not wait for the timer.
 */
export function SyncButton() {
  const { pending, error, run } = useAction();
  const [said, setSaid] = useState<string | null>(null);

  function sync() {
    setSaid(null);
    run(
      async () => {
        const res = await fetch(`${PUBLIC_API_URL}/v1/intake/sync`, {
          method: 'POST',
          credentials: 'include',
        });
        const payload = (await res.json().catch(() => ({}))) as {
          message?: string;
          ingested?: number;
          filed?: number;
        };
        if (!res.ok) throw new Error(payload.message ?? 'Could not reach the mailbox.');

        return payload.ingested
          ? `${payload.ingested} new${payload.filed ? `, ${payload.filed} filed automatically` : ''}`
          : 'Nothing new.';
      },
      // The tally and the new cards arrive together: "2 new" above a tray that does not
      // yet show them reads as a miscount.
      (tally, router) => {
        setSaid(tally);
        router.refresh();
      },
    );
  }

  return (
    <div>
      <BusyButton type="button" className="action" busy={pending} busyLabel="Checking…" onClick={sync}>
        Check for new mail
      </BusyButton>
      {said && <p className="action-why">{said}</p>}
      {error && <p className="rti-error">{error}</p>}
    </div>
  );
}
