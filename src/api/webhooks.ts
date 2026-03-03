/**
 * Webhook handlers for external services
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import {
  db,
  onboardingWorkflows,
  onboardingEvents,
  OnboardingStatus,
  OnboardingEventType,
  OnboardingActor,
} from '../db/index.js';
import * as esign from '../services/esign.js';
import * as googleDrive from '../services/google-drive.js';
import * as onboardingEmails from '../services/onboarding-emails.js';

const app = new Hono();

// Helper to log events
async function logEvent(
  workflowId: number,
  eventType: string,
  details?: Record<string, any>
) {
  await db.insert(onboardingEvents).values({
    workflowId,
    eventType,
    actor: OnboardingActor.WEBHOOK,
    details: details ? JSON.stringify(details) : undefined,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Dropbox Sign webhook handler
 * Events: signature_request_sent, signature_request_viewed, signature_request_signed,
 *         signature_request_all_signed, signature_request_declined
 */
app.post('/dropbox-sign', async (c) => {
  const body = await c.req.json();

  // Parse webhook payload
  const payload = esign.parseWebhookPayload(body);
  if (!payload) {
    console.error('Invalid Dropbox Sign webhook payload');
    return c.json({ error: 'Invalid payload' }, 400);
  }

  const eventType = payload.event.event_type;
  const signatureRequestId = payload.signature_request.signature_request_id;

  console.log(`Dropbox Sign webhook: ${eventType} for ${signatureRequestId}`);

  // Find the workflow by signature request ID
  const workflow = await db.query.onboardingWorkflows.findFirst({
    where: eq(onboardingWorkflows.esignSignatureRequestId, signatureRequestId),
    with: {
      portfolioCompany: {
        with: {
          founder: true,
        },
      },
    },
  });

  if (!workflow) {
    console.log(`No workflow found for signature request ${signatureRequestId}`);
    // Return 200 to acknowledge receipt even if we don't have this request
    return c.json({ success: true });
  }

  const founder = workflow.portfolioCompany.founder;
  const now = new Date().toISOString();

  // Log the webhook event
  await logEvent(workflow.id, OnboardingEventType.WEBHOOK_RECEIVED, {
    eventType,
    signatureRequestId,
  });

  switch (eventType) {
    case 'signature_request_sent':
      await db.update(onboardingWorkflows)
        .set({
          status: OnboardingStatus.ADVISORY_AGREEMENT_SENT,
          agreementSentAt: now,
          updatedAt: now,
        })
        .where(eq(onboardingWorkflows.id, workflow.id));

      await logEvent(workflow.id, OnboardingEventType.ADVISORY_AGREEMENT_SENT);
      break;

    case 'signature_request_signed':
      // Check which signer signed
      for (const sig of payload.signature_request.signatures) {
        if (sig.status_code === 'signed') {
          const signedAt = sig.signed_at
            ? new Date(sig.signed_at * 1000).toISOString()
            : now;

          // Check if it's admin or founder based on email
          // Admin signs first, so if we're in ADVISORY_AGREEMENT_SENT, it's admin
          if (workflow.status === OnboardingStatus.ADVISORY_AGREEMENT_SENT) {
            await db.update(onboardingWorkflows)
              .set({
                status: OnboardingStatus.ADMIN_SIGNED,
                adminSignedAt: signedAt,
                updatedAt: now,
              })
              .where(eq(onboardingWorkflows.id, workflow.id));

            await logEvent(workflow.id, OnboardingEventType.ADMIN_SIGNED_ADVISORY, {
              signerEmail: sig.signer_email_address,
            });

            // Send email to founder that agreement is ready to sign
            await onboardingEmails.sendAdvisoryAgreementReadyEmail({
              name: founder.name,
              email: founder.email,
              companyName: founder.companyName,
            });
          } else if (workflow.status === OnboardingStatus.ADMIN_SIGNED &&
                     sig.signer_email_address === founder.email) {
            await db.update(onboardingWorkflows)
              .set({
                status: OnboardingStatus.FOUNDER_SIGNED,
                founderSignedAt: signedAt,
                updatedAt: now,
              })
              .where(eq(onboardingWorkflows.id, workflow.id));

            await logEvent(workflow.id, OnboardingEventType.FOUNDER_SIGNED_ADVISORY, {
              signerEmail: sig.signer_email_address,
            });
          }
        }
      }
      break;

    case 'signature_request_all_signed':
      // Download signed document
      let signedDocumentUrl: string | undefined;
      try {
        const docBuffer = await esign.downloadSignedDocument(signatureRequestId);

        // Upload to Google Drive if configured
        if (googleDrive.isConfigured() && workflow.driveFolderId) {
          const file = await googleDrive.uploadDocument(
            workflow.driveFolderId,
            googleDrive.DocumentNames.ADVISORY_AGREEMENT,
            docBuffer,
            'application/pdf'
          );
          signedDocumentUrl = file.webViewLink;
        }
      } catch (err) {
        console.error('Failed to download/upload signed document:', err);
      }

      await db.update(onboardingWorkflows)
        .set({
          status: OnboardingStatus.EQUITY_AGREEMENT_PENDING,
          signedDocumentUrl,
          updatedAt: now,
        })
        .where(eq(onboardingWorkflows.id, workflow.id));

      // Notify admin
      const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
      await onboardingEmails.notifyAdminAdvisoryComplete(adminEmail, {
        name: founder.name,
        email: founder.email,
        companyName: founder.companyName,
      });

      // Send equity agreement request to founder
      if (workflow.authorizedShares && workflow.offerEquityPercent && workflow.sharePrice) {
        const shareCount = Math.round(
          workflow.authorizedShares * (parseFloat(workflow.offerEquityPercent) / 100)
        );
        await onboardingEmails.sendEquityAgreementRequestEmail(
          {
            name: founder.name,
            email: founder.email,
            companyName: founder.companyName,
          },
          {
            equityPercent: workflow.offerEquityPercent,
            sharePrice: workflow.sharePrice,
            shareCount,
            totalAmount: (shareCount * parseFloat(workflow.sharePrice)).toFixed(2),
            grantDate: now.split('T')[0],
          }
        );
      }
      break;

    case 'signature_request_declined':
      await db.update(onboardingWorkflows)
        .set({
          status: OnboardingStatus.OFFER_PENDING, // Reset to offer pending
          updatedAt: now,
        })
        .where(eq(onboardingWorkflows.id, workflow.id));

      await logEvent(workflow.id, OnboardingEventType.WEBHOOK_RECEIVED, {
        eventType: 'declined',
        message: 'Signature request was declined',
      });
      break;
  }

  // Dropbox Sign expects a specific response format
  return c.text('Hello API Event Received');
});

export default app;
