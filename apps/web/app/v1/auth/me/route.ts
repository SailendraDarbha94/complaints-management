import { ROLES } from '@ksdc/contracts';
import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Who is signed in, for which council, as what.
 *
 * Open to every role, not only the officer: it is how the website knows to show a
 * committee member or an auditor the page that sends them to the phone app, and that page
 * has to say who they are signed in as. It carries nothing from the register.
 */
export const GET = withAuth(
  async ({ identity }) => {
    return {
      user: { id: identity.userId, email: identity.email, name: identity.name },
      council: { councilId: identity.councilId, role: identity.role },
    };
  },
  { roles: ROLES },
);
