import { expect, test } from 'vitest'
import {
	buildCapabilityEmbedText,
	lexicalScore,
	searchCapabilities,
} from './capability-search.ts'
import { type CapabilitySpec } from './types.ts'

test('capability search helpers build normalized searchable documents', () => {
	const spec = {
		name: 'deploy_worker',
		domain: 'apps',
		description: 'Deploy a Worker from saved source.',
		keywords: ['deploy', 'worker', 'wrangler'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputFields: ['sourceId', 'environment'],
		requiredInputFields: ['sourceId'],
		outputFields: ['deploymentId'],
		inputSchema: {},
		inputTypeDefinition: 'type DeployWorkerInput = Record<string, unknown>',
	} satisfies CapabilitySpec

	const embedText = buildCapabilityEmbedText(spec)
	expect(embedText).toContain('deploy_worker')
	expect(embedText).toContain('Deploy a Worker from saved source.')

	const doc = 'github rest api issues pull request repository'
	expect(lexicalScore('github issues', doc)).toBeGreaterThan(
		lexicalScore('weather forecast', doc),
	)
})

test('offline detailed search returns structured capability matches without schema fields', async () => {
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

	const oauthSpecs = {
		oauth_setup_guide: specs.oauth_setup_guide,
	} satisfies Record<string, CapabilitySpec>
	const oauthGuide = await searchCapabilities({
		env,
		query: 'oauth redirect uri provider registration',
		limit: 8,
		detail: true,
		specs: oauthSpecs,
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
