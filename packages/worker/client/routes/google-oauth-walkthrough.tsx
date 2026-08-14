import { googleOauthTranscriptActs } from './google-oauth-transcript.ts'
import { renderInteractiveGuideWalkthrough } from './interactive-guide-walkthrough.tsx'

/**
 * Interactive Google OAuth transcript for /guides/google-oauth.
 * Shared line/tool rendering lives in interactive-guide-walkthrough.tsx.
 */
export function renderGoogleOauthWalkthrough() {
	return renderInteractiveGuideWalkthrough({
		lead: 'A coding agent looks up the official Kody guides, then walks a naive user through Lane B Google OAuth — bring-your-own client for Gmail inbox reading — one console step at a time.',
		acts: googleOauthTranscriptActs,
	})
}
