/**
 * PDF Fill Service
 * Uses pdf-lib to programmatically fill in PDF templates with founder data
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as fs from 'fs';
import * as path from 'path';

// Template paths
const TEMPLATES_DIR = path.join(process.cwd(), 'templates');
const ADVISOR_AGREEMENT_TEMPLATE = path.join(TEMPLATES_DIR, 'advisor-agreement-claude.pdf');
const RSA_TEMPLATE = path.join(TEMPLATES_DIR, 'RSA-Claude.pdf');

export interface AdvisorAgreementData {
  companyName: string;
  effectiveDate: string;
  shareCount: string;
  founderName: string;
  founderTitle: string;
  founderEmail: string;
}

export interface StockAgreementData {
  companyName: string;
  entityState: string;
  grantDate: string;
  shareCount: string;
  pricePerShare: string;
  totalPurchasePrice: string;
  advisoryAgreementDate: string;
  founderName: string;
  founderTitle: string;
  founderEmail: string;
}

/**
 * Fill in the Advisor Agreement PDF with company/founder data
 */
export async function fillAdvisorAgreement(data: AdvisorAgreementData): Promise<Uint8Array> {
  // Load the template
  const templateBytes = fs.readFileSync(ADVISOR_AGREEMENT_TEMPLATE);
  const pdfDoc = await PDFDocument.load(templateBytes);

  // Get the font
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 10;

  const pages = pdfDoc.getPages();

  // Page 1: Company name and effective date (in the first paragraph)
  const page1 = pages[0];
  const { width: width1, height: height1 } = page1.getSize();

  // The advisor agreement typically has:
  // Line 1: "This Advisor Agreement (this "Agreement") is entered into as of [DATE]"
  // Then: "by and between [COMPANY NAME], a Delaware corporation (the "Company")"

  // Position for effective date (after "as of")
  page1.drawText(data.effectiveDate, {
    x: 385, // Position after "as of"
    y: height1 - 115,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Position for company name
  page1.drawText(data.companyName, {
    x: 136, // Position after "by and between"
    y: height1 - 128,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Share count in Section 2 (Equity Compensation)
  // The agreement has a blank for number of shares
  page1.drawText(data.shareCount, {
    x: 186, // Position for share count
    y: height1 - 235,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Page 3/4: Signature blocks
  // The signature page has Company and Advisor sections
  const signaturePage = pages.length > 2 ? pages[2] : pages[1];
  const { height: sigHeight } = signaturePage.getSize();

  // Company section - fill in company name under "COMPANY:"
  signaturePage.drawText(data.companyName, {
    x: 72,
    y: sigHeight - 320,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // The actual signature fields will be handled by Dropbox Sign
  // We just pre-fill the printed name/title/email fields

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

/**
 * Fill in the RSA + Stock Purchase Agreement PDF with company/founder data
 */
export async function fillStockAgreement(data: StockAgreementData): Promise<Uint8Array> {
  // Load the template
  const templateBytes = fs.readFileSync(RSA_TEMPLATE);
  const pdfDoc = await PDFDocument.load(templateBytes);

  // Get the font
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 10;

  const pages = pdfDoc.getPages();

  // Page 1: Header information
  const page1 = pages[0];
  const { height: height1 } = page1.getSize();

  // Grant Date at top
  page1.drawText(data.grantDate, {
    x: 420,
    y: height1 - 85,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Company name (appears multiple times, fill first occurrence)
  page1.drawText(data.companyName, {
    x: 72,
    y: height1 - 115,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // State of incorporation
  page1.drawText(data.entityState, {
    x: 200,
    y: height1 - 128,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Number of shares
  page1.drawText(data.shareCount, {
    x: 200,
    y: height1 - 185,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Advisory agreement date reference
  page1.drawText(data.advisoryAgreementDate, {
    x: 320,
    y: height1 - 235,
    size: fontSize,
    font,
    color: rgb(0, 0, 0),
  });

  // Page 3: Governing law section - state
  if (pages.length > 2) {
    const page3 = pages[2];
    const { height: height3 } = page3.getSize();

    page3.drawText(data.entityState, {
      x: 340,
      y: height3 - 300,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  // Page 4: Stock Purchase Agreement section
  if (pages.length > 3) {
    const page4 = pages[3];
    const { height: height4 } = page4.getSize();

    // Share count
    page4.drawText(data.shareCount, {
      x: 180,
      y: height4 - 145,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });

    // Price per share
    page4.drawText(`$${data.pricePerShare}`, {
      x: 180,
      y: height4 - 165,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });

    // Total purchase price
    page4.drawText(`$${data.totalPurchasePrice}`, {
      x: 180,
      y: height4 - 185,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });

    // Company name for signature block
    page4.drawText(data.companyName, {
      x: 72,
      y: height4 - 450,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });
  }

  const pdfBytes = await pdfDoc.save();
  return pdfBytes;
}

/**
 * Check if templates exist
 */
export function templatesExist(): boolean {
  return fs.existsSync(ADVISOR_AGREEMENT_TEMPLATE) && fs.existsSync(RSA_TEMPLATE);
}

/**
 * Get template paths for debugging
 */
export function getTemplatePaths(): { advisor: string; rsa: string } {
  return {
    advisor: ADVISOR_AGREEMENT_TEMPLATE,
    rsa: RSA_TEMPLATE,
  };
}
