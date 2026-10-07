'use client';

import { useState } from 'react';
import type { Route } from 'next';
import { BusyButton } from '@/app/components/busy-button';
import { useAction } from '@/app/components/use-action';

/**
 * Pick a month to look at.
 *
 * A form rather than a bare <input type="month"> that navigates on change: browsers fire
 * change as each part of the date is typed, and a page that reloads after the year but
 * before the month has been entered is a page fighting its user. The navigation runs
 * through useAction, so "Show" stays busy until the chosen month is on screen.
 */
export function MonthPicker({ month, latest }: { month: string; latest: string }) {
  const [value, setValue] = useState(month);
  const action = useAction();

  return (
    <form
      className="month-picker"
      onSubmit={(e) => {
        e.preventDefault();
        if (!/^\d{4}-\d{2}$/.test(value)) return;
        action.run(
          async () => value,
          (chosen, router) => router.push(`/intake/assistant?month=${chosen}` as Route),
        );
      }}
    >
      <label htmlFor="report-month">Month</label>
      <input
        id="report-month"
        type="month"
        value={value}
        max={latest}
        onChange={(e) => setValue(e.target.value)}
      />
      <BusyButton
        type="submit"
        className="action"
        busy={action.pending}
        busyLabel="Showing…"
        disabled={value === month}
      >
        Show
      </BusyButton>
    </form>
  );
}
