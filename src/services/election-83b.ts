/**
 * 83(b) election service — generates a Section 83(b) election statement PDF
 * from a workflow's grant data + MatCap's taxpayer config, and computes the
 * 30-day filing deadline.
 *
 * MatCap files TWO elections per deal: one for the MatCapital entity and one
 * for Mat personally (filer: 'entity' | 'personal'). Taxpayer identity (name,
 * address, TIN) comes from env secrets so no TIN/SSN lives in the codebase.
 *
 * The statement includes every element required by Treas. Reg. §1.83-2(e).
 * IMPORTANT: this is a generated draft — it must be reviewed with tax counsel
 * and signed by the taxpayer before filing. Nothing here files anything.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export type Filer = 'entity' | 'personal';

export interface TaxpayerProfile {
  filer: Filer;
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  tin: string; // EIN (entity) or SSN (personal) — from env, never hardcoded
}

export interface MailAddress {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

/** Load a taxpayer profile from env; returns null if not fully configured. */
export function getTaxpayerProfile(filer: Filer): TaxpayerProfile | null {
  const p = filer === 'entity' ? 'MATCAP_83B_ENTITY' : 'MATCAP_83B_PERSONAL';
  const name = env(`${p}_NAME`);
  const addressLine1 = env(`${p}_ADDR1`);
  const city = env(`${p}_CITY`);
  const state = env(`${p}_STATE`);
  const zip = env(`${p}_ZIP`);
  const tin = env(`${p}_TIN`);
  if (!name || !addressLine1 || !city || !state || !zip || !tin) return null;
  return { filer, name, addressLine1, addressLine2: env(`${p}_ADDR2`), city, state, zip, tin };
}

/** IRS service center address the elections are mailed to (from env). */
export function getIrsAddress(): MailAddress | null {
  const name = env('MATCAP_83B_IRS_NAME') || 'Internal Revenue Service';
  const addressLine1 = env('MATCAP_83B_IRS_ADDR1');
  const city = env('MATCAP_83B_IRS_CITY');
  const state = env('MATCAP_83B_IRS_STATE');
  const zip = env('MATCAP_83B_IRS_ZIP');
  if (!addressLine1 || !city || !state || !zip) return null;
  return { name, addressLine1, addressLine2: env('MATCAP_83B_IRS_ADDR2'), city, state, zip };
}

/** The return/sender address for the certified mailing (Lob `from`). */
export function getReturnAddress(profile: TaxpayerProfile): MailAddress {
  const addressLine1 = env('MATCAP_83B_RETURN_ADDR1');
  if (addressLine1) {
    return {
      name: env('MATCAP_83B_RETURN_NAME') || profile.name,
      addressLine1,
      addressLine2: env('MATCAP_83B_RETURN_ADDR2'),
      city: env('MATCAP_83B_RETURN_CITY') || profile.city,
      state: env('MATCAP_83B_RETURN_STATE') || profile.state,
      zip: env('MATCAP_83B_RETURN_ZIP') || profile.zip,
    };
  }
  // Default: use the taxpayer's own address as the return address.
  return {
    name: profile.name,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    city: profile.city,
    state: profile.state,
    zip: profile.zip,
  };
}

export interface ElectionInput {
  taxpayer: TaxpayerProfile;
  companyName: string;
  entityState: string;   // state of incorporation
  entityType: string;    // e.g. "corporation"
  shareCount: number;
  pricePerShare: number; // amount paid per share
  fmvPerShare: number;   // FMV at transfer, per share (ignoring lapse restrictions)
  transferDate: string;  // YYYY-MM-DD — date the property was transferred
}

const US = 'United States';

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}
function fmtDateLong(iso: string): string {
  // iso: YYYY-MM-DD → "January 2, 2026" without relying on locale TZ shifts
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  if (!y || !m || !d) return iso;
  return `${months[m - 1]} ${d}, ${y}`;
}

/** 30 days after the transfer date — the hard §83(b) filing deadline. */
export function electionDeadline(transferDate: string): string | null {
  const [y, m, d] = (transferDate || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 30);
  return dt.toISOString().split('T')[0];
}

/** Whole days remaining until the deadline (negative if past). Needs a "today". */
export function daysUntilDeadline(transferDate: string, todayIso: string): number | null {
  const deadline = electionDeadline(transferDate);
  if (!deadline) return null;
  const a = Date.parse(deadline + 'T00:00:00Z');
  const b = Date.parse(todayIso.split('T')[0] + 'T00:00:00Z');
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/**
 * Generate the 83(b) election statement PDF. Includes all §1.83-2(e) elements.
 */
export async function generate83bPdf(input: ElectionInput): Promise<Buffer> {
  const t = input.taxpayer;
  const totalPaid = input.shareCount * input.pricePerShare;
  const fmvTotal = input.shareCount * input.fmvPerShare;
  const includible = Math.max(0, fmvTotal - totalPaid);
  const taxableYear = (input.transferDate || '').split('-')[0] || '';
  const entityType = input.entityType || 'corporation';

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 612, PAGE_H = 792;
  const MARGIN = 72;
  const MAXW = PAGE_W - MARGIN * 2;
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const wrap = (text: string, f: typeof font, size: number): string[] => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > MAXW && line) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  };

  const draw = (text: string, opts: { size?: number; f?: typeof font; gap?: number; indent?: number } = {}) => {
    const size = opts.size ?? 11;
    const f = opts.f ?? font;
    const indent = opts.indent ?? 0;
    const lh = size + 4;
    for (const ln of wrap(text, f, size)) {
      if (y < MARGIN + lh) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
      page.drawText(ln, { x: MARGIN + indent, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
      y -= lh;
    }
    y -= opts.gap ?? 0;
  };

  const numbered = (n: number, text: string) => {
    // Draw the number, then the wrapped body hanging-indented.
    const size = 11, lh = size + 4, indent = 22;
    const label = `${n}.`;
    if (y < MARGIN + lh) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
    page.drawText(label, { x: MARGIN, y, size, font: bold, color: rgb(0.1, 0.1, 0.1) });
    const lines = wrap(text, font, size);
    lines.forEach((ln, i) => {
      if (i > 0) { y -= lh; if (y < MARGIN + lh) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; } }
      page.drawText(ln, { x: MARGIN + indent, y, size, font, color: rgb(0.1, 0.1, 0.1) });
    });
    y -= lh + 8;
  };

  // Title
  draw('ELECTION TO INCLUDE IN GROSS INCOME IN YEAR OF TRANSFER', { size: 13, f: bold, gap: 4 });
  draw('PURSUANT TO SECTION 83(b) OF THE INTERNAL REVENUE CODE', { size: 13, f: bold, gap: 16 });

  draw('The undersigned taxpayer hereby makes an election pursuant to Section 83(b) of the Internal Revenue Code of 1986, as amended, and Treasury Regulation Section 1.83-2, with respect to the property described below, and provides the following information:', { gap: 14 });

  numbered(1, `The name, address, and taxpayer identification number of the undersigned are: ${t.name}, ${[t.addressLine1, t.addressLine2].filter(Boolean).join(', ')}, ${t.city}, ${t.state} ${t.zip}; Taxpayer Identification Number: ${t.tin}.`);

  numbered(2, `The property with respect to which the election is made consists of ${input.shareCount.toLocaleString('en-US')} shares of common stock (the "Shares") of ${input.companyName}, a ${input.entityState} ${entityType} (the "Company").`);

  numbered(3, `The Shares were transferred to the undersigned on ${fmtDateLong(input.transferDate)}. This election relates to the ${taxableYear} taxable year.`);

  numbered(4, `The Shares are subject to a substantial risk of forfeiture. The Shares are subject to vesting and repurchase/forfeiture restrictions that lapse over time based on the undersigned's continued service relationship with the Company; unvested Shares may be forfeited or repurchased at cost if that relationship terminates before the Shares vest.`);

  numbered(5, `The fair market value of the Shares at the time of transfer (determined without regard to any restriction other than a restriction which by its terms will never lapse) was ${fmtMoney(input.fmvPerShare)} per share, for an aggregate fair market value of ${fmtMoney(fmvTotal)}.`);

  numbered(6, `The amount paid by the undersigned for the Shares was ${fmtMoney(input.pricePerShare)} per share, for an aggregate amount paid of ${fmtMoney(totalPaid)}.`);

  numbered(7, `The amount to include in gross income as a result of this election is ${fmtMoney(includible)} (the excess of the aggregate fair market value of the Shares over the aggregate amount paid for them).`);

  numbered(8, `The undersigned has furnished a copy of this election to the person for whom the services were, are, or will be performed (the Company). The undersigned will also furnish a copy of this election with the undersigned's income tax return for the taxable year in which the property was transferred, to the extent required.`);

  y -= 10;
  draw('The undersigned understands that this election may not be revoked without the consent of the Commissioner of Internal Revenue.', { gap: 30 });

  // Signature block
  const sigY = y;
  page.drawLine({ start: { x: MARGIN, y: sigY }, end: { x: MARGIN + 240, y: sigY }, thickness: 1, color: rgb(0.3, 0.3, 0.3) });
  page.drawText('Signature of Taxpayer', { x: MARGIN, y: sigY - 14, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
  page.drawText(t.name, { x: MARGIN, y: sigY - 30, size: 11, font: bold, color: rgb(0.1, 0.1, 0.1) });
  page.drawLine({ start: { x: MARGIN + 320, y: sigY }, end: { x: MARGIN + 460, y: sigY }, thickness: 1, color: rgb(0.3, 0.3, 0.3) });
  page.drawText('Date', { x: MARGIN + 320, y: sigY - 14, size: 9, font, color: rgb(0.4, 0.4, 0.4) });

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

/**
 * Which filers ('entity' | 'personal') have a complete taxpayer profile
 * configured. Elections can only be generated for configured filers.
 */
export function configuredFilers(): Filer[] {
  return (['entity', 'personal'] as Filer[]).filter((f) => getTaxpayerProfile(f) !== null);
}
