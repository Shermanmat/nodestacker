import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, voiceInterviews, voiceInterviewAnswers, publicCompanies, publicUsers } from '../db/index.js';
import { startVoiceInterview } from '../services/voice-interview-agent.js';
import { uploadDocument, createCompanyFolder, isConfigured as isDriveConfigured } from '../services/google-drive.js';
import { notifyAdminInterviewCompleted } from '../services/onboarding-emails.js';

const app = new Hono();

// ============ ADMIN ENDPOINTS ============

// Send voice interview for a company application
app.post('/admin/voice-interviews/:companyId/send', async (c) => {
  const companyId = parseInt(c.req.param('companyId'));

  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, companyId),
  });
  if (!company) return c.json({ error: 'Company not found' }, 404);

  const result = await startVoiceInterview(companyId);
  return c.json(result);
});

// Get voice interview data for admin review
app.get('/admin/voice-interviews/:companyId', async (c) => {
  const companyId = parseInt(c.req.param('companyId'));

  const interview = await db.query.voiceInterviews.findFirst({
    where: eq(voiceInterviews.publicCompanyId, companyId),
  });

  if (!interview) return c.json({ interview: null });

  const answers = await db.select()
    .from(voiceInterviewAnswers)
    .where(eq(voiceInterviewAnswers.interviewId, interview.id));

  return c.json({
    interview: {
      ...interview,
      questions: interview.questions ? JSON.parse(interview.questions) : [],
    },
    answers,
  });
});

// ============ PUBLIC ENDPOINTS (token-based) ============

// Get interview by token
app.get('/public/voice-interview/:token', async (c) => {
  const token = c.req.param('token');

  const interview = await db.query.voiceInterviews.findFirst({
    where: eq(voiceInterviews.token, token),
  });

  if (!interview) {
    return c.json({ error: 'Interview not found' }, 404);
  }

  // Check expiry
  if (interview.expiresAt && new Date(interview.expiresAt) < new Date()) {
    if (interview.status === 'sent') {
      await db.update(voiceInterviews).set({ status: 'expired' })
        .where(eq(voiceInterviews.id, interview.id));
    }
    return c.json({ error: 'This interview link has expired' }, 410);
  }

  if (interview.status === 'completed') {
    return c.json({ error: 'This interview has already been completed', status: 'completed' }, 410);
  }

  if (interview.status === 'researching') {
    return c.json({ error: 'Interview questions are still being generated. Please try again in a moment.', status: 'researching' }, 202);
  }

  if (interview.status !== 'sent') {
    return c.json({ error: 'This interview is no longer available' }, 410);
  }

  // Get company info for display
  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, interview.publicCompanyId),
  });

  const user = company ? await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, company.userId),
  }) : null;

  // Get existing answers
  const answers = await db.select()
    .from(voiceInterviewAnswers)
    .where(eq(voiceInterviewAnswers.interviewId, interview.id));

  return c.json({
    companyName: company?.companyName || 'Your Company',
    firstName: user?.firstName || '',
    questions: interview.questions ? JSON.parse(interview.questions) : [],
    answeredIndexes: answers.map(a => a.questionIndex),
    expiresAt: interview.expiresAt,
  });
});

// Upload audio answer
app.post('/public/voice-interview/:token/answer', async (c) => {
  const token = c.req.param('token');

  const interview = await db.query.voiceInterviews.findFirst({
    where: eq(voiceInterviews.token, token),
  });

  if (!interview || interview.status !== 'sent') {
    return c.json({ error: 'Interview not available' }, 400);
  }

  if (interview.expiresAt && new Date(interview.expiresAt) < new Date()) {
    return c.json({ error: 'Interview has expired' }, 410);
  }

  const body = await c.req.parseBody();
  const audioFile = body['audio'] as File;
  const questionIndex = parseInt(body['questionIndex'] as string);
  const durationSeconds = parseInt(body['durationSeconds'] as string) || null;

  if (!audioFile || isNaN(questionIndex)) {
    return c.json({ error: 'Missing audio file or questionIndex' }, 400);
  }

  // Get company name for folder
  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, interview.publicCompanyId),
  });
  const companyName = company?.companyName || 'Unknown';

  let audioUrl = '';

  if (isDriveConfigured()) {
    try {
      // Upload to Google Drive
      const arrayBuffer = await audioFile.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const fileName = `voice-interview-q${questionIndex + 1}-${companyName}.webm`;

      // Use the onboarding folder as parent
      const folderId = process.env.GOOGLE_DRIVE_ONBOARDING_FOLDER_ID || '';
      const file = await uploadDocument(folderId, fileName, buffer, 'audio/webm');
      audioUrl = file.webViewLink;
    } catch (err) {
      console.error('[VOICE-INTERVIEW] Drive upload failed:', err);
      return c.json({ error: 'Failed to upload audio' }, 500);
    }
  } else {
    // Dev mode: store placeholder
    audioUrl = `dev://voice-interview/${interview.id}/q${questionIndex}`;
    console.log(`[VOICE-INTERVIEW] Dev mode - would upload audio for Q${questionIndex + 1}`);
  }

  // Delete existing answer for this question (re-record)
  const existing = await db.select().from(voiceInterviewAnswers)
    .where(eq(voiceInterviewAnswers.interviewId, interview.id));
  const existingAnswer = existing.find(a => a.questionIndex === questionIndex);

  if (existingAnswer) {
    await db.delete(voiceInterviewAnswers)
      .where(eq(voiceInterviewAnswers.id, existingAnswer.id));
  }

  const now = new Date().toISOString();
  const [answer] = await db.insert(voiceInterviewAnswers).values({
    interviewId: interview.id,
    questionIndex,
    audioUrl,
    durationSeconds,
    createdAt: now,
  }).returning();

  return c.json({ success: true, answerId: answer.id, audioUrl });
});

// Mark interview as complete
app.post('/public/voice-interview/:token/complete', async (c) => {
  const token = c.req.param('token');

  const interview = await db.query.voiceInterviews.findFirst({
    where: eq(voiceInterviews.token, token),
  });

  if (!interview || interview.status !== 'sent') {
    return c.json({ error: 'Interview not available' }, 400);
  }

  const now = new Date().toISOString();
  await db.update(voiceInterviews).set({
    status: 'completed',
    completedAt: now,
  }).where(eq(voiceInterviews.id, interview.id));

  // Notify admin
  const company = await db.query.publicCompanies.findFirst({
    where: eq(publicCompanies.id, interview.publicCompanyId),
  });
  const user = company ? await db.query.publicUsers.findFirst({
    where: eq(publicUsers.id, company.userId),
  }) : null;

  if (company && user) {
    const adminEmail = process.env.ADMIN_EMAIL || 'mat@matsherman.com';
    await notifyAdminInterviewCompleted(adminEmail, `${user.firstName} ${user.lastName}`, company.companyName);
  }

  return c.json({ success: true });
});

export default app;
