/**
 * Lob service — sends physical mail (Certified Mail with return receipt) via
 * the Lob API. Used to file 83(b) elections with the IRS: the certified-mail
 * postmark is the legal filing date under the "timely mailing = timely filing"
 * rule (IRC §7502), and Lob returns the tracking number + a proof-of-mailing
 * PDF we store as evidence.
 *
 * Gated on LOB_API_KEY — isConfigured() lets callers no-op cleanly when unset.
 */

const LOB_BASE = 'https://api.lob.com/v1';

export interface LobAddress {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string; // defaults US
}

export interface LobLetterResult {
  id: string;
  trackingNumber: string | null;
  expectedDeliveryDate: string | null;
  carrier: string | null;
  proofUrl: string | null; // Lob-hosted PDF rendering of the mailed piece
  mailType: string | null;
}

export function isConfigured(): boolean {
  return !!process.env.LOB_API_KEY;
}

function authHeader(): string {
  const key = process.env.LOB_API_KEY;
  if (!key) throw new Error('LOB_API_KEY environment variable is not set');
  // Lob uses HTTP Basic auth: API key as username, empty password.
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

/** Whether we're pointed at Lob test keys (test_...) vs live keys (live_...). */
export function isLiveKey(): boolean {
  return (process.env.LOB_API_KEY || '').startsWith('live_');
}

/**
 * Send a PDF as USPS Certified Mail with electronic return receipt.
 * `extraService: 'certified_return_receipt'` gives us both the certified
 * tracking number (proof of the filing date) and delivery confirmation.
 */
export async function sendCertifiedLetter(opts: {
  description: string;
  to: LobAddress;
  from: LobAddress;
  pdf: Buffer;
  fileName?: string;
  returnReceipt?: boolean; // default true
}): Promise<LobLetterResult> {
  const form = new FormData();
  form.append('description', opts.description);
  form.append('color', 'false');
  form.append('double_sided', 'true');
  form.append('address_placement', 'top_first_page');
  form.append('extra_service', opts.returnReceipt === false ? 'certified' : 'certified_return_receipt');

  const addr = (prefix: string, a: LobAddress) => {
    form.append(`${prefix}[name]`, a.name);
    form.append(`${prefix}[address_line1]`, a.addressLine1);
    if (a.addressLine2) form.append(`${prefix}[address_line2]`, a.addressLine2);
    form.append(`${prefix}[address_city]`, a.city);
    form.append(`${prefix}[address_state]`, a.state);
    form.append(`${prefix}[address_zip]`, a.zip);
    form.append(`${prefix}[address_country]`, a.country || 'US');
  };
  addr('to', opts.to);
  addr('from', opts.from);

  // PDF payload — Lob accepts a PDF file upload on the `file` field.
  const blob = new Blob([new Uint8Array(opts.pdf)], { type: 'application/pdf' });
  form.append('file', blob, opts.fileName || 'election.pdf');

  const res = await fetch(`${LOB_BASE}/letters`, {
    method: 'POST',
    headers: { Authorization: authHeader() },
    body: form,
  });

  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Lob returned ${res.status}`;
    throw new Error(`Lob send failed: ${msg}`);
  }

  return {
    id: data.id,
    trackingNumber: data.tracking_number ?? null,
    expectedDeliveryDate: data.expected_delivery_date ?? null,
    carrier: data.carrier ?? null,
    proofUrl: data.url ?? null,
    mailType: data.extra_service ?? null,
  };
}

/**
 * Verify a US address via Lob's verification API. Returns deliverability so we
 * can catch a bad IRS/return address before spending a certified mailing.
 */
export async function verifyUsAddress(a: LobAddress): Promise<{ deliverable: boolean; deliverability: string }> {
  const res = await fetch(`${LOB_BASE}/us_verifications`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primary_line: a.addressLine1,
      secondary_line: a.addressLine2 || '',
      city: a.city,
      state: a.state,
      zip_code: a.zip,
    }),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Lob returned ${res.status}`;
    throw new Error(`Lob address verify failed: ${msg}`);
  }
  const deliverability = data.deliverability || 'unknown';
  return { deliverable: deliverability === 'deliverable', deliverability };
}
