import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	decideCommunityInstallClick,
	isCommunityInstallConfirmArmed,
	paintPackageTitleInstallConfirm,
	shouldResetInstallConfirm,
	shouldResetInstallOnShellSnapshot,
} from './community-detail-install.ts'
import {
	renderInstallStrip,
	renderReadmeSection,
} from './community-detail-sections.tsx'

test('decideCommunityInstallClick starts a fork from idle or error and ignores an in-flight install', () => {
	const cases = [
		// [installState, alreadyInstalled, requiresConfirm, confirmed, decision]
		['idle', false, false, false, 'submit'],
		['submitting', false, false, false, 'ignore'],
		['idle', true, false, false, 'ignore'],
		['error', false, false, false, 'submit'],
		['idle', false, true, false, 'arm'],
		['idle', false, true, true, 'submit'],
		['submitting', false, true, true, 'ignore'],
	] as const
	expect(
		cases.filter(
			([installState, alreadyInstalled, requiresConfirm, confirmed, want]) =>
				decideCommunityInstallClick({
					installState,
					alreadyInstalled,
					requiresConfirm,
					confirmed,
				}) !== want,
		),
	).toEqual([])
})

test('other-account confirm paints Confirm fork and stays armed only for that listing', () => {
	const tooltip = { textContent: 'This listing is from another account.' }
	const attributes = new Map<string, string>([
		['data-title-idle-label', 'Fork'],
		['data-title-idle-tooltip', 'This listing is from another account.'],
		['aria-label', 'Fork'],
	])
	const control = {
		getAttribute(name: string) {
			return attributes.get(name) ?? null
		},
		setAttribute(name: string, value: string) {
			attributes.set(name, value)
		},
		querySelector(selector: string) {
			return selector === '[data-title-status-tooltip]' ? tooltip : null
		},
	}

	paintPackageTitleInstallConfirm(control, true)
	expect(attributes.get('aria-label')).toBe('Confirm fork')
	expect(tooltip.textContent).toBe('Confirm fork')

	paintPackageTitleInstallConfirm(control, false)
	expect(attributes.get('aria-label')).toBe('Fork')
	expect(tooltip.textContent).toBe('This listing is from another account.')

	for (const [listingId, sameListing] of [
		['listing-a', true],
		['listing-b', false],
	] as const) {
		expect(
			isCommunityInstallConfirmArmed({
				confirmed: true,
				confirmedListingId: 'listing-a',
				listingId,
			}),
		).toBe(sameListing)
		expect(
			shouldResetInstallConfirm({ confirmedListingId: 'listing-a', listingId }),
		).toBe(!sameListing)
	}
})

test('a same-listing shell snapshot keeps an in-flight install', () => {
	const cases = [
		['submitting', false, false],
		['submitting', true, true],
		['idle', false, true],
		['error', false, true],
	] as const
	expect(
		cases.filter(
			([installState, releasedProgress, want]) =>
				shouldResetInstallOnShellSnapshot({
					installState,
					releasedProgress,
				}) !== want,
		),
	).toEqual([])
})

test('install strip shows next steps after a successful install', async () => {
	const html = await renderToString(
		renderInstallStrip({
			installMessage: null,
			installOutcome: {
				status: 'installed',
				targetName: '@jane/notion-mcp',
				agentPrompt: 'Call packageGet for @jane/notion-mcp.',
				packageId: 'pkg-1',
				failedChecks: [],
			},
			onConfirmInstall: () => {},
			onCancelInstall: () => {},
		}),
	)
	expect(html).toContain('data-testid="community-install-next-steps"')
	expect(html).toContain('Installed as @jane/notion-mcp.')
	expect(html).toContain('Use in agent')
})

test('readme section keeps README and only links Agent docs when AGENTS.md is present', async () => {
	const withAgents = await renderToString(
		renderReadmeSection(['Human setup.'], '/@jane/demo/tree/main/AGENTS.md'),
	)
	expect(withAgents).toContain('id="readme-title"')
	expect(withAgents).toContain('README')
	expect(withAgents).toContain('Human setup.')
	expect(withAgents).toContain('data-testid="community-agents-docs-link"')
	expect(withAgents).toContain('href="/@jane/demo/tree/main/AGENTS.md"')

	const withoutAgents = await renderToString(
		renderReadmeSection(['Human setup.']),
	)
	expect(withoutAgents).toContain('id="readme-title"')
	expect(withoutAgents).toContain('README')
	expect(withoutAgents).not.toContain(
		'data-testid="community-agents-docs-link"',
	)
})
