/**
 * Where an "Open" link for a document on a case points.
 *
 * `?open=1` asks the download route for the file itself (a redirect to the signed link)
 * rather than the JSON an API caller gets - without it, a browser following the link shows
 * the JSON as a line of text. Every page that links to a document uses this, so none of
 * them can forget the flag again.
 */
export function documentOpenHref(apiUrl: string, documentId: string): string {
  return `${apiUrl}/v1/documents/${encodeURIComponent(documentId)}/download?open=1`;
}
