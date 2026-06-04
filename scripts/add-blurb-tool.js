#!/usr/bin/env node
// One-off: add the Blurb Builder link to the existing Tools dropdown on every
// marketing page that has the menu but is missing it. add-tools-nav.js is
// idempotent (skips pages that already have tools-dd), so it can't update the
// menu contents on pages already populated — this fills the gap.
// Idempotent: skips pages whose tools-menu already links to /blurb.

import fs from 'fs';
import { execSync } from 'child_process';

const LINK = '        <a href="/blurb">Blurb Builder</a>\n';
const MENU_OPEN = '<div class="tools-menu">\n';

const files = execSync('grep -rl "tools-menu" public --include="*.html"', { encoding: 'utf8' })
  .trim().split('\n').filter(Boolean);

let updated = 0, skipped = 0;
for (const f of files) {
  let src = fs.readFileSync(f, 'utf8');
  if (src.includes('"/blurb"')) { skipped++; continue; }
  const idx = src.indexOf(MENU_OPEN);
  if (idx === -1) { console.log(`SKIP    ${f} (menu markup didn't match)`); skipped++; continue; }
  const insertAt = idx + MENU_OPEN.length;
  src = src.slice(0, insertAt) + LINK + src.slice(insertAt);
  fs.writeFileSync(f, src, 'utf8');
  console.log(`OK      ${f}`);
  updated++;
}
console.log(`\nDone. ${updated} updated, ${skipped} skipped.`);
