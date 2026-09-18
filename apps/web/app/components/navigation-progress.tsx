'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * A thin bar across the top of the window while the next page is on its way.
 *
 * The backstop for PendingLink: it covers every in-app link, including any rendered
 * without a spinner of its own, and it is visible wherever the officer happens to be
 * looking. It starts on the click and stops when the address changes - which in the App
 * Router is when the new page (or its loading screen) is committed.
 *
 * Deliberately NOT started for: new tabs and modifier-clicks, downloads, other sites,
 * the API (document downloads live under /v1), and links to the page already showing.
 * None of those change the address here, so a bar started for them would never stop.
 * For anything else that never arrives, it gives up after twenty seconds.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [active, setActive] = useState(false);

  // Arrived.
  useEffect(() => {
    setActive(false);
  }, [pathname, search]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a') : null;
      if (!a || !a.href) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download')) return;

      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin) return;
      if (to.pathname.startsWith('/v1/')) return;
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;

      setActive(true);
    }
    // Capture phase: next/link calls preventDefault() to navigate client-side, so a
    // bubbling listener cannot tell a navigation from a cancelled click.
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  useEffect(() => {
    if (!active) return;
    const giveUp = setTimeout(() => setActive(false), 20_000);
    return () => clearTimeout(giveUp);
  }, [active]);

  return <div className={active ? 'nav-progress active' : 'nav-progress'} aria-hidden="true" />;
}
