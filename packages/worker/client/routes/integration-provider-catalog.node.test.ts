import { expect, test } from 'vitest'
import { getGuideBySlug } from '#worker/guides/catalog.ts'
import {
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
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

	const slack = integrationProviderSuggestions.find(
		(provider) => provider.id === 'slack',
	)
	expect(slack).toBeDefined()
	expect(slack!.guideSlug).toBeUndefined()
	const prompt = buildIntegrationSetupPrompt(slack!)
	expect(prompt.length).toBeGreaterThan(0)
	expect(prompt).not.toContain('coding_guide_get')
})
