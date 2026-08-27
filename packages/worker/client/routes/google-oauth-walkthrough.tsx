import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { googleOauthTranscriptActs } from './google-oauth-transcript.ts'
import { renderInteractiveGuideWalkthrough } from './interactive-guide-walkthrough.tsx'

/**
 * Interactive Google OAuth transcript for /guides/google-oauth.
 * Shared line/tool rendering lives in interactive-guide-walkthrough.tsx.
 */
export function renderGoogleOauthWalkthrough(
	highlights?: Record<string, HighlightedCode>,
) {
	return renderInteractiveGuideWalkthrough({
		lead: 'A coding agent looks up the official Kody guides, then walks a naive user through Google OAuth — a client they own, for Gmail inbox reading — one console step at a time.',
		acts: googleOauthTranscriptActs,
		highlights,
	})
}
