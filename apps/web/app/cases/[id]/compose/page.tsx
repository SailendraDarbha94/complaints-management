import { notFound, redirect } from 'next/navigation';
import { PendingLink } from '@/app/components/pending-link';
import { PUBLIC_API_URL, fetchCase, fetchTemplates, isUnauthorized } from '@/lib/api';
import { LETTER_LABEL, label } from '@/lib/labels';
import { Composer } from './composer';

export const dynamic = 'force-dynamic';

/**
 * Drafting a letter.
 *
 * Phase 1 sends nothing. The officer copies the draft into council webmail and comes back
 * to confirm it went — and that confirmation is the click that starts the five-to-seven
 * day clock, so it is the most consequential button on the screen.
 */
export default async function ComposePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let data, templates;
  try {
    [data, templates] = await Promise.all([fetchCase(id), fetchTemplates()]);
  } catch (err) {
    if (isUnauthorized(err)) redirect('/signin');
    throw err;
  }
  if (!data.case) notFound();

  const c = data.case;

  // Only letters that make sense for this case. Offering an ethics notice on a patient
  // complaint, or a hearing summons before Phase 4 exists, is an invitation to send
  // something the register cannot then explain.
  const relevant = templates.templates.filter((t) => {
    if (t.kind === 'inbound' || t.kind === 'other') return false;
    if (t.kind.startsWith('ethics_')) return c.case_kind === 'ethics_notice';
    if (t.kind.startsWith('summons_') || t.kind === 'member_intimation') return false;
    if (t.kind.startsWith('order_') || t.kind === 'expert_report_share') return false;
    if (t.kind === 'rti_reply_cover' || t.kind === 'reply_to_referring_authority') return false;
    if (c.case_kind === 'ethics_notice' && !t.kind.startsWith('ethics_')) return false;
    return true;
  });

  return (
    <main className="shell">
      <nav className="crumbs">
        <PendingLink href="/today">Today</PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href="/cases">Cases</PendingLink>
        <span aria-hidden="true">/</span>
        <PendingLink href={`/cases/${c.id}`}>{c.case_number}</PendingLink>
        <span aria-hidden="true">/</span>
        <span className="here">Draft a letter</span>
      </nav>

      <header className="case-head">
        <div>
          <h1>Draft a letter</h1>
          <p className="case-summary">
            {c.case_number} — {c.summary}
          </p>
        </div>
      </header>

      <Composer
        caseId={c.id}
        apiUrl={PUBLIC_API_URL}
        templates={relevant.map((t) => ({
          kind: t.kind,
          name: label(LETTER_LABEL, t.kind),
          requiresRegistrarSignature: t.requires_registrar_signature,
        }))}
        respondents={data.respondents
          .filter((r) => !r.dropped_at)
          .map((r) => ({ id: r.id, name: r.full_name, noticeCount: r.notice_count }))}
      />
    </main>
  );
}
