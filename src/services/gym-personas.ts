/**
 * Pitch Gym persona catalog. Each persona is an AI VC the founder can practice
 * against — the conversational behavior lives in Tavus (its persona system
 * prompt); nodestacker just holds the catalog (id, display info, difficulty) and
 * the Tavus persona id to launch a conversation.
 *
 * One persona for now (the GP). Add more by appending entries here and creating
 * the matching persona in Tavus — the Gym renders whatever is `enabled`.
 */

export type GymDifficulty = 'warm' | 'standard' | 'hard';

export interface GymPersona {
  key: string;              // stable id we store on the analysis (persona tag)
  name: string;             // display name in the Gym
  tagline: string;          // one line: who this VC is / what they test
  difficulty: GymDifficulty;
  tavusPalId: string;       // Tavus PAL id (the persona brain) — from the pal URL
  tavusFaceId: string;      // Tavus face id (the avatar the PAL renders as)
  enabled: boolean;         // show in the Gym
}

export const GYM_PERSONAS: GymPersona[] = [
  {
    key: 'gp',
    name: 'The GP',
    tagline: 'Founder & GP of a firm running a real first pitch meeting — warm open, then digs into market, traction, and your ask.',
    difficulty: 'standard',
    // Tavus ids (not secret). Env overrides win if set. pal_id from the pal URL;
    // face_id is the avatar — set TAVUS_FACE_GP (or hard-code once you have it).
    tavusPalId: process.env.TAVUS_PAL_GP || 'p7cf631ea88e',
    tavusFaceId: process.env.TAVUS_FACE_GP || 'rcea962f9f9b',
    enabled: true,
  },
];

export function getPersona(key: string | null | undefined): GymPersona | undefined {
  if (!key) return undefined;
  return GYM_PERSONAS.find(p => p.key === key);
}

export function enabledPersonas(): GymPersona[] {
  return GYM_PERSONAS.filter(p => p.enabled);
}

/** Public-safe view for the founder-facing Gym (no internal flags). */
export function personaPublic(p: GymPersona) {
  return { key: p.key, name: p.name, tagline: p.tagline, difficulty: p.difficulty };
}
