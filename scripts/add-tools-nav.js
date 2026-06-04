#!/usr/bin/env node
// Add a "Tools" dropdown to the marketing site nav across pages.
// Inserts:
//   1. CSS (right before </style> on the first <style> block)
//   2. Dropdown markup (right after the first <div class="links">)
// Idempotent: skips files that already contain `tools-dd`.

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.argv[2] || '.');
const FILES = [
  'public/index.html',
  'public/investors.html',
  'public/nodes.html',
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

const CSS = `
    /* Tools dropdown (added by add-tools-nav script) */
    .tools-dd{position:relative;display:inline-block}
    .tools-dd > a.tools-trigger{cursor:pointer;display:inline-flex!important;align-items:center;gap:4px}
    .tools-dd > a.tools-trigger::after{content:'\\25BE';font-size:9px;opacity:.7}
    .tools-dd .tools-menu{position:absolute;top:100%;right:0;background:#000;border:1px solid var(--accent,#00C2E0);min-width:220px;padding:6px 0;display:none;z-index:200;margin-top:0}
    .tools-dd:hover .tools-menu,.tools-dd.open .tools-menu{display:block}
    .tools-dd .tools-menu a{display:block!important;padding:12px 18px!important;color:#fff!important;font-size:12px!important;text-transform:uppercase!important;letter-spacing:1.5px!important;text-decoration:none;background:transparent!important;border:none!important}
    .tools-dd .tools-menu a:hover{color:var(--accent,#00C2E0)!important;background:#111!important}
`;

const DROPDOWN = `<div class="tools-dd">
      <a href="#" class="tools-trigger" onclick="event.preventDefault();this.parentNode.classList.toggle('open')">Tools</a>
      <div class="tools-menu">
        <a href="/blurb">Blurb Builder</a>
        <a href="/investor-matcher">Investor Matcher</a>
        <a href="/equity-calculator">Equity Calculator</a>
        <a href="/raise-planner">Raise Planner</a>
      </div>
    </div>
    `;

let updated = 0, skipped = 0, missing = 0;

for (const rel of FILES) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.log(`MISSING: ${rel}`);
    missing++;
    continue;
  }
  let src = fs.readFileSync(full, 'utf8');

  if (src.includes('tools-dd')) {
    console.log(`SKIP    ${rel} (already has tools-dd)`);
    skipped++;
    continue;
  }

  // 1. Insert CSS before the first </style>
  const styleEnd = src.indexOf('</style>');
  if (styleEnd === -1) {
    console.log(`SKIP    ${rel} (no <style> block)`);
    skipped++;
    continue;
  }
  src = src.slice(0, styleEnd) + CSS + src.slice(styleEnd);

  // 2. Insert dropdown markup right after the first <div class="links">
  const linksMatch = src.match(/<div class="links">\s*\n?/);
  if (!linksMatch) {
    console.log(`SKIP    ${rel} (no .links div)`);
    skipped++;
    continue;
  }
  const insertAt = linksMatch.index + linksMatch[0].length;
  // Preserve the indentation that was on the line we're inserting after, with a small bump
  src = src.slice(0, insertAt) + '    ' + DROPDOWN + src.slice(insertAt);

  fs.writeFileSync(full, src, 'utf8');
  console.log(`OK      ${rel}`);
  updated++;
}

console.log(`\nDone. ${updated} updated, ${skipped} skipped, ${missing} missing.`);
