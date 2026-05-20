#!/usr/bin/env node
// Trim the Case Studies dropdown in the topnav to only show the 3 stealth
// case studies + "View all". Idempotent — runs against the existing cs-menu
// block (added by add-case-studies-nav.js) and replaces its inner items.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.argv[2] || '.');
const FILES = [
  'public/index.html',
  'public/investors.html',
  'public/community.html',
  'public/intros.html',
  'public/case-studies.html',
  'public/case-studies/rosotics.html',
  'public/case-studies/autio.html',
  'public/case-studies/peachpay.html',
  'public/case-studies/insured-nomads.html',
  'public/case-studies/othersideai.html',
  'public/case-studies/kalendar-ai.html',
  'public/case-studies/stealth-vertical-ai.html',
  'public/case-studies/stealth-proptech.html',
  'public/case-studies/stealth-300k.html',
  'public/yc.html',
  'public/project2045.html',
  'public/equity-calculator.html',
  'public/raise-planner.html',
];

const NEW_ITEMS = `
        <a href="/case-studies/stealth-vertical-ai"><span>Stealth · Vertical AI</span><span class="raise">$1.5M</span></a>
        <a href="/case-studies/stealth-proptech"><span>Stealth · PropTech</span><span class="raise">$600K</span></a>
        <a href="/case-studies/stealth-300k"><span>Stealth · Verdict</span><span class="raise">$300K</span></a>
        <a href="/case-studies" class="view-all">View all →</a>
      `;

let updated = 0, skipped = 0;

for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  let src = fs.readFileSync(full, 'utf8');

  // Find cs-menu block: <div class="cs-menu"> ... </div>
  const re = /(<div class="cs-menu">)([\s\S]*?)(<\/div>)/;
  const m = src.match(re);
  if (!m) {
    console.log(`SKIP    ${rel} (no cs-menu)`);
    skipped++;
    continue;
  }
  // Check if already trimmed
  if (m[2].includes('rosotics') === false && m[2].includes('othersideai') === false) {
    console.log(`SKIP    ${rel} (already trimmed)`);
    skipped++;
    continue;
  }
  src = src.replace(re, m[1] + NEW_ITEMS + m[3]);
  fs.writeFileSync(full, src, 'utf8');
  console.log(`OK      ${rel}`);
  updated++;
}

console.log(`\nDone. ${updated} updated, ${skipped} skipped.`);
