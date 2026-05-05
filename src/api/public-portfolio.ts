import { Hono } from 'hono';
import { existsSync } from 'fs';
import { join } from 'path';
import { db } from '../db/index.js';

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

  const items = companies.map((pc) => {
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
