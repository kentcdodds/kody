import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { googleOauthTranscriptActs } from './google-oauth-transcript.ts'
import { renderGoogleOauthWalkthrough } from './google-oauth-walkthrough.tsx'
import { renderInteractiveGuideLine } from './interactive-guide-walkthrough.tsx'

test('google oauth connect bubbles wrap the prefilled url instead of overflowing', async () => {
	const connectLine = googleOauthTranscriptActs
		.find((act) => act.id === 'connect')
		?.lines.find(
			(line) =>
				line.role === 'agent' &&
				line.text.includes('/connect/oauth?provider=google'),
		)
	expect(connectLine).toBeDefined()
	if (connectLine?.role !== 'agent') {
		throw new Error('expected google oauth connect agent line')
	}

	const bubble = await renderToString(renderInteractiveGuideLine(connectLine))
	expect(bubble).toContain('/connect/oauth?provider=google')
	expect(bubble).toContain(
		'authorizeUrl=https%3A%2F%2Faccounts.google.com%2Fo%2Foauth2%2Fv2%2Fauth',
	)

	const guide = await renderToString(renderGoogleOauthWalkthrough())
	expect(guide).toContain('/connect/oauth?provider=google')
	expect(guide).toContain('Connect and verify')
})
