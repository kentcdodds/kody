import { expect, test } from 'vitest'
import { onboardingFeaturedMcpServerIds } from '#universal/onboarding-mcp-chooser.ts'
import { resolveProviderIconId } from './provider-icons.tsx'

test('resolveProviderIconId matches exact keys, families, and authorize hosts', () => {
	expect(resolveProviderIconId({ providerKey: 'GitHub' })).toBe('github')
	expect(resolveProviderIconId({ providerKey: 'google-youtube-brand' })).toBe(
		'google',
	)
	expect(resolveProviderIconId({ providerKey: 'work-slack' })).toBe('slack')
	expect(resolveProviderIconId({ providerKey: 'x-kodykoala' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'twitter' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'example' })).toBeNull()
	expect(resolveProviderIconId({ host: 'accounts.google.com' })).toBe('google')
	expect(resolveProviderIconId({ host: 'www.googleapis.com' })).toBe('google')
	expect(resolveProviderIconId({ host: 'github.com' })).toBe('github')
	expect(resolveProviderIconId({ providerKey: 'linear' })).toBe('linear')
	expect(resolveProviderIconId({ host: 'mcp.linear.app' })).toBe('linear')
	expect(resolveProviderIconId({ host: 'mcp.notion.com' })).toBe('notion')
	expect(resolveProviderIconId({ host: 'mcp.slack.com' })).toBe('slack')
	expect(resolveProviderIconId({ host: 'mcp.asana.com' })).toBe('asana')
	expect(resolveProviderIconId({ host: 'mcp.atlassian.com' })).toBe('atlassian')
	expect(resolveProviderIconId({ host: 'mcp.stripe.com' })).toBe('stripe')
	expect(resolveProviderIconId({ host: 'mcp.sentry.dev' })).toBe('sentry')
	expect(resolveProviderIconId({ host: 'mcp.canva.com' })).toBe('canva')
	expect(
		resolveProviderIconId({
			providerKey: 'custom-crm',
			host: 'login.unknown.test',
		}),
	).toBeNull()
})

test('every onboarding Step 2 featured MCP server has an official provider mark', () => {
	for (const id of onboardingFeaturedMcpServerIds) {
		expect(resolveProviderIconId({ providerKey: id })).toBe(id)
	}
})
