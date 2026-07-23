import { Hono } from 'hono';
import { existsSync } from 'fs';
import { join } from 'path';
import { db, onboardingWorkflows, OnboardingStatus } from '../db/index.js';

const app = new Hono();

const CASE_STUDIES_DIR = './public/case-studies';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

app.get('/', async (c) => {
  const companies = await db.query.portfolioCompanies.findMany({
    with: { founder: true },
    orderBy: (pc, { desc }) => [desc(pc.currentValuation)],
  });

  // A portfolio row is created the moment an application is approved — long
  // before the founder actually signs equity and closes. Only publicly list a
  // company once its equity agreement is signed (or beyond), plus legacy
  // companies that predate the onboarding flow (no workflow at all). Anything
  // earlier in onboarding stays private until the equity docs are signed.
  const STATUS_ORDER = Object.values(OnboardingStatus) as string[];
  const PUBLIC_THRESHOLD = STATUS_ORDER.indexOf(OnboardingStatus.EQUITY_AGREEMENT_SIGNED);

  const workflows = await db
    .select({ pcId: onboardingWorkflows.portfolioCompanyId, status: onboardingWorkflows.status })
    .from(onboardingWorkflows);
  const wfStatusByPc = new Map(workflows.map((w) => [w.pcId, w.status]));

  const items = companies
    .filter((pc) => {
      const st = wfStatusByPc.get(pc.id);
      if (st == null) return true; // legacy company, no onboarding workflow
      const rank = STATUS_ORDER.indexOf(st);
      return rank >= 0 && rank >= PUBLIC_THRESHOLD;
    })
    .map((pc) => {
    const f = pc.founder;
    const isStealth = !!f?.hidden;
    const displayName = isStealth ? 'Stealth Company' : (f?.companyName || 'Company');

    let caseStudySlug: string | null = null;
    if (!isStealth && f?.companyName) {
      const slug = slugify(f.companyName);
      if (slug && existsSync(join(CASE_STUDIES_DIR, `${slug}.html`))) {
        caseStudySlug = slug;
      }
    }

    return {
      name: displayName,
      one_liner: pc.oneLiner || null,
      is_stealth: isStealth,
      case_study_slug: caseStudySlug,
    };
  });

  c.header('Cache-Control', 'public, max-age=60');
  return c.json({ count: items.length, items });
});

export default app;
