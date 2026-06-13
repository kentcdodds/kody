import { expect, test } from 'vitest'
import { lexicalScore, searchCapabilities } from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'

test('offline capability search ranks lexical matches and returns structured detail without schema fields', async () => {
	const doc = 'alpha beta gamma delta epsilon'
	expect(lexicalScore('alpha beta', doc)).toBeGreaterThan(
		lexicalScore('omega zeta', doc),
	)

	const specs = {
		oauth_setup_guide: {
			name: 'oauth_setup_guide',
			domain: 'coding',
			description: 'Guide for configuring OAuth redirect URIs.',
			keywords: ['oauth', 'redirect uri', 'provider registration'],
			readOnly: true,
			idempotent: true,
			destructive: false,
			inputFields: ['guide'],
			requiredInputFields: ['guide'],
			outputFields: ['title', 'body'],
			inputSchema: {
				type: 'object',
				properties: {
					guide: { type: 'string' },
				},
				required: ['guide'],
			},
			inputTypeDefinition: 'type OAuthSetupGuideInput = {\n\tguide: string\n}',
		},
	} satisfies Record<string, CapabilitySpec>
	const env = {
		SENTRY_ENVIRONMENT: 'test',
		AI: {} as Ai,
	} as Env

	const oauthGuide = await searchCapabilities({
		env,
		query: 'oauth redirect uri provider registration',
		limit: 8,
		detail: true,
		specs,
	})

	expect(oauthGuide.offline).toBe(true)
	expect(oauthGuide.matches).toHaveLength(1)
	expect(oauthGuide.matches[0]).toMatchObject({
		name: 'oauth_setup_guide',
		outputFields: ['title', 'body'],
		lexicalRank: 1,
		vectorRank: 1,
	})
	expect(oauthGuide.matches[0]?.keywords).toEqual(
		expect.arrayContaining(['oauth', 'redirect uri', 'provider registration']),
	)
	expect(oauthGuide.matches[0]).not.toHaveProperty('inputSchema')
	expect(oauthGuide.matches[0]).toMatchObject({
		inputTypeDefinition: expect.stringContaining('OAuthSetupGuideInput'),
	})
	expect(oauthGuide.matches[0]).not.toHaveProperty('outputSchema')
})
