import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test, vi } from 'vitest'
import { connectedAgentsApiPath } from '#client/routes/account-page-data.ts'
import { listToasts, toast } from '#client/toast.ts'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
} from '#universal/loader-data.ts'
import { createAccountConnectedAgents } from './account-connected-agents-panel.tsx'

const originalFetch = globalThis.fetch

function createStubHandle() {
	const handle = {
		update() {
			return Promise.resolve(new AbortController().signal)
		},
	} as unknown as Handle
	return { handle }
}

const cursorOld = {
	clientId: 'cursor-old',
	grantIds: ['grant-old'],
	label: 'Cursor',
	kind: 'cursor',
	connectedAt: '2024-01-01T00:00:00.000Z',
	lastUsedAt: '2024-08-01T00:00:00.000Z',
} satisfies AccountConnectedAgentListItem
const cursorNew = {
	clientId: 'cursor-new',
	grantIds: ['grant-new'],
	label: 'Cursor',
	kind: 'cursor',
	connectedAt: '2024-06-01T00:00:00.000Z',
	lastUsedAt: '2024-05-01T00:00:00.000Z',
} satisfies AccountConnectedAgentListItem
const chatgptOld = {
	clientId: 'https://chatgpt.com/oauth/vG3/client.json',
	grantIds: ['grant-chatgpt-old'],
	label: 'ChatGPT.com',
	kind: 'chatgpt',
	connectedAt: '2024-03-01T00:00:00.000Z',
	lastUsedAt: null,
} satisfies AccountConnectedAgentListItem
const chatgptNew = {
	clientId: 'https://chatgpt.com/oauth/vG4/client.json',
	grantIds: ['grant-chatgpt-new'],
	label: 'ChatGPT.com',
	kind: 'chatgpt',
	connectedAt: '2024-04-01T00:00:00.000Z',
	lastUsedAt: null,
} satisfies AccountConnectedAgentListItem
const acme = {
	clientId: 'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
	grantIds: ['grant-acme'],
	label: 'Acme Agent',
	kind: null,
	connectedAt: '2024-05-01T00:00:00.000Z',
	lastUsedAt: null,
} satisfies AccountConnectedAgentListItem

const listedAgents: AccountConnectedAgentsLoaderData = {
	ok: true,
	mcpServerUrl: 'https://kody.example/mcp',
	agents: [cursorOld, cursorNew, chatgptOld, chatgptNew, acme],
}

function cssRulesForClass(html: string, className: string) {
	const rulesStart = html.indexOf(`@layer rmx.${className}`)
	expect(rulesStart).toBeGreaterThan(-1)
	return html.slice(rulesStart, html.indexOf('</style>', rulesStart))
}

test('connected agents panel groups same-name hosts, shows logos, and keeps revoke inside details', async () => {
	const panel = createAccountConnectedAgents({
		update() {},
	} as Handle)
	panel.applyPayload(listedAgents)

	const html = await renderToString(panel.render())
	expect(html).toContain('data-testid="connected-agent-group"')
	expect(html).toContain('/images/icons/cursor.svg')
	expect(html).toContain('/images/icons/chatgpt.svg')
	expect(html).toContain('data-testid="connected-agent-mark-fallback"')
	expect(html).toContain('2 connections')

	const groupOrder = [...html.matchAll(/data-agent-label="([^"]+)"/g)].map(
		(match) => match[1],
	)
	expect(groupOrder).toEqual(['Cursor', 'Acme Agent', 'ChatGPT.com'])

	const cursorBlock = html.slice(
		html.indexOf('data-agent-label="Cursor"'),
		html.indexOf('data-agent-label="Acme Agent"'),
	)
	expect(cursorBlock).toContain('<details')
	expect(cursorBlock).toContain('<summary')
	expect(cursorBlock.indexOf('cursor-old')).toBeLessThan(
		cursorBlock.indexOf('cursor-new'),
	)
	expect(cursorBlock).toContain('Last used')
	expect(html).toMatch(/Last used <span[^>]*>unknown<\/span>/)
	expect(cursorBlock).toContain('aria-label="Revoke Cursor (cursor-n…)"')
	expect(cursorBlock).toContain('aria-label="Revoke Cursor (cursor-o…)"')
	const chatgptBlock = html.slice(
		html.indexOf('data-agent-label="ChatGPT.com"'),
	)
	expect(chatgptBlock).toContain(
		'aria-label="Revoke ChatGPT.com (chatgpt.com · vG4)"',
	)
	expect(chatgptBlock).toContain(
		'aria-label="Revoke ChatGPT.com (chatgpt.com · vG3)"',
	)
	expect(chatgptBlock.indexOf('vG4')).toBeLessThan(chatgptBlock.indexOf('vG3'))
	expect(html).toContain('aria-label="Revoke Acme Agent"')

	// Confirm stays in the Revoke slot: both labels are grid-stacked, and the
	// row is a two-column grid so the longer confirm copy cannot wrap under.
	expect(html).toContain('data-swap-label')
	expect(html).toContain('>Confirm revoke</span>')
	const rowClass = html.match(
		/data-testid="connected-agent-connection"[^>]*class="(rmxc-[^"]+)"/,
	)?.[1]
	expect(rowClass).toBeTruthy()
	const rowRules = cssRulesForClass(html, rowClass!)
	expect(rowRules).toContain('grid-template-columns: minmax(0, 1fr) auto')
	expect(rowRules).not.toContain('flex-wrap')
})

test('confirming revoke removes the row immediately and restores it with an error toast if the request fails', async () => {
	toast.dismiss()
	const { handle } = createStubHandle()
	const panel = createAccountConnectedAgents(handle)
	panel.applyPayload(listedAgents)

	let resolveRevoke: ((response: Response) => void) | undefined
	globalThis.fetch = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				resolveRevoke = resolve
			}),
	) as typeof fetch

	try {
		const revokePromise = panel.revokeAgent(acme.clientId)
		const pendingHtml = await renderToString(panel.render())
		expect(pendingHtml).not.toContain(`data-client-id="${acme.clientId}"`)
		expect(pendingHtml).not.toContain('data-agent-label="Acme Agent"')
		expect(pendingHtml).toContain('data-agent-label="Cursor"')
		expect(pendingHtml).toContain('data-agent-label="ChatGPT.com"')
		expect(pendingHtml).toContain('aria-busy="true"')

		resolveRevoke!(
			new Response(
				JSON.stringify({
					ok: false,
					error: 'Connected agent not found.',
				}),
				{
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		)
		await revokePromise

		const restoredHtml = await renderToString(panel.render())
		expect(restoredHtml).toContain(`data-client-id="${acme.clientId}"`)
		expect(restoredHtml).toContain('data-agent-label="Acme Agent"')
		expect(restoredHtml).not.toContain('aria-busy="true"')
		expect(listToasts()).toEqual([
			expect.objectContaining({
				message: 'Connected agent not found.',
				tone: 'error',
			}),
		])
		expect(globalThis.fetch).toHaveBeenCalledWith(
			connectedAgentsApiPath,
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					intent: 'revoke',
					clientId: acme.clientId,
				}),
			}),
		)

		toast.dismiss()
		let resolveSuccess: ((response: Response) => void) | undefined
		globalThis.fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveSuccess = resolve
				}),
		) as typeof fetch

		const successPromise = panel.revokeAgent(cursorOld.clientId)
		const afterOneCursor = await renderToString(panel.render())
		expect(afterOneCursor).not.toContain(
			`data-client-id="${cursorOld.clientId}"`,
		)
		expect(afterOneCursor).toContain(`data-client-id="${cursorNew.clientId}"`)
		expect(afterOneCursor).toContain('data-agent-label="Cursor"')
		const cursorAfterRevoke = afterOneCursor.slice(
			afterOneCursor.indexOf('data-agent-label="Cursor"'),
			afterOneCursor.indexOf('data-agent-label="Acme Agent"'),
		)
		expect(cursorAfterRevoke).toContain(
			`data-client-id="${cursorNew.clientId}"`,
		)
		expect(cursorAfterRevoke).not.toContain('2 connections')
		expect(cursorAfterRevoke).toContain('aria-label="Revoke Cursor"')

		resolveSuccess!(
			new Response(
				JSON.stringify({
					ok: true,
					mcpServerUrl: listedAgents.mcpServerUrl,
					agents: [cursorNew, chatgptOld, chatgptNew, acme],
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			),
		)
		await successPromise

		const committedHtml = await renderToString(panel.render())
		expect(committedHtml).not.toContain(
			`data-client-id="${cursorOld.clientId}"`,
		)
		expect(committedHtml).toContain(`data-client-id="${cursorNew.clientId}"`)
		expect(listToasts()).toEqual([
			expect.objectContaining({
				message: 'Agent disconnected.',
				tone: 'success',
			}),
		])
	} finally {
		toast.dismiss()
		globalThis.fetch = originalFetch
	}
})
