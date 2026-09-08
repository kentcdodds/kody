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
	connectedAgents?: Array<{
		label: string
		kind?: 'claude-desktop' | 'cursor'
	}>
}) {
	return renderConnectAgentPanel({
		entrance: css({}),
		activeStep: 1,
		onSelectStep() {},
		loggedIn: selected.loggedIn ?? false,
		hasMcpClient: selected.hasMcpClient ?? false,
		connectedAgents: selected.connectedAgents,
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
	hasAccessWin?: boolean
	selectedAgentLabel?: string | null
	discoveryPrompt?: string
	connectedAgents?: Array<{
		label: string
		kind?: 'claude-desktop' | 'cursor'
	}>
}) {
	return renderAccessPanel({
		entrance: css({}),
		activeStep: 2,
		onSelectStep() {},
		hasMcpClient: selected.hasMcpClient ?? false,
		hasAccessWin: selected.hasAccessWin ?? false,
		discoveryPrompt: selected.discoveryPrompt ?? discoveryPrompt,
		selectedAgentLabel: selected.selectedAgentLabel ?? null,
		connectedAgents: selected.connectedAgents,
	})
}

function secondAgentPanel(selected: {
	firstAgent: 'codex' | 'cursor' | 'gemini' | null
	agent: 'claude-code' | null
	label: string | null
	loggedIn?: boolean
	hasSecondMcpClient?: boolean
	secondAgentGiftActive?: boolean
	search?: string
	accessWinMemorySubject?: string | null
	persistedPackageName?: string | null
	connectedAgents?: Array<{
		label: string
		kind?:
			| 'chatgpt'
			| 'claude-desktop'
			| 'codex'
			| 'copilot'
			| 'cursor'
			| 'devin'
			| 'grok'
			| 'grok-cli'
	}>
}) {
	return renderSecondAgentPanel({
		entrance: css({}),
		activeStep: 3,
		onSelectStep() {},
		loggedIn: selected.loggedIn ?? true,
		hasSecondMcpClient: selected.hasSecondMcpClient ?? false,
		secondAgentGiftActive: selected.secondAgentGiftActive,
		connectedAgents: selected.connectedAgents,
		firstAgent: selected.firstAgent,
		selectedAgent: selected.agent,
		selectedAgentLabel: selected.label,
		agentChooser: null,
		mcpServerUrl: defaultKodyMcpUrl,
		mcpHighlights: {},
		search: selected.search,
		accessWinMemorySubject: selected.accessWinMemorySubject,
		persistedPackageName: selected.persistedPackageName,
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
			connectedAgents: [
				{ label: 'Cursor', kind: 'cursor' },
				{ label: 'Claude Desktop', kind: 'claude-desktop' },
			],
		}),
	)
	expect(connected).toContain('Cursor is connected')
	expect(connected).toContain('data-testid="onboarding-connected-agents"')
	expect(connected).toContain(
		'aria-label="Connected: Cursor and Claude Desktop"',
	)
	expect(connected).toContain('data-agent-kind="claude-desktop"')
})

test('step 2 shows one prompt and a search waiting spinner', async () => {
	const unconnected = await renderToString(accessPanel({}))
	expect(unconnected).toContain('data-testid="onboarding-wizard-next"')
	expect(unconnected).toContain('data-testid="onboarding-unconnected-prompt"')

	const waiting = await renderToString(
		accessPanel({
			hasMcpClient: true,
			selectedAgentLabel: 'Cursor',
			connectedAgents: [
				{ label: 'Cursor', kind: 'cursor' },
				{ label: 'Claude Desktop', kind: 'claude-desktop' },
			],
		}),
	)
	expect(waiting).toContain('data-testid="onboarding-step-2-prompt"')
	expect(waiting).toContain('data-testid="onboarding-search-status"')
	expect(waiting).toContain('data-testid="onboarding-guide-pointer"')
	expect(waiting).toContain('data-testid="onboarding-wizard-next"')
	expect(waiting).not.toContain('data-connected="true"')
	expect(waiting).toContain('data-testid="onboarding-connected-agents"')
	expect(waiting).toContain('aria-label="Connected: Cursor and Claude Desktop"')

	const started = await renderToString(
		accessPanel({
			hasMcpClient: true,
			hasAccessWin: true,
			selectedAgentLabel: 'Cursor',
		}),
	)
	expect(started).toContain('data-testid="onboarding-search-status"')
	expect(started).toContain('data-connected="true"')
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
	expect(picker).toContain('Standard free for 2 weeks')
	expect(picker).toContain('data-testid="onboarding-agent-chatgpt"')
	expect(picker).toContain('data-greyed="true"')
	expect(picker).toContain('Same ecosystem')
	expect(picker).toContain('href="/onboarding/step-3/claude-code"')
	expect(picker).toContain('href="/onboarding/step-3/cursor"')
	expect(picker).not.toContain('href="/onboarding/step-3/chatgpt"')
	expect(picker).not.toContain('href="/onboarding/step-3/codex"')
	expect(picker).not.toContain('data-testid="onboarding-portability-proof"')
	expect(picker).not.toContain('data-testid="onboarding-access-win-made"')
	expect(picker).toContain('href="/community"')

	const withArtifact = await renderToString(
		secondAgentPanel({
			firstAgent: 'codex',
			agent: null,
			label: null,
			accessWinMemorySubject: 'Preferred commute',
			persistedPackageName: '@you/morning-digest',
		}),
	)
	expect(withArtifact).toContain('data-testid="onboarding-access-win-made"')

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
	expect(selected).toContain(
		'data-testid="onboarding-portability-guide-pointer"',
	)
	expect(selected).toContain('href="/guides/portability"')

	const connected = await renderToString(
		secondAgentPanel({
			firstAgent: 'codex',
			agent: 'claude-code',
			label: 'Claude Code',
			hasSecondMcpClient: true,
		}),
	)
	expect(connected).toContain("You've connected a second agent.")
	expect(connected).not.toContain('Standard is free for 2 weeks')

	const gifted = await renderToString(
		secondAgentPanel({
			firstAgent: 'codex',
			agent: 'claude-code',
			label: 'Claude Code',
			hasSecondMcpClient: true,
			secondAgentGiftActive: true,
		}),
	)
	expect(gifted).toContain(
		"You've connected a second agent. Standard is free for 2 weeks.",
	)

	const labeled = await renderToString(
		secondAgentPanel({
			firstAgent: 'gemini',
			agent: null,
			label: null,
			hasSecondMcpClient: true,
			connectedAgents: [
				{ label: 'Devin', kind: 'devin' },
				{ label: 'Claude Desktop', kind: 'claude-desktop' },
				{ label: 'ChatGPT.com', kind: 'chatgpt' },
				{ label: 'Codex', kind: 'codex' },
				{ label: 'Cursor', kind: 'cursor' },
				{ label: 'Grok.com', kind: 'grok' },
				{ label: 'Kody' },
				{ label: 'Copilot', kind: 'copilot' },
				{ label: 'Grok CLI', kind: 'grok-cli' },
				{ label: 'Zephyr' },
			],
		}),
	)
	expect(labeled).toContain('data-testid="onboarding-connected-agents"')
	expect(labeled).toContain('aria-label="Connected: Devin, Claude Desktop')
	expect(labeled).toContain('data-agent-kind="devin"')
	expect(labeled).toContain('data-agent-kind="unknown"')
	expect(labeled).toContain('/images/icons/devin.svg')
	expect(labeled).toContain('/images/icons/claude.svg')
	expect(labeled).toContain('/images/icons/chatgpt.svg')
	expect(labeled).toContain('/images/icons/cursor.svg')
	expect(labeled).toContain('/images/icons/githubcopilot.svg')
	const connectedLine = labeled.match(
		/data-testid="onboarding-connected-agents"[\s\S]*?<\/p>/,
	)?.[0]
	expect(connectedLine).toContain('data-mark-size="inline"')
	const markClass = connectedLine?.match(
		/data-mark-size="inline" class="([^"]+)"/,
	)?.[1]
	expect(markClass).toBeTruthy()
	const markCss = labeled.match(
		new RegExp(`data-rmx-style="${markClass}"[\\s\\S]*?</style>`),
	)?.[0]
	expect(markCss).toContain('display: inline-block')
	expect(markCss).toContain('width: 1cap')
	expect(markCss).toContain('height: 1cap')
	expect(markCss).toContain('vertical-align: baseline')
	expect(labeled).toContain('data-greyed-reason="same-ecosystem"')
	expect(labeled).toContain('data-greyed-reason="connected"')
	expect(labeled).toContain('data-testid="onboarding-agent-gemini"')
	expect(labeled).toContain('data-testid="onboarding-agent-cursor"')
	expect(labeled).toContain('data-testid="onboarding-agent-chatgpt"')
	expect(labeled).toContain('data-testid="onboarding-agent-devin"')
	expect(labeled).not.toContain('href="/onboarding/step-3/gemini"')
	expect(labeled).not.toContain('href="/onboarding/step-3/cursor"')
	expect(labeled).not.toContain('href="/onboarding/step-3/chatgpt"')
	expect(labeled).not.toContain('href="/onboarding/step-3/devin"')
	expect(labeled).not.toContain('href="/onboarding/step-3/codex"')
	expect(labeled).not.toContain('href="/onboarding/step-3/copilot"')
	expect(labeled).toContain('href="/onboarding/step-3/claude-code"')
	expect(labeled).toContain('href="/onboarding/step-3/grok-bot"')
	expect(labeled).toContain('href="/onboarding/step-3/not-listed"')
	expect(labeled).toContain('Same ecosystem')

	const notListed = await renderToString(
		renderSecondAgentPanel({
			entrance: css({}),
			activeStep: 3,
			onSelectStep() {},
			loggedIn: true,
			hasSecondMcpClient: false,
			connectedAgents: [{ label: 'Zephyr' }, { label: 'Kody' }],
			firstAgent: 'other',
			selectedAgent: null,
			selectedAgentLabel: null,
			agentChooser: null,
			mcpServerUrl: defaultKodyMcpUrl,
			mcpHighlights: {},
		}),
	)
	expect(notListed).toContain('href="/onboarding/step-3/not-listed"')
	expect(notListed).toContain('data-testid="onboarding-agent-other"')
	expect(notListed).toContain('data-agent-kind="unknown"')
	expect(notListed).not.toContain('data-greyed="true"')
})
