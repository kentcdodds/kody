import { expect, test } from 'vitest'
import { getGuideBySlug } from '#worker/guides/catalog.ts'
import {
	buildAddAccountPrompt,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
	nextSuggestedConnectionName,
} from './integration-provider-catalog.ts'

test('integration provider suggestions resolve guide-backed prompts and keep a generic fallback', () => {
	const guideBacked = integrationProviderSuggestions.filter(
		(provider) => provider.guideSlug,
	)
	expect(guideBacked.length).toBeGreaterThan(0)

	for (const provider of guideBacked) {
		const guide = getGuideBySlug(provider.guideSlug!)
		expect(
			guide,
			`missing guide for slug "${provider.guideSlug}" (${provider.id})`,
		).not.toBeNull()
		expect(guide!.category).toBe('provider')

		const prompt = buildIntegrationSetupPrompt(provider)
		expect(prompt).toContain(`provider_${provider.guideSlug}`)
	}

	expect(
		integrationProviderSuggestions.some((provider) => provider.id === 'origin'),
	).toBe(false)

	const slack = integrationProviderSuggestions.find(
		(provider) => provider.id === 'slack',
	)
	expect(slack).toBeDefined()
	expect(slack!.guideSlug).toBeUndefined()
	const prompt = buildIntegrationSetupPrompt(slack!)
	expect(prompt.length).toBeGreaterThan(0)
	expect(prompt).not.toContain('coding_guide_get')
})

test('add-account prompt keeps existing connections and suggests a free name', () => {
	expect(nextSuggestedConnectionName('google', ['google'])).toBe('google-2')
	expect(nextSuggestedConnectionName('google', ['google', 'google-2'])).toBe(
		'google-3',
	)
	expect(nextSuggestedConnectionName('google', ['google', 'google-work'])).toBe(
		'google-2',
	)

	const builtIn = buildAddAccountPrompt({
		label: 'Google',
		slug: 'google',
		provider: 'google',
		platform: true,
		connections: [
			{ name: 'google', accountLabel: 'me@example.com' },
			{ name: 'google-work', accountLabel: 'work@example.com' },
		],
	})
	expect(builtIn).toContain('Keep the existing connections intact')
	expect(builtIn).toContain('google (me@example.com)')
	expect(builtIn).toContain('/connect/oauth?provider=google-2&platform=google')
	expect(builtIn).toContain("coding_guide_get({ guide: 'provider_google' })")
	expect(builtIn).toContain('Do not replace, rotate, or overwrite')

	const byo = buildAddAccountPrompt({
		label: 'GitHub',
		slug: 'github',
		provider: 'github',
		platform: false,
		connections: [{ name: 'github', accountLabel: null }],
	})
	expect(byo).toContain('Keep the existing connection intact: github.')
	expect(byo).toContain('do not register a new OAuth app')
	expect(byo).toContain('/connect/oauth?provider=github-2')
	expect(byo).not.toContain('platform=github')
})
