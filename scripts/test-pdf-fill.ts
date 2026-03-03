/**
 * Test script to verify PDF filling works correctly
 * Run with: npx tsx scripts/test-pdf-fill.ts
 */

import * as pdfFill from '../src/services/pdf-fill.js';
import * as fs from 'fs';
import * as path from 'path';

async function testAdvisorAgreement() {
  console.log('Testing Advisor Agreement PDF fill...');

  try {
    const pdfBytes = await pdfFill.fillAdvisorAgreement({
      companyName: 'Acme Startup Inc.',
      effectiveDate: '2024-01-15',
      shareCount: '10,000',
      founderName: 'Jane Founder',
      founderTitle: 'CEO & Co-Founder',
      founderEmail: 'jane@acme.com',
    });

    const outputPath = path.join(process.cwd(), 'test-output', 'advisor-agreement-filled.pdf');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, pdfBytes);
    console.log(`✅ Advisor Agreement saved to: ${outputPath}`);
    console.log(`   File size: ${pdfBytes.length} bytes`);
  } catch (err) {
    console.error('❌ Failed to fill Advisor Agreement:', err);
  }
}

async function testStockAgreement() {
  console.log('\nTesting Stock Agreement PDF fill...');

  try {
    const pdfBytes = await pdfFill.fillStockAgreement({
      companyName: 'Acme Startup Inc.',
      entityState: 'DE',
      grantDate: '2024-01-15',
      shareCount: '10,000',
      pricePerShare: '0.0001',
      totalPurchasePrice: '1.00',
      advisoryAgreementDate: '2024-01-10',
      founderName: 'Jane Founder',
      founderTitle: 'CEO & Co-Founder',
      founderEmail: 'jane@acme.com',
    });

    const outputPath = path.join(process.cwd(), 'test-output', 'stock-agreement-filled.pdf');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, pdfBytes);
    console.log(`✅ Stock Agreement saved to: ${outputPath}`);
    console.log(`   File size: ${pdfBytes.length} bytes`);
  } catch (err) {
    console.error('❌ Failed to fill Stock Agreement:', err);
  }
}

async function main() {
  console.log('PDF Fill Test Script\n');

  // Check templates exist
  const paths = pdfFill.getTemplatePaths();
  console.log('Template paths:');
  console.log(`  Advisor: ${paths.advisor}`);
  console.log(`  RSA: ${paths.rsa}`);
  console.log(`  Templates exist: ${pdfFill.templatesExist()}`);
  console.log();

  if (!pdfFill.templatesExist()) {
    console.error('❌ Templates not found! Make sure the templates are in the templates/ directory.');
    process.exit(1);
  }

  await testAdvisorAgreement();
  await testStockAgreement();

  console.log('\n✅ All tests complete! Check the test-output/ directory for the filled PDFs.');
}

main().catch(console.error);
