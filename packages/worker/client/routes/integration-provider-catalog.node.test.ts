import { expect, test } from 'vitest'
import { getGuideBySlug } from '#worker/guides/catalog.ts'
import {
	buildAddAccountHref,
	buildIntegrationSetupPrompt,
	integrationProviderSuggestions,
	isAddAccountFormOpen,
	isTakenConnectionName,
	nextSuggestedConnectionName,
	resolveAddAccountConnectionName,
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

test('next suggested connection name skips taken {slug}-{n} keys', () => {
	expect(nextSuggestedConnectionName('google', ['google'])).toBe('google-2')
	expect(nextSuggestedConnectionName('google', ['google', 'google-2'])).toBe(
		'google-3',
	)
	expect(nextSuggestedConnectionName('google', ['google', 'google-work'])).toBe(
		'google-2',
	)
	expect(
		nextSuggestedConnectionName('google', [
			'google',
			'linear',
			'Google-2',
			'google-personal',
		]),
	).toBe('google-3')
})

test('add-account name resolution rejects names already used by any connection or app', () => {
	const existingNames = ['google', 'linear', 'google-2', 'Google Work']
	expect(isTakenConnectionName('google-2', existingNames)).toBe(true)
	expect(isTakenConnectionName('Google-2', existingNames)).toBe(true)
	expect(isTakenConnectionName('google-work', existingNames)).toBe(true)
	expect(isTakenConnectionName('google-3', existingNames)).toBe(false)

	const duplicate = resolveAddAccountConnectionName({
		name: 'google-2',
		suggested: 'google-3',
		existingNames,
	})
	expect(duplicate.ok).toBe(false)
	if (!duplicate.ok) {
		expect(duplicate.error.length).toBeGreaterThan(0)
	}
	expect(
		resolveAddAccountConnectionName({
			name: '  Google-3  ',
			suggested: 'google-3',
			existingNames,
		}),
	).toEqual({ ok: true, name: 'google-3' })
	expect(
		resolveAddAccountConnectionName({
			name: '   ',
			suggested: 'google-3',
			existingNames,
		}),
	).toEqual({ ok: true, name: 'google-3' })
})

test('add-account href keeps the current path and search, then opens the form anchor', () => {
	expect(isAddAccountFormOpen('/account/integrations/google')).toBe(false)
	expect(
		isAddAccountFormOpen('/account/integrations/google?add-account=1'),
	).toBe(true)
	expect(buildAddAccountHref('/account/integrations/google?q=goo')).toBe(
		'/account/integrations/google?q=goo&add-account=1#add-account',
	)
	expect(buildAddAccountHref('/account/integrations/apps/google')).toBe(
		'/account/integrations/apps/google?add-account=1#add-account',
	)
})
