#!/usr/bin/env node
// Add a "Case Studies" dropdown to the marketing site nav, alongside the
// existing Tools dropdown. Also removes any standalone <a href="/case-studies">
// link from the same nav so we don't have two paths to the same place.
// Idempotent: skips files that already contain `cs-dd`.

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

// Per-page CSS overrides: tighten dropdown text, add the "raise" subscript style.
const CSS = `
    /* Case Studies dropdown (cs-dd; reuses tools-menu visuals) */
    .cs-dd{position:relative;display:inline-block}
    .cs-dd > a.cs-trigger{cursor:pointer;display:inline-flex!important;align-items:center;gap:4px}
    .cs-dd > a.cs-trigger::after{content:'\\25BE';font-size:9px;opacity:.7}
    .cs-dd .cs-menu{position:absolute;top:100%;right:0;background:#000;border:1px solid var(--accent,#00C2E0);min-width:260px;padding:6px 0;display:none;z-index:200;margin-top:6px}
    .cs-dd:hover .cs-menu,.cs-dd.open .cs-menu{display:block}
    .cs-dd .cs-menu a{display:flex!important;justify-content:space-between!important;align-items:center;gap:14px;padding:10px 18px!important;color:#fff!important;font-size:11px!important;text-transform:uppercase!important;letter-spacing:1.4px!important;text-decoration:none;background:transparent!important;border:none!important}
    .cs-dd .cs-menu a:hover{color:var(--accent,#00C2E0)!important;background:#111!important}
    .cs-dd .cs-menu a .raise{color:var(--accent,#00C2E0);font-weight:700}
    .cs-dd .cs-menu a.view-all{border-top:1px solid #333;margin-top:4px;padding-top:12px!important;color:var(--accent,#00C2E0)!important;font-weight:700;justify-content:center!important}
    .cs-dd .cs-menu a.view-all:hover{background:transparent!important;color:#fff!important}
`;

const DROPDOWN = `<div class="cs-dd">
      <a href="#" class="cs-trigger" onclick="event.preventDefault();this.parentNode.classList.toggle('open')">Case Studies</a>
      <div class="cs-menu">
        <a href="/case-studies/stealth-vertical-ai"><span>Stealth · Vertical AI</span><span class="raise">$1.5M</span></a>
        <a href="/case-studies/stealth-proptech"><span>Stealth · PropTech</span><span class="raise">$600K</span></a>
        <a href="/case-studies/stealth-300k"><span>Stealth · Verdict</span><span class="raise">$300K</span></a>
        <a href="/case-studies" class="view-all">View all →</a>
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

  if (src.includes('cs-dd')) {
    console.log(`SKIP    ${rel} (already has cs-dd)`);
    skipped++;
    continue;
  }

  // Find the existing Tools dropdown block. We insert the Case Studies
  // dropdown right after it. Use the `tools-trigger` anchor as the marker,
  // then walk forward to the closing </div></div> pair.
  const triggerIdx = src.indexOf('class="tools-trigger"');
  if (triggerIdx === -1) {
    console.log(`SKIP    ${rel} (no tools-trigger to anchor against)`);
    skipped++;
    continue;
  }
  // Find the tools-dd opening
  const ddOpen = src.lastIndexOf('<div class="tools-dd">', triggerIdx);
  if (ddOpen === -1) {
    console.log(`SKIP    ${rel} (no tools-dd open)`);
    skipped++;
    continue;
  }
  // Walk forward from ddOpen counting div depth to find matching close
  let depth = 0, i = ddOpen;
  while (i < src.length) {
    const openTag = src.indexOf('<div', i);
    const closeTag = src.indexOf('</div>', i);
    if (closeTag === -1) break;
    if (openTag !== -1 && openTag < closeTag) {
      depth++;
      i = openTag + 4;
    } else {
      depth--;
      i = closeTag + 6;
      if (depth === 0) break;
    }
  }
  const insertAt = i;

  // Insert Case Studies dropdown right after the Tools dropdown closes
  src = src.slice(0, insertAt) + '\n    ' + DROPDOWN + src.slice(insertAt);

  // Insert CSS before the first </style>
  if (src.indexOf('cs-dd{position') === -1) {
    const styleEnd = src.indexOf('</style>');
    if (styleEnd !== -1) {
      src = src.slice(0, styleEnd) + CSS + src.slice(styleEnd);
    }
  }

  // Remove any standalone <a href="/case-studies">Case Studies</a> (or "Case studies")
  // from the same .links div, since the dropdown supersedes it.
  src = src.replace(/\s*<a href="\/case-studies"[^>]*>\s*Case [Ss]tudies\s*<\/a>/g, '');

  fs.writeFileSync(full, src, 'utf8');
  console.log(`OK      ${rel}`);
  updated++;
}

console.log(`\nDone. ${updated} updated, ${skipped} skipped, ${missing} missing.`);
