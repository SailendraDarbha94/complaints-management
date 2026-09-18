/**
 * The one "please wait" mark, used everywhere something has been set in motion.
 *
 * Added after the officer found that nothing on screen changed for the second or two a
 * page or a save takes - long enough to click again, and a second click on "Open a case"
 * or "Record the dispatch" is a second write. It inherits the colour of whatever it sits
 * in, so the same mark works in a filled button, a text link and a page body.
 *
 * Decorative by default: the button or link it sits in says what is happening in words
 * ("Adding…", aria-busy). Give it a label only when it stands alone.
 */
export function Spinner({ label }: { label?: string }) {
  return label ? (
    <span className="spinner" role="status" aria-label={label} />
  ) : (
    <span className="spinner" aria-hidden="true" />
  );
}
