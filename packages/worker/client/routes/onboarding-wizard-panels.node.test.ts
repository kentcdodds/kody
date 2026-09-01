import { css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { defaultKodyMcpUrl } from './onboarding-mcp-clients.ts'
import { renderConnectAgentPanel } from './onboarding-wizard-panels.tsx'

function connectPanel(selected: {
	agent: 'cursor' | null
	label: string | null
	loggedIn?: boolean
	hasMcpClient?: boolean
	search?: string
}) {
	return renderConnectAgentPanel({
		entrance: css({}),
		activeStep: 1,
		onSelectStep() {},
		loggedIn: selected.loggedIn ?? false,
		hasMcpClient: selected.hasMcpClient ?? false,
		selectedAgent: selected.agent,
		selectedAgentLabel: selected.label,
		selectedSurface: 'desktop',
		agentChooser: null,
		mcpServerUrl: defaultKodyMcpUrl,
		mcpHighlights: {},
		agentLocation: {
			pathname: '/onboarding',
			search: selected.search ?? '',
			hash: '',
		},
	})
}

test('step 1 title names the selected agent and offers a text change link', async () => {
	const picker = await renderToString(
		connectPanel({ agent: null, label: null }),
	)
	expect(picker).toContain('Connect your agent')
	expect(picker).not.toContain('data-testid="onboarding-agent-change"')
	expect(picker).not.toContain('data-testid="onboarding-agent-title-mark"')

	const cursor = await renderToString(
		connectPanel({ agent: 'cursor', label: 'Cursor' }),
	)
	expect(cursor).toContain('Connect Cursor')
	expect(cursor).toContain('data-testid="onboarding-agent-title-mark"')
	expect(cursor).toContain('/images/icons/cursor.svg')
	expect(cursor).toContain('data-testid="onboarding-agent-change"')
	expect(cursor).toContain('Change selection')
	expect(cursor).toContain('data-testid="onboarding-agent-login"')
	expect(cursor).toContain('Log in to connect Cursor')
	expect(cursor).toContain('/login?redirectTo=')
	expect(cursor).toContain('agent%3Dcursor')
	expect(cursor).not.toContain('Waiting for Cursor to connect')

	const signedIn = await renderToString(
		connectPanel({ agent: 'cursor', label: 'Cursor', loggedIn: true }),
	)
	expect(signedIn).toContain('Waiting for Cursor to connect')
	expect(signedIn).not.toContain('data-testid="onboarding-agent-login"')

	const connected = await renderToString(
		connectPanel({
			agent: 'cursor',
			label: 'Cursor',
			loggedIn: true,
			hasMcpClient: true,
		}),
	)
	expect(connected).toContain('Cursor is connected')
	expect(connected).not.toContain('data-testid="onboarding-agent-login"')
})
