import { css } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { defaultKodyMcpUrl } from './onboarding-mcp-clients.ts'
import {
	renderAccessPanel,
	renderConnectAgentPanel,
	renderSecondAgentPanel,
} from './onboarding-wizard-panels.tsx'

const discoveryPrompt =
	"I'm deciding whether Kody (https://example.com) would be useful for me. Read https://example.com/guides/what-is-kody and then interview me to find out what Kody could do for me."

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
		agentChooser: null,
		mcpServerUrl: defaultKodyMcpUrl,
		mcpHighlights: {},
		search: selected.search,
	})
}

function accessPanel(selected: {
	hasMcpClient?: boolean
	selectedAgentLabel?: string | null
	discoveryPrompt?: string
}) {
	return renderAccessPanel({
		entrance: css({}),
		activeStep: 2,
		onSelectStep() {},
		hasMcpClient: selected.hasMcpClient ?? false,
		discoveryPrompt: selected.discoveryPrompt ?? discoveryPrompt,
		selectedAgentLabel: selected.selectedAgentLabel ?? null,
	})
}

function secondAgentPanel(selected: {
	firstAgent: 'codex' | 'cursor' | null
	agent: 'claude-code' | null
	label: string | null
	loggedIn?: boolean
	hasSecondMcpClient?: boolean
	search?: string
}) {
	return renderSecondAgentPanel({
		entrance: css({}),
		activeStep: 3,
		onSelectStep() {},
		loggedIn: selected.loggedIn ?? true,
		hasSecondMcpClient: selected.hasSecondMcpClient ?? false,
		firstAgent: selected.firstAgent,
		selectedAgent: selected.agent,
		selectedAgentLabel: selected.label,
		greyedAgents:
			selected.firstAgent === 'codex'
				? ['chatgpt', 'codex']
				: selected.firstAgent === 'cursor'
					? ['cursor']
					: [],
		agentChooser: null,
		mcpServerUrl: defaultKodyMcpUrl,
		mcpHighlights: {},
		search: selected.search,
	})
}

test('step 1 title names the selected agent and offers a text change link', async () => {
	const picker = await renderToString(
		connectPanel({ agent: null, label: null }),
	)
	expect(picker).toContain('Connect your agent')
	expect(picker).toContain('href="/onboarding/step-1/cursor"')
	expect(picker).toContain('data-testid="onboarding-wizard-next"')

	const cursor = await renderToString(
		connectPanel({ agent: 'cursor', label: 'Cursor' }),
	)
	expect(cursor).toContain('Connect Cursor')
	expect(cursor).toContain('data-testid="onboarding-agent-change"')
	expect(cursor).toContain('href="/onboarding/step-1"')
	expect(cursor).toContain('Log in to connect Cursor')

	const connected = await renderToString(
		connectPanel({
			agent: 'cursor',
			label: 'Cursor',
			loggedIn: true,
			hasMcpClient: true,
		}),
	)
	expect(connected).toContain('Cursor is connected')
})

test('step 2 shows teach prompts and a guide pointer, not a service quest', async () => {
	const unconnected = await renderToString(accessPanel({}))
	expect(unconnected).toContain('Give Kody access')
	expect(unconnected).toContain(discoveryPrompt)
	expect(unconnected).toContain('data-testid="onboarding-wizard-next"')
	expect(unconnected).toContain('data-testid="onboarding-unconnected-prompt"')
	expect(unconnected).not.toContain('data-testid="onboarding-teach-prompts"')

	const connected = await renderToString(
		accessPanel({ hasMcpClient: true, selectedAgentLabel: 'Cursor' }),
	)
	expect(connected).toContain('data-testid="onboarding-teach-prompts"')
	expect(connected).toContain('data-testid="onboarding-guide-pointer"')
	expect(connected).toContain('data-testid="onboarding-wizard-next"')
	expect(connected).not.toContain('data-testid="onboarding-unconnected-prompt"')
})

test('step 3 greys the first-agent ecosystem and folds in a portability proof', async () => {
	const picker = await renderToString(
		secondAgentPanel({
			firstAgent: 'codex',
			agent: null,
			label: null,
		}),
	)
	expect(picker).toContain('Connect a second agent')
	expect(picker).toContain('data-testid="onboarding-agent-chatgpt"')
	expect(picker).toContain('data-greyed="true"')
	expect(picker).toContain('Same ecosystem')
	expect(picker).toContain('href="/onboarding/step-3/claude-code"')
	expect(picker).toContain('href="/onboarding/step-3/cursor"')
	expect(picker).not.toContain('href="/onboarding/step-3/chatgpt"')
	expect(picker).not.toContain('href="/onboarding/step-3/codex"')
	expect(picker).not.toContain('data-testid="onboarding-portability-proof"')
	expect(picker).toContain('href="/community"')

	const selected = await renderToString(
		secondAgentPanel({
			firstAgent: 'codex',
			agent: 'claude-code',
			label: 'Claude Code',
		}),
	)
	expect(selected).toContain('Connect Claude Code')
	expect(selected).toContain('Waiting for Claude Code to connect')
	expect(selected).toContain('data-testid="onboarding-portability-proof"')
	expect(selected).toContain('data-testid="onboarding-wizard-copy-prompt"')

	const connected = await renderToString(
		secondAgentPanel({
			firstAgent: 'codex',
			agent: 'claude-code',
			label: 'Claude Code',
			hasSecondMcpClient: true,
		}),
	)
	expect(connected).toContain('Claude Code is connected')
})
