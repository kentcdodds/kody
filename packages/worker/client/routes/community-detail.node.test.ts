import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import {
	decideCommunityInstallClick,
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
		}),
	).toBe('submit')
	expect(
		decideCommunityInstallClick({
			installState: 'submitting',
			alreadyInstalled: false,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: true,
		}),
	).toBe('ignore')
	expect(
		decideCommunityInstallClick({
			installState: 'error',
			alreadyInstalled: false,
		}),
	).toBe('submit')
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
