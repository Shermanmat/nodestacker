# Archive

Code moved out of the build but kept in git history for reference. Nothing here
is compiled (`tsconfig.json` only includes `src/**/*`) or wired into the app.

## api/docs-onboarding.ts — archived 2026-07-13

The "docs-first onboarding" track: already-incorporated companies uploaded
formation docs (articles of incorporation + bylaws + initial board consent),
we extracted variables, and the founder confirmed them
(`POST /upload`, `GET /extracted`, `POST /confirm` under `/api/portal/docs`).

**Why archived:** no caller anywhere in `public/` or `src/` — the route was
registered but never reachable from any UI/JS/MCP surface. The deck/document
intake it was meant to power now runs through
`/api/portal/comms/deck-request` (`src/api/founder-portal.ts`). It only wrote to
shared tables (`onboarding_workflows`, `onboarding_events`, `board_members`)
that `src/api/onboarding.ts` already manages, so archiving loses no unique data.

To restore: move the file back to `src/api/`, re-add the import and
`app.route('/api/portal/docs', docsOnboardingRoutes)` in `src/index.ts`, and
build a UI that posts to it.
