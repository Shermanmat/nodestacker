/**
 * Thin Tavus API client for the Pitch Gym. Two calls:
 *   - createConversation(): start an AI VC video call, returns the join URL.
 *   - getConversationTranscript(): after the call, pull the transcript by id.
 *
 * Docs: POST https://tavusapi.com/v2/conversations (pal_id + face_id),
 *       GET  https://tavusapi.com/v2/conversations/{id}?verbose=true
 * Auth: x-api-key header (process.env.TAVUS_API_KEY).
 */

const TAVUS_API = 'https://tavusapi.com/v2';

export interface CreateConversationInput {
  palId: string;
  faceId: string;
  conversationName: string;   // we encode "gym|<founderId>|<persona>" here for attribution
  callbackUrl?: string;
  maxCallDurationSecs?: number;
}

export interface TavusConversation {
  conversationId: string;
  conversationUrl: string;
  status: string;
}

function apiKey(): string {
  const k = process.env.TAVUS_API_KEY;
  if (!k) throw new Error('TAVUS_API_KEY not set');
  return k;
}

export async function createConversation(input: CreateConversationInput): Promise<TavusConversation> {
  if (!input.faceId) throw new Error('Tavus face_id missing for this persona (set TAVUS_FACE_GP)');
  const res = await fetch(`${TAVUS_API}/conversations`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pal_id: input.palId,
      face_id: input.faceId,
      conversation_name: input.conversationName,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      properties: {
        enable_recording: false,
        enable_closed_captions: true,
        ...(input.maxCallDurationSecs ? { max_call_duration: input.maxCallDurationSecs } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`Tavus create conversation failed: ${res.status} - ${await res.text()}`);
  const data = await res.json();
  return {
    conversationId: data.conversation_id,
    conversationUrl: data.conversation_url,
    status: data.status,
  };
}

export interface TranscriptTurn { role: string; content: string }

export interface FetchedTranscript {
  status: string;                 // conversation status (e.g. 'ended')
  conversationName: string | null;
  turns: TranscriptTurn[] | null; // null if the transcript event isn't ready yet
}

/** Pull a conversation with verbose=true and extract the transcription-ready turns. */
export async function getConversation(conversationId: string): Promise<FetchedTranscript> {
  const res = await fetch(`${TAVUS_API}/conversations/${conversationId}?verbose=true`, {
    headers: { 'x-api-key': apiKey() },
  });
  if (!res.ok) throw new Error(`Tavus get conversation failed: ${res.status} - ${await res.text()}`);
  const data = await res.json();
  const events: any[] = Array.isArray(data.events) ? data.events : [];
  const transcriptEvent = events.find(e => e?.event_type === 'application.transcription_ready');
  const rawTurns = transcriptEvent?.properties?.transcript;
  const turns: TranscriptTurn[] | null = Array.isArray(rawTurns)
    ? rawTurns.map((t: any) => ({ role: String(t?.role || ''), content: String(t?.content || '') })).filter((t: TranscriptTurn) => t.content)
    : null;
  return {
    status: String(data.status || ''),
    conversationName: data.conversation_name ?? null,
    turns,
  };
}

/**
 * Format Tavus turns into the "Them: / Me:" shape the mock-call analyzer expects.
 * The AI VC is the assistant; the founder is the user.
 */
export function formatTranscript(turns: TranscriptTurn[]): string {
  return turns
    .filter(t => t.role === 'assistant' || t.role === 'user')
    .map(t => `${t.role === 'assistant' ? 'Them (VC)' : 'Me (Founder)'}: ${t.content.trim()}`)
    .join('\n');
}
