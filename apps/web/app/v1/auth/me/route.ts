import { withAuth } from '@/lib/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withAuth(async ({ identity }) => {
  return {
    user: { id: identity.userId, email: identity.email, name: identity.name },
    council: { councilId: identity.councilId, role: identity.role },
  };
});
