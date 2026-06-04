#!/usr/bin/env node
// One-off: insert the Investor Matcher link into existing tools-menu blocks
// across all marketing pages (including matcap.css for the pages that share
// that stylesheet). Idempotent — skips pages that already have the link.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.argv[2] || '.');

const FILES = [
  // Pages with inline tools-menu markup (per scripts/add-tools-nav.js list)
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

let updated = 0, skipped = 0;
const NEW_LINK = '        <a href="/investor-matcher">Investor Matcher</a>\n';

for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) continue;
  let src = fs.readFileSync(full, 'utf8');

  if (src.includes('/investor-matcher')) {
    console.log(`SKIP    ${rel} (already has Investor Matcher)`);
    skipped++;
    continue;
  }

  // Find <div class="tools-menu">\n...        <a href="/equity-calculator"
  // and insert the new link BEFORE the equity-calculator line.
  const marker = '<a href="/equity-calculator">Equity Calculator</a>';
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.log(`SKIP    ${rel} (no equity-calculator link found)`);
    skipped++;
    continue;
  }
  // Walk back to start of that line (preserve indent)
  let lineStart = src.lastIndexOf('\n', idx) + 1;
  src = src.slice(0, lineStart) + NEW_LINK + src.slice(lineStart);
  fs.writeFileSync(full, src, 'utf8');
  console.log(`OK      ${rel}`);
  updated++;
}

// Nodes (Tailwind variant) — different markup
const nodesPath = path.join(ROOT, 'public/nodes.html');
if (fs.existsSync(nodesPath)) {
  let src = fs.readFileSync(nodesPath, 'utf8');
  if (src.includes('/investor-matcher')) {
    console.log('SKIP    public/nodes.html (already has Investor Matcher)');
    skipped++;
  } else {
    const tailwindMarker = '<a href="/equity-calculator" class="block px-4 py-2 text-sm text-slate-300 hover:text-white hover:bg-white/5">Equity Calculator</a>';
    const idx = src.indexOf(tailwindMarker);
    if (idx === -1) {
      console.log('SKIP    public/nodes.html (no Tailwind equity-calculator link found)');
      skipped++;
    } else {
      let lineStart = src.lastIndexOf('\n', idx) + 1;
      const tailwindLink = '            <a href="/investor-matcher" class="block px-4 py-2 text-sm text-slate-300 hover:text-white hover:bg-white/5">Investor Matcher</a>\n';
      src = src.slice(0, lineStart) + tailwindLink + src.slice(lineStart);
      fs.writeFileSync(nodesPath, src, 'utf8');
      console.log('OK      public/nodes.html (Tailwind)');
      updated++;
    }
  }
}

console.log(`\nDone. ${updated} updated, ${skipped} skipped.`);
