/**
 * The sentence in an error response, not the response. The routes answer with JSON -
 * {"statusCode": 500, "message": "..."} - and a page that showed the body as it came put
 * that JSON in front of the officer. A body that is not JSON is kept as it is.
 */
export function errorMessageOf(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown } | null;
    if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message;
  } catch {
    // Not JSON: a proxy's error page, or plain text.
  }
  return body.trim() || fallback;
}
