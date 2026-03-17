/**
 * Google Drive Service for document storage
 * Handles company folder creation, document uploads, and folder management
 */

import { google } from 'googleapis';

interface DriveFile {
  id: string;
  name: string;
  webViewLink: string;
  mimeType: string;
}

interface DriveFolder {
  id: string;
  name: string;
  webViewLink: string;
}

let driveClient: ReturnType<typeof google.drive> | null = null;

/**
 * Initialize the Google Drive client using service account credentials
 */
function getDriveClient() {
  if (driveClient) return driveClient;

  const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!serviceAccountKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set');
  }

  let credentials: any;
  try {
    // The key is stored as base64-encoded JSON
    const decoded = Buffer.from(serviceAccountKey, 'base64').toString('utf8');
    credentials = JSON.parse(decoded);
  } catch (err) {
    throw new Error('Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY: ' + err);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Get the onboarding companies folder ID
 */
function getOnboardingFolderId(): string {
  const id = process.env.GOOGLE_DRIVE_ONBOARDING_FOLDER_ID;
  if (!id) {
    throw new Error('GOOGLE_DRIVE_ONBOARDING_FOLDER_ID environment variable is not set');
  }
  return id;
}

/**
 * Get the fully onboarded companies folder ID
 */
function getCompletedFolderId(): string {
  const id = process.env.GOOGLE_DRIVE_COMPLETED_FOLDER_ID;
  if (!id) {
    throw new Error('GOOGLE_DRIVE_COMPLETED_FOLDER_ID environment variable is not set');
  }
  return id;
}

/**
 * Create a company folder in the Onboarding Companies folder
 */
export async function createCompanyFolder(companyName: string): Promise<DriveFolder> {
  const drive = getDriveClient();
  const parentFolderId = getOnboardingFolderId();

  const response = await drive.files.create({
    requestBody: {
      name: companyName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    },
    fields: 'id, name, webViewLink',
  });

  const folder = response.data;
  if (!folder.id || !folder.name || !folder.webViewLink) {
    throw new Error('Failed to create folder: missing required fields');
  }

  return {
    id: folder.id,
    name: folder.name,
    webViewLink: folder.webViewLink,
  };
}

/**
 * Upload a document to a company folder
 */
export async function uploadDocument(
  folderId: string,
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string
): Promise<DriveFile> {
  const drive = getDriveClient();

  // Create a readable stream from the buffer
  const { Readable } = require('stream');
  const stream = new Readable();
  stream.push(fileBuffer);
  stream.push(null);

  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: 'id, name, webViewLink, mimeType',
  });

  const file = response.data;
  if (!file.id || !file.name || !file.webViewLink || !file.mimeType) {
    throw new Error('Failed to upload file: missing required fields');
  }

  return {
    id: file.id,
    name: file.name,
    webViewLink: file.webViewLink,
    mimeType: file.mimeType,
  };
}

/**
 * Get a document's web view link
 */
export async function getDocumentLink(fileId: string): Promise<string> {
  const drive = getDriveClient();

  const response = await drive.files.get({
    fileId,
    fields: 'webViewLink',
  });

  if (!response.data.webViewLink) {
    throw new Error('Failed to get document link');
  }

  return response.data.webViewLink;
}

/**
 * Move a company folder to the Fully Onboarded Companies folder
 */
export async function moveToFullyOnboarded(folderId: string): Promise<void> {
  const drive = getDriveClient();
  const completedFolderId = getCompletedFolderId();
  const onboardingFolderId = getOnboardingFolderId();

  await drive.files.update({
    fileId: folderId,
    addParents: completedFolderId,
    removeParents: onboardingFolderId,
  });
}

/**
 * List files in a company folder
 */
export async function listFolderContents(folderId: string): Promise<DriveFile[]> {
  const drive = getDriveClient();

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, webViewLink, mimeType)',
  });

  const files = response.data.files || [];
  return files.map((f: any) => ({
    id: f.id,
    name: f.name,
    webViewLink: f.webViewLink,
    mimeType: f.mimeType,
  }));
}

/**
 * Download a file's content as a stream
 */
export async function downloadFile(fileId: string): Promise<{ stream: any; mimeType: string }> {
  const drive = getDriveClient();

  // Get file metadata first for mime type
  const meta = await drive.files.get({ fileId, fields: 'mimeType' });
  const mimeType = meta.data.mimeType || 'application/octet-stream';

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return { stream: response.data, mimeType };
}

/**
 * Delete a file (moves to trash)
 */
export async function deleteFile(fileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
}

/**
 * Get folder metadata
 */
export async function getFolderInfo(folderId: string): Promise<DriveFolder> {
  const drive = getDriveClient();

  const response = await drive.files.get({
    fileId: folderId,
    fields: 'id, name, webViewLink',
  });

  const folder = response.data;
  if (!folder.id || !folder.name || !folder.webViewLink) {
    throw new Error('Failed to get folder info');
  }

  return {
    id: folder.id,
    name: folder.name,
    webViewLink: folder.webViewLink,
  };
}

/**
 * Check if a folder exists with the given name in the onboarding folder
 */
export async function findCompanyFolder(companyName: string): Promise<DriveFolder | null> {
  const drive = getDriveClient();
  const onboardingFolderId = getOnboardingFolderId();

  const response = await drive.files.list({
    q: `'${onboardingFolderId}' in parents and name = '${companyName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, webViewLink)',
  });

  const files = response.data.files || [];
  if (files.length === 0) return null;

  const folder = files[0];
  return {
    id: folder.id!,
    name: folder.name!,
    webViewLink: folder.webViewLink!,
  };
}

/**
 * Check if Google Drive is configured
 */
export function isConfigured(): boolean {
  return !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY &&
    process.env.GOOGLE_DRIVE_ONBOARDING_FOLDER_ID &&
    process.env.GOOGLE_DRIVE_COMPLETED_FOLDER_ID
  );
}

// Standard document file names
export const DocumentNames = {
  ADVISORY_AGREEMENT: 'Advisory Agreement (signed).pdf',
  EQUITY_PURCHASE_AGREEMENT: 'Equity Purchase Agreement.pdf',
  ELECTION_83B: '83b Election.pdf',
  ELECTION_83B_PROOF: '83b Mailing Proof.pdf',
  STOCK_CERTIFICATE: 'Stock Certificate.pdf',
} as const;
