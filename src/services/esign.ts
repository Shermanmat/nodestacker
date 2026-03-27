/**
 * E-Signature Service using Dropbox Sign (HelloSign) API
 * Handles advisory agreement creation, sending, and webhook processing
 */

import * as pdfFill from './pdf-fill.js';

interface SignerInfo {
  name: string;
  email: string;
  role: 'Founder' | 'Advisor';
}

interface TemplateFields {
  founder_name: string;
  founder_email: string;
  company_name: string;
  equity_percent: string;
  effective_date: string;
  share_count: string;
  founder_title: string;
  vesting_months: string;
  cliff_months: string;
}

interface StockAgreementFields {
  company_name: string;
  entity_state: string;
  effective_date: string;
  share_count: string;
  founder_name: string;
  founder_email: string;
  founder_title: string;
  price_per_share: string;
  total_purchase_price: string;
}

interface SignatureRequestResult {
  signatureRequestId: string;
  documentId: string;
  signingUrl?: string;
}

interface SignatureStatus {
  signatureRequestId: string;
  status: 'awaiting_signature' | 'signed' | 'declined' | 'expired';
  signers: {
    email: string;
    status: string;
    signedAt?: string;
  }[];
  isComplete: boolean;
}

// Dropbox Sign API base URL
const API_BASE = 'https://api.hellosign.com/v3';

function getApiKey(): string {
  const key = process.env.DROPBOX_SIGN_API_KEY;
  if (!key) {
    throw new Error('DROPBOX_SIGN_API_KEY environment variable is not set');
  }
  return key;
}

function getTemplateId(): string {
  const id = process.env.DROPBOX_SIGN_TEMPLATE_ID;
  if (!id) {
    throw new Error('DROPBOX_SIGN_TEMPLATE_ID environment variable is not set');
  }
  return id;
}

function getStockTemplateId(): string {
  const id = process.env.DROPBOX_SIGN_STOCK_TEMPLATE_ID;
  if (!id) {
    throw new Error('DROPBOX_SIGN_STOCK_TEMPLATE_ID environment variable is not set');
  }
  return id;
}

function getAuthHeader(): string {
  // Dropbox Sign uses HTTP Basic Auth with API key as username
  return 'Basic ' + Buffer.from(getApiKey() + ':').toString('base64');
}

/**
 * Create a signature request from the advisory agreement template
 */
export async function createSignatureRequest(
  fields: TemplateFields,
  signers: SignerInfo[]
): Promise<SignatureRequestResult> {
  const templateId = getTemplateId();

  // Build the request payload
  const formData = new FormData();
  formData.append('template_ids[]', templateId);
  formData.append('subject', `Advisory Agreement - ${fields.company_name}`);
  formData.append('message', `Please review and sign the advisory agreement for ${fields.company_name}.`);
  formData.append('test_mode', process.env.NODE_ENV === 'production' ? '0' : '1');

  // Add signers - template has "Founder" (order 0) and "Advisor" (order 1)
  signers.forEach((signer) => {
    formData.append(`signers[${signer.role}][name]`, signer.name);
    formData.append(`signers[${signer.role}][email_address]`, signer.email);
    // Founder signs first (order 0), Advisor (Mat) signs second (order 1)
    formData.append(`signers[${signer.role}][order]`, signer.role === 'Founder' ? '0' : '1');
  });

  // Add custom fields (template merge fields)
  formData.append('custom_fields', JSON.stringify([
    { name: 'company_name', value: fields.company_name },
    { name: 'effective_date', value: fields.effective_date },
    { name: 'share_count', value: fields.share_count },
    { name: 'founder_name', value: fields.founder_name },
    { name: 'founder_title', value: fields.founder_title },
    { name: 'founder_email', value: fields.founder_email },
    { name: 'vesting_months', value: fields.vesting_months },
    { name: 'cliff_months', value: fields.cliff_months },
  ]));

  const response = await fetch(`${API_BASE}/signature_request/send_with_template`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Dropbox Sign API error:', error);
    throw new Error(`Failed to create signature request: ${response.status} ${error}`);
  }

  const data = await response.json();
  const signatureRequest = data.signature_request;

  return {
    signatureRequestId: signatureRequest.signature_request_id,
    documentId: signatureRequest.signature_request_id, // They use the same ID
  };
}

/**
 * Create a signature request for the Stock Award + Purchase Agreement
 */
export async function createStockAgreementRequest(
  fields: StockAgreementFields,
  signers: SignerInfo[]
): Promise<SignatureRequestResult> {
  const templateId = getStockTemplateId();

  const formData = new FormData();
  formData.append('template_ids[]', templateId);
  formData.append('subject', `Stock Award & Purchase Agreement - ${fields.company_name}`);
  formData.append('message', `Please review and sign the Stock Award & Purchase Agreement for ${fields.company_name}.`);
  formData.append('test_mode', process.env.NODE_ENV === 'production' ? '0' : '1');

  // Add signers - Founder signs first, Advisor signs second
  signers.forEach((signer) => {
    formData.append(`signers[${signer.role}][name]`, signer.name);
    formData.append(`signers[${signer.role}][email_address]`, signer.email);
    formData.append(`signers[${signer.role}][order]`, signer.role === 'Founder' ? '0' : '1');
  });

  // Add custom fields - matching exact field names from Dropbox Sign template
  formData.append('custom_fields', JSON.stringify([
    { name: 'company_name', value: fields.company_name },
    { name: 'company_name  ', value: fields.company_name }, // Some fields have trailing spaces
    { name: 'entity_state', value: fields.entity_state },
    { name: 'effective_date', value: fields.effective_date },
    { name: 'share_count', value: fields.share_count },
    { name: 'founder_name', value: fields.founder_name },
    { name: 'founder_title ', value: fields.founder_title }, // Note: trailing space
    { name: 'founder_email ', value: fields.founder_email }, // Note: trailing space
    { name: 'price_per_share', value: fields.price_per_share },
    { name: 'total_purchase_price', value: fields.total_purchase_price },
  ]));

  const response = await fetch(`${API_BASE}/signature_request/send_with_template`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Dropbox Sign API error (stock agreement):', error);
    throw new Error(`Failed to create stock agreement request: ${response.status} ${error}`);
  }

  const data = await response.json();
  const signatureRequest = data.signature_request;

  return {
    signatureRequestId: signatureRequest.signature_request_id,
    documentId: signatureRequest.signature_request_id,
  };
}

/**
 * Get the status of a signature request
 */
export async function getSignatureStatus(signatureRequestId: string): Promise<SignatureStatus> {
  const response = await fetch(`${API_BASE}/signature_request/${signatureRequestId}`, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader(),
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get signature status: ${response.status} ${error}`);
  }

  const data = await response.json();
  const sr = data.signature_request;

  const signers = sr.signatures.map((sig: any) => ({
    email: sig.signer_email_address,
    status: sig.status_code,
    signedAt: sig.signed_at ? new Date(sig.signed_at * 1000).toISOString() : undefined,
  }));

  const allSigned = signers.every((s: any) => s.status === 'signed');
  const anyDeclined = signers.some((s: any) => s.status === 'declined');

  let status: SignatureStatus['status'] = 'awaiting_signature';
  if (allSigned) status = 'signed';
  else if (anyDeclined) status = 'declined';

  return {
    signatureRequestId,
    status,
    signers,
    isComplete: allSigned,
  };
}

/**
 * Download the signed document
 */
export async function downloadSignedDocument(signatureRequestId: string): Promise<Buffer> {
  const response = await fetch(`${API_BASE}/signature_request/files/${signatureRequestId}`, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader(),
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to download document: ${response.status} ${error}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Get a direct signing URL for embedded signing (if using embedded flow)
 */
export async function getSigningUrl(signatureRequestId: string, signerEmail: string): Promise<string | null> {
  // First get the signature ID for this signer
  const status = await getSignatureStatus(signatureRequestId);
  const signer = status.signers.find(s => s.email === signerEmail);

  if (!signer) {
    throw new Error(`Signer ${signerEmail} not found in signature request`);
  }

  // Note: Embedded signing requires additional setup with Dropbox Sign
  // For now, signers will receive email notifications with signing links
  return null;
}

/**
 * Cancel a signature request
 */
export async function cancelSignatureRequest(signatureRequestId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/signature_request/cancel/${signatureRequestId}`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to cancel signature request: ${response.status} ${error}`);
  }
}

/**
 * Send a reminder to a signer
 */
export async function sendReminder(signatureRequestId: string, signerEmail: string): Promise<void> {
  const formData = new FormData();
  formData.append('email_address', signerEmail);

  const response = await fetch(`${API_BASE}/signature_request/remind/${signatureRequestId}`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to send reminder: ${response.status} ${error}`);
  }
}

// Webhook event types we care about
export type EsignWebhookEvent =
  | 'signature_request_sent'
  | 'signature_request_viewed'
  | 'signature_request_signed'
  | 'signature_request_all_signed'
  | 'signature_request_declined'
  | 'signature_request_expired';

export interface EsignWebhookPayload {
  event: {
    event_type: EsignWebhookEvent;
    event_time: string;
    event_hash: string;
  };
  signature_request: {
    signature_request_id: string;
    title: string;
    is_complete: boolean;
    has_error: boolean;
    signatures: Array<{
      signature_id: string;
      signer_email_address: string;
      signer_name: string;
      status_code: string;
      signed_at?: number;
    }>;
  };
}

/**
 * Verify webhook signature (HMAC)
 */
export function verifyWebhookSignature(payload: string, signature: string): boolean {
  const apiKey = process.env.DROPBOX_SIGN_API_KEY;
  if (!apiKey) return false;

  const crypto = require('crypto');
  const expectedSignature = crypto
    .createHmac('sha256', apiKey)
    .update(payload)
    .digest('hex');

  return signature === expectedSignature;
}

/**
 * Parse and validate webhook payload
 */
export function parseWebhookPayload(body: any): EsignWebhookPayload | null {
  try {
    if (body.event && body.signature_request) {
      return body as EsignWebhookPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if Dropbox Sign is configured
 */
export function isConfigured(): boolean {
  return !!process.env.DROPBOX_SIGN_API_KEY;
}

/**
 * Check if templates are configured (legacy template-based approach)
 */
export function isTemplateConfigured(): boolean {
  return !!(process.env.DROPBOX_SIGN_API_KEY && process.env.DROPBOX_SIGN_TEMPLATE_ID);
}

// ============== PDF-BASED SIGNATURE REQUESTS ==============
// These functions use pre-filled PDFs instead of templates

/**
 * Create a signature request from a pre-filled Advisor Agreement PDF
 */
export async function createAdvisorAgreementRequest(
  data: pdfFill.AdvisorAgreementData,
  signers: SignerInfo[]
): Promise<SignatureRequestResult> {
  // Fill the PDF with founder data
  const pdfBytes = await pdfFill.fillAdvisorAgreement(data);

  // Create the signature request with the filled PDF
  const formData = new FormData();
  formData.append('title', `Advisory Agreement - ${data.companyName}`);
  formData.append('subject', `Advisory Agreement - ${data.companyName}`);
  formData.append('message', `Please review and sign the advisory agreement for ${data.companyName}.`);
  formData.append('test_mode', process.env.NODE_ENV === 'production' ? '0' : '1');

  // Add the filled PDF as a file (convert Uint8Array to Buffer for compatibility)
  const pdfBuffer = Buffer.from(pdfBytes);
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('file[0]', blob, `advisory-agreement-${data.companyName.replace(/\s+/g, '-')}.pdf`);

  // Add signers with signature positions
  signers.forEach((signer, index) => {
    formData.append(`signers[${index}][name]`, signer.name);
    formData.append(`signers[${index}][email_address]`, signer.email);
    formData.append(`signers[${index}][order]`, signer.role === 'Founder' ? '0' : '1');
  });

  // Add signature field positions for the PDF
  // These are approximate positions for the signature page (page 3 or 4)
  // Founder signature block
  formData.append('form_fields_per_document', JSON.stringify([
    // Founder signature (Company representative)
    {
      document_index: 0,
      api_id: 'founder_signature',
      name: 'Founder Signature',
      type: 'signature',
      x: 72,
      y: 420,
      width: 200,
      height: 30,
      required: true,
      signer: 0,
      page: 3,
    },
    {
      document_index: 0,
      api_id: 'founder_name',
      name: 'Founder Name',
      type: 'text',
      x: 72,
      y: 395,
      width: 200,
      height: 15,
      required: true,
      signer: 0,
      page: 3,
    },
    {
      document_index: 0,
      api_id: 'founder_title',
      name: 'Founder Title',
      type: 'text',
      x: 72,
      y: 375,
      width: 200,
      height: 15,
      required: true,
      signer: 0,
      page: 3,
    },
    // Advisor signature
    {
      document_index: 0,
      api_id: 'advisor_signature',
      name: 'Advisor Signature',
      type: 'signature',
      x: 72,
      y: 220,
      width: 200,
      height: 30,
      required: true,
      signer: 1,
      page: 3,
    },
    {
      document_index: 0,
      api_id: 'advisor_name',
      name: 'Advisor Name',
      type: 'text',
      x: 72,
      y: 195,
      width: 200,
      height: 15,
      required: true,
      signer: 1,
      page: 3,
    },
  ]));

  const response = await fetch(`${API_BASE}/signature_request/send`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Dropbox Sign API error (advisor agreement):', error);
    throw new Error(`Failed to create advisor agreement request: ${response.status} ${error}`);
  }

  const responseData = await response.json();
  const signatureRequest = responseData.signature_request;

  console.log(`✅ Created advisor agreement signature request: ${signatureRequest.signature_request_id}`);

  return {
    signatureRequestId: signatureRequest.signature_request_id,
    documentId: signatureRequest.signature_request_id,
  };
}

/**
 * Create a signature request from a pre-filled Stock Agreement PDF
 */
export async function createStockAgreementFromPdf(
  data: pdfFill.StockAgreementData,
  signers: SignerInfo[]
): Promise<SignatureRequestResult> {
  // Fill the PDF with founder data
  const pdfBytes = await pdfFill.fillStockAgreement(data);

  // Create the signature request with the filled PDF
  const formData = new FormData();
  formData.append('title', `Stock Award & Purchase Agreement - ${data.companyName}`);
  formData.append('subject', `Stock Award & Purchase Agreement - ${data.companyName}`);
  formData.append('message', `Please review and sign the Stock Award & Purchase Agreement for ${data.companyName}.`);
  formData.append('test_mode', process.env.NODE_ENV === 'production' ? '0' : '1');

  // Add the filled PDF as a file (convert Uint8Array to Buffer for compatibility)
  const pdfBuffer = Buffer.from(pdfBytes);
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('file[0]', blob, `stock-agreement-${data.companyName.replace(/\s+/g, '-')}.pdf`);

  // Add signers
  signers.forEach((signer, index) => {
    formData.append(`signers[${index}][name]`, signer.name);
    formData.append(`signers[${index}][email_address]`, signer.email);
    formData.append(`signers[${index}][order]`, signer.role === 'Founder' ? '0' : '1');
  });

  // Add signature field positions for the PDF (on page 4 or 5)
  formData.append('form_fields_per_document', JSON.stringify([
    // Company/Founder signature
    {
      document_index: 0,
      api_id: 'company_signature',
      name: 'Company Signature',
      type: 'signature',
      x: 72,
      y: 380,
      width: 200,
      height: 30,
      required: true,
      signer: 0,
      page: 4,
    },
    {
      document_index: 0,
      api_id: 'company_name_field',
      name: 'Company Name',
      type: 'text',
      x: 72,
      y: 355,
      width: 200,
      height: 15,
      required: true,
      signer: 0,
      page: 4,
    },
    {
      document_index: 0,
      api_id: 'company_title',
      name: 'Company Title',
      type: 'text',
      x: 72,
      y: 335,
      width: 200,
      height: 15,
      required: true,
      signer: 0,
      page: 4,
    },
    // Advisor signature
    {
      document_index: 0,
      api_id: 'advisor_signature',
      name: 'Advisor Signature',
      type: 'signature',
      x: 72,
      y: 200,
      width: 200,
      height: 30,
      required: true,
      signer: 1,
      page: 4,
    },
    {
      document_index: 0,
      api_id: 'advisor_name',
      name: 'Advisor Name',
      type: 'text',
      x: 72,
      y: 175,
      width: 200,
      height: 15,
      required: true,
      signer: 1,
      page: 4,
    },
  ]));

  const response = await fetch(`${API_BASE}/signature_request/send`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Dropbox Sign API error (stock agreement):', error);
    throw new Error(`Failed to create stock agreement request: ${response.status} ${error}`);
  }

  const responseData = await response.json();
  const signatureRequest = responseData.signature_request;

  console.log(`✅ Created stock agreement signature request: ${signatureRequest.signature_request_id}`);

  return {
    signatureRequestId: signatureRequest.signature_request_id,
    documentId: signatureRequest.signature_request_id,
  };
}
