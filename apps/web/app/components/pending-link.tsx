'use client';

import Link, { useLinkStatus, type LinkProps } from 'next/link';
import type { ReactNode } from 'react';
import { Spinner } from './spinner';

function PendingMark() {
  // True from the click until the next page is on screen. Only meaningful inside a Link.
  const { pending } = useLinkStatus();
  return pending ? <Spinner /> : null;
}

/**
 * next/link, plus a spinner beside the text from the moment it is clicked.
 *
 * Every page here is rendered on request from the database, so following a link takes a
 * second or two, and in development - where Next.js prefetches nothing - every time. The
 * spinner sits on the very thing that was clicked, which is where the eye already is.
 * Use it for every in-app link; a plain <a> for files and anything outside the app.
 *
 * Generic over the route, like Link itself: typedRoutes is on, and fixing the type
 * parameter (ComponentProps<typeof Link>) would reject every dynamic href such as
 * `/cases/${id}` while still accepting nothing the real Link would not.
 */
export function PendingLink<RouteType>({
  children,
  ...props
}: LinkProps<RouteType> & { children?: ReactNode }) {
  return (
    <Link<RouteType> {...props}>
      {children}
      <PendingMark />
    </Link>
  );
}
