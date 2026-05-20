#!/usr/bin/env node
// Flip the topnav from black to white across all marketing pages.
// Idempotent — skips files where the nav already looks white.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.argv[2] || '.');
const FILES = [
  'public/styles/matcap.css',
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

// Each rule: a regex that matches the original (black) declaration block, and the (white) replacement.
// Whitespace-tolerant. We only touch nav.topnav* selectors.
const RULES = [
  // nav.topnav { ... background:#000; color:#fff; ... border-bottom:2px solid var(--accent); ... }
  [
    /(nav\.topnav\{[^}]*?)background:#000;\s*color:#fff;/g,
    '$1background:#fff;color:#000;',
  ],
  [
    /(nav\.topnav\{[^}]*?)border-bottom:2px solid var\(--accent\);/g,
    '$1border-bottom:1px solid var(--rule);',
  ],
  // .brand: color:#fff -> color:#000
  [
    /(nav\.topnav \.brand\{[^}]*?)color:#fff(\b)/g,
    '$1color:#000$2',
  ],
  // .tag: border-left:1px solid #333 -> border-left:1px solid var(--rule)
  [
    /(nav\.topnav \.tag\{[^}]*?)border-left:1px solid #333/g,
    '$1border-left:1px solid var(--rule)',
  ],
  // .links a: color:#fff -> color:#000 (the bare links text, not the button which is overridden)
  [
    /(nav\.topnav \.links a\{[^}]*?)color:#fff/g,
    '$1color:#000',
  ],
  // .links a.btn: background:var(--accent);color:#000 -> background:#000;color:#fff
  [
    /(nav\.topnav \.links a\.btn\{[^}]*?)background:var\(--accent\);color:#000/g,
    '$1background:#000;color:#fff',
  ],
  // .links a.btn:hover: background:#fff;color:#000 -> background:var(--accent);color:#000
  [
    /(nav\.topnav \.links a\.btn:hover\{[^}]*?)background:#fff;color:#000/g,
    '$1background:var(--accent);color:#000',
  ],
];

let updated = 0, skipped = 0;

for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.log(`MISSING ${rel}`);
    continue;
  }
  let src = fs.readFileSync(full, 'utf8');
  const before = src;

  for (const [re, sub] of RULES) {
    src = src.replace(re, sub);
  }

  if (src === before) {
    console.log(`SKIP    ${rel} (no black-nav patterns matched)`);
    skipped++;
    continue;
  }

  fs.writeFileSync(full, src, 'utf8');
  console.log(`OK      ${rel}`);
  updated++;
}

console.log(`\nDone. ${updated} updated, ${skipped} skipped.`);
