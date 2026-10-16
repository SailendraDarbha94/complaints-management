import { redirect } from 'next/navigation';
import { fetchSession, isUnauthorized, type Session } from './api';

/**
 * Who may use the website, decided once, before a page fetches anything.
 *
 * The website is the dental officer's. A committee member or an auditor reads cases in the
 * KSDC phone app, which shows them what migration 0010 grants - the case, the parties'
 * names, the respondents, the milestones and the documents - and leaves out what this
 * website is built around: the officer's chase list, letters and drafts, notes, and the
 * complainant's phone number and email. The API refuses them every route that reads or
 * changes the register (lib/route.ts), so a page fetched for them would only fail; this
 * makes it one plain page instead, and makes sure nothing is asked for first.
 *
 * Every page calls it (through app/components/officer-only.tsx) before its own fetches,
 * and lib/website-access.test.ts fails any page that does not. Not the layout: a layout
 * and its page render side by side, so a check there cannot stop the page's fetches from
 * going out.
 */

export const WEBSITE_NOTICE =
  "This website is for the Council's dental officer. Committee members read cases in the KSDC phone app.";

export type WebsiteAccess =
  | { officer: true; session: Session }
  | { officer: false; session: Session; signedInAs: string; notice: string };

/** The decision itself, on a session already in hand. Anything but 'officer' is turned away. */
export function accessFor(session: Session): WebsiteAccess {
  if (session.council.role === 'officer') return { officer: true, session };
  const { name, email } = session.user;
  return {
    officer: false,
    session,
    signedInAs: name && name !== email ? `${name} (${email})` : email,
    notice: WEBSITE_NOTICE,
  };
}

/**
 * Ask who is signed in, and decide. Not signed in goes to /signin, as every page already
 * did; any other failure is thrown for the page's error handling, as theirs were.
 */
export async function websiteAccess(): Promise<WebsiteAccess> {
  let session: Session;
  try {
    session = await fetchSession();
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }
  return accessFor(session);
}
