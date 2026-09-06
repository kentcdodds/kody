import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { decideCommunityInstallClick } from './community-detail-install.ts'
import { renderInstallStrip } from './community-detail-sections.tsx'

test('decideCommunityInstallClick covers idle confirm, official submit, ignore gates, and error retry', () => {
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
		}),
	).toBe('confirm')
	expect(
		decideCommunityInstallClick({
			installState: 'idle',
			alreadyInstalled: false,
			official: true,
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
			installState: 'confirming',
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
	).toBe('confirm')
	expect(
		decideCommunityInstallClick({
			installState: 'error',
			alreadyInstalled: false,
			official: true,
		}),
	).toBe('submit')
})

test('install strip shows next steps after a successful install', async () => {
	const html = await renderToString(
		renderInstallStrip({
			installState: 'idle',
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
	expect(html).toContain('href="/@jane/notion-mcp"')
	expect(html).toContain('Open package')
	expect(html).toContain('Use in agent')

	const confirmHtml = await renderToString(
		renderInstallStrip({
			installState: 'confirming',
			installMessage: null,
			installOutcome: null,
			onConfirmInstall: () => {},
			onCancelInstall: () => {},
		}),
	)
	expect(confirmHtml).toContain('data-testid="community-install-warning"')
	expect(confirmHtml).toContain('from another account')
})
