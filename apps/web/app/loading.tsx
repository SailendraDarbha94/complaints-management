import { Spinner } from './components/spinner';

/**
 * Shown the moment a page is asked for, until it arrives.
 *
 * Every page reads the register fresh on each visit, which takes a second or two. Without
 * this, the previous page stayed on screen looking finished, and the officer had no way to
 * tell a slow page from a click that had not registered.
 */
export default function Loading() {
  return (
    <main className="shell">
      <div className="page-loading">
        <Spinner label="Loading" />
        <span aria-hidden="true">Loading&hellip;</span>
      </div>
    </main>
  );
}
