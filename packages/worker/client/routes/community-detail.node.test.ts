import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	CONFIRM_FORK_LABEL,
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
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			requiresConfirm: false,
			confirmed: false,
		}),
	).toBe('submit')
	expect(
		decideCommunityInstallClick({
			installState: 'submitting',
			alreadyInstalled: false,
			requiresConfirm: false,
			confirmed: false,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: true,
			requiresConfirm: false,
			confirmed: false,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'error',
			alreadyInstalled: false,
			requiresConfirm: false,
			confirmed: false,
		}),
	).toBe('submit')
})

test('other-account listings arm on the first click and fork on the second', () => {
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			requiresConfirm: true,
			confirmed: false,
		}),
	).toBe('arm')
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			requiresConfirm: true,
			confirmed: true,
		}),
	).toBe('submit')
	expect(
		decideCommunityInstallClick({
			installState: 'error',
			alreadyInstalled: false,
			requiresConfirm: true,
			confirmed: false,
		}),
	).toBe('arm')
	expect(
		decideCommunityInstallClick({
			installState: 'submitting',
			alreadyInstalled: false,
			requiresConfirm: true,
			confirmed: true,
		}),
	).toBe('ignore')
})

test('paintPackageTitleInstallConfirm swaps the fork label for Confirm fork', () => {
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
	expect(attributes.get('aria-label')).toBe(CONFIRM_FORK_LABEL)
	expect(tooltip.textContent).toBe(CONFIRM_FORK_LABEL)

	paintPackageTitleInstallConfirm(control, false)
	expect(attributes.get('aria-label')).toBe('Fork')
	expect(tooltip.textContent).toBe('This listing is from another account.')
})

test('install confirm is armed only for the listing that received the first click', () => {
	expect(
		isCommunityInstallConfirmArmed({
			confirmed: true,
			confirmedListingId: 'listing-a',
			listingId: 'listing-a',
		}),
	).toBe(true)
	expect(
		isCommunityInstallConfirmArmed({
			confirmed: true,
			confirmedListingId: 'listing-a',
			listingId: 'listing-b',
		}),
	).toBe(false)
	expect(
		isCommunityInstallConfirmArmed({
			confirmed: true,
			confirmedListingId: 'listing-a',
			listingId: null,
		}),
	).toBe(false)
	expect(
		isCommunityInstallConfirmArmed({
			confirmed: false,
			confirmedListingId: 'listing-a',
			listingId: 'listing-a',
		}),
	).toBe(false)
	expect(
		shouldResetInstallConfirm({
			confirmedListingId: 'listing-a',
			listingId: 'listing-a',
		}),
	).toBe(false)
	expect(
		shouldResetInstallConfirm({
			confirmedListingId: 'listing-a',
			listingId: 'listing-b',
		}),
	).toBe(true)
	expect(
		shouldResetInstallConfirm({
			confirmedListingId: 'listing-a',
			listingId: null,
		}),
	).toBe(true)
	expect(
		shouldResetInstallConfirm({
			confirmedListingId: null,
			listingId: 'listing-b',
		}),
	).toBe(false)
})

test('a same-listing shell snapshot keeps an in-flight install', () => {
	expect(
		shouldResetInstallOnShellSnapshot({
			installState: 'submitting',
			releasedProgress: false,
		}),
	).toBe(false)
	expect(
		shouldResetInstallOnShellSnapshot({
			installState: 'submitting',
			releasedProgress: true,
		}),
	).toBe(true)
	expect(
		shouldResetInstallOnShellSnapshot({
			installState: 'idle',
			releasedProgress: false,
		}),
	).toBe(true)
	expect(
		shouldResetInstallOnShellSnapshot({
			installState: 'error',
			releasedProgress: false,
		}),
	).toBe(true)
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
