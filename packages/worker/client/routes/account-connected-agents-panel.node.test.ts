import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test, vi } from 'vitest'
import { connectedAgentsApiPath } from '#client/routes/account-page-data.ts'
import { listToasts, toast, type ToastTone } from '#client/toast.ts'
import {
	type AccountConnectedAgentListItem,
	type AccountConnectedAgentsLoaderData,
} from '#universal/loader-data.ts'
import { createAccountConnectedAgents } from './account-connected-agents-panel.tsx'

function makeAgent(
	clientId: string,
	label: string,
	kind: AccountConnectedAgentListItem['kind'],
	connectedAt: string,
	lastUsedAt: string | null = null,
): AccountConnectedAgentListItem {
	return {
		clientId,
		grantIds: [`grant-${clientId}`],
		label,
		kind,
		connectedAt,
		lastUsedAt,
	}
}

const cursorOld = makeAgent(
	'cursor-old',
	'Cursor',
	'cursor',
	'2024-01-01T00:00:00.000Z',
	'2024-08-01T00:00:00.000Z',
)
const cursorNew = makeAgent(
	'cursor-new',
	'Cursor',
	'cursor',
	'2024-06-01T00:00:00.000Z',
	'2024-05-01T00:00:00.000Z',
)
const chatgptOld = makeAgent(
	'https://chatgpt.com/oauth/vG3/client.json',
	'ChatGPT.com',
	'chatgpt',
	'2024-03-01T00:00:00.000Z',
)
const chatgptNew = makeAgent(
	'https://chatgpt.com/oauth/vG4/client.json',
	'ChatGPT.com',
	'chatgpt',
	'2024-04-01T00:00:00.000Z',
)
const acme = makeAgent(
	'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
	'Acme Agent',
	null,
	'2024-05-01T00:00:00.000Z',
)
const allAgents = [cursorOld, cursorNew, chatgptOld, chatgptNew, acme]

const listedAgents: AccountConnectedAgentsLoaderData = {
	ok: true,
	mcpServerUrl: 'https://kody.example/mcp',
	agents: allAgents,
}

const clientIds = (agents: Array<AccountConnectedAgentListItem>) =>
	agents.map((agent) => agent.clientId)

function cssRulesForClass(html: string, className: string) {
	const rulesStart = html.indexOf(`@layer rmx.${className}`)
	expect(rulesStart).toBeGreaterThan(-1)
	return html.slice(rulesStart, html.indexOf('</style>', rulesStart))
}

function groupBlock(html: string, label: string, nextLabel?: string) {
	const start = html.indexOf(`data-agent-label="${label}"`)
	return nextLabel
		? html.slice(start, html.indexOf(`data-agent-label="${nextLabel}"`))
		: html.slice(start)
}

function expectRevokeEnabled(html: string, clientId: string) {
	const rowStart = html.indexOf(`data-client-id="${clientId}"`)
	expect(rowStart).toBeGreaterThan(-1)
	const buttonStart = html.indexOf('<button', rowStart)
	expect(buttonStart).toBeGreaterThan(-1)
	const button = html.slice(buttonStart, html.indexOf('>', buttonStart) + 1)
	expect(button).toContain('type="button"')
	expect(button).toContain('aria-label="Revoke ')
	expect(button).not.toMatch(/\sdisabled(?:[=>\s]|$)/)
}

const row = (agent: AccountConnectedAgentListItem) =>
	`data-client-id="${agent.clientId}"`

function jsonResponse(body: Record<string, unknown>, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

const okAgents = (agents: Array<AccountConnectedAgentListItem>) =>
	jsonResponse(
		{ ok: true, mcpServerUrl: listedAgents.mcpServerUrl, agents },
		200,
	)

const toastOf = (message: string, tone: ToastTone) =>
	expect.objectContaining({ message, tone })

const revokeCall = (agent: AccountConnectedAgentListItem) => [
	connectedAgentsApiPath,
	expect.objectContaining({
		method: 'POST',
		body: JSON.stringify({ intent: 'revoke', clientId: agent.clientId }),
	}),
]

function createPanelWithDeferredRevokes() {
	toast.dismiss()
	const originalFetch = globalThis.fetch
	const handle = {
		update() {
			return Promise.resolve(new AbortController().signal)
		},
	} as unknown as Handle
	const panel = createAccountConnectedAgents(handle)
	panel.applyPayload(listedAgents)

	const resolvers = new Map<string, (response: Response) => void>()
	const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { clientId: string }
		return new Promise<Response>((resolve) => {
			resolvers.set(body.clientId, resolve)
		})
	})
	globalThis.fetch = fetchMock as typeof fetch

	return {
		panel,
		fetchMock,
		render: () => renderToString(panel.render()),
		ids: () => clientIds(panel.listAgents()),
		respond(agent: AccountConnectedAgentListItem, response: Response) {
			resolvers.get(agent.clientId)!(response)
		},
		[Symbol.dispose]() {
			toast.dismiss()
			globalThis.fetch = originalFetch
		},
	}
}

test('connected agents panel groups same-name hosts, shows logos, and keeps revoke inside details', async () => {
	const panel = createAccountConnectedAgents({ update() {} } as Handle)
	panel.applyPayload(listedAgents)

	const html = await renderToString(panel.render())
	expect(html).toContain('data-testid="connected-agent-group"')
	expect(html).toContain('/images/icons/cursor.svg')
	expect(html).toContain('/images/icons/chatgpt.svg')
	expect(html).toContain('data-testid="connected-agent-mark-fallback"')
	expect(html).toContain('2 connections')
	expect(clientIds(panel.listAgents())).toEqual(clientIds(allAgents))

	const groupOrder = [...html.matchAll(/data-agent-label="([^"]+)"/g)].map(
		(match) => match[1],
	)
	expect(groupOrder).toEqual(['Cursor', 'Acme Agent', 'ChatGPT.com'])

	const cursorBlock = groupBlock(html, 'Cursor', 'Acme Agent')
	expect(cursorBlock).toContain('data-testid="connected-agent-view-steps"')
	expect(cursorBlock).toContain('data-agent-kind="cursor"')
	expect(cursorBlock).toContain('href="/account/connections/new/cursor"')
	expect(cursorBlock).toContain('<details')
	expect(cursorBlock).toContain('<summary')
	expect(cursorBlock.indexOf('cursor-old')).toBeLessThan(
		cursorBlock.indexOf('cursor-new'),
	)
	expect(cursorBlock).toContain('Last used')
	expect(html).toMatch(/Last used <span[^>]*>unknown<\/span>/)
	expect(cursorBlock).toContain('aria-label="Revoke Cursor (cursor-n…)"')
	expect(cursorBlock).toContain('aria-label="Revoke Cursor (cursor-o…)"')

	const chatgptBlock = groupBlock(html, 'ChatGPT.com')
	expect(chatgptBlock).toContain('data-testid="connected-agent-view-steps"')
	expect(chatgptBlock).toContain('data-agent-kind="chatgpt"')
	expect(chatgptBlock).toContain('href="/account/connections/new/chatgpt"')
	expect(chatgptBlock).toContain(
		'aria-label="Revoke ChatGPT.com (chatgpt.com · vG4)"',
	)
	expect(chatgptBlock).toContain(
		'aria-label="Revoke ChatGPT.com (chatgpt.com · vG3)"',
	)
	expect(chatgptBlock.indexOf('vG4')).toBeLessThan(chatgptBlock.indexOf('vG3'))

	expect(groupBlock(html, 'Acme Agent', 'ChatGPT.com')).not.toContain(
		'data-testid="connected-agent-view-steps"',
	)
	expect(html).toContain('aria-label="Revoke Acme Agent"')

	// Confirm stays in the Revoke slot: both labels are grid-stacked, and the
	// row is a two-column grid so the longer confirm copy cannot wrap under.
	expect(html).toContain('data-swap-label')
	expect(html).toContain('>Confirm revoke</span>')
	const rowClass = html.match(
		/data-testid="connected-agent-connection"[^>]*class="(rmxc-[^"]+)"/,
	)?.[1]
	expect(rowClass).toBeTruthy()
	expect(cssRulesForClass(html, rowClass!)).toContain(
		'grid-template-columns: minmax(0, 1fr) auto',
	)
})

test('confirming revoke removes the row immediately and restores it with an error toast if the request fails', async () => {
	using harness = createPanelWithDeferredRevokes()
	const { panel, render, ids, respond, fetchMock } = harness

	const revokePromise = panel.revokeAgent(acme.clientId)
	const pendingHtml = await render()
	expect(pendingHtml).not.toContain(row(acme))
	expect(pendingHtml).not.toContain('data-agent-label="Acme Agent"')
	expect(pendingHtml).toContain('data-agent-label="Cursor"')
	expect(pendingHtml).toContain('data-agent-label="ChatGPT.com"')
	expectRevokeEnabled(pendingHtml, cursorOld.clientId)
	expectRevokeEnabled(pendingHtml, cursorNew.clientId)

	respond(
		acme,
		jsonResponse({ ok: false, error: 'Connected agent not found.' }, 404),
	)
	await revokePromise

	const restoredHtml = await render()
	expect(restoredHtml).toContain(row(acme))
	expect(restoredHtml).toContain('data-agent-label="Acme Agent"')
	expectRevokeEnabled(restoredHtml, acme.clientId)
	expect(listToasts()).toEqual([toastOf('Connected agent not found.', 'error')])
	expect(fetchMock).toHaveBeenCalledWith(...revokeCall(acme))

	toast.dismiss()
	const successPromise = panel.revokeAgent(cursorOld.clientId)
	const afterOneCursor = await render()
	expect(afterOneCursor).not.toContain(row(cursorOld))
	expect(afterOneCursor).toContain('data-agent-label="Cursor"')
	const cursorAfterRevoke = groupBlock(afterOneCursor, 'Cursor', 'Acme Agent')
	expect(cursorAfterRevoke).toContain(row(cursorNew))
	expect(cursorAfterRevoke).not.toContain('2 connections')
	expect(cursorAfterRevoke).toContain('aria-label="Revoke Cursor"')

	respond(cursorOld, okAgents([cursorNew, chatgptOld, chatgptNew, acme]))
	await successPromise

	const committedHtml = await render()
	expect(committedHtml).not.toContain(row(cursorOld))
	expect(committedHtml).toContain(row(cursorNew))
	expect(listToasts()).toEqual([toastOf('Agent disconnected.', 'success')])
	const afterRevoke = clientIds([cursorNew, chatgptOld, chatgptNew, acme])
	expect(ids()).toEqual(afterRevoke)

	// A stale GET captured before revoke must not restore the Connected mark.
	panel.applyPayload(listedAgents)
	expect(ids()).toEqual(afterRevoke)

	// Same clientId with a new grant (reconnect) must reappear.
	panel.applyPayload({
		...listedAgents,
		agents: [
			{
				...cursorOld,
				grantIds: ['grant-old-reconnected'],
				connectedAt: '2024-09-01T00:00:00.000Z',
			},
			cursorNew,
			chatgptOld,
			chatgptNew,
			acme,
		],
	})
	expect(ids()).toEqual(clientIds(allAgents))
})

test('each row revokes on its own: another in-flight request does not lock remaining Revoke controls', async () => {
	using harness = createPanelWithDeferredRevokes()
	const { panel, render, respond, fetchMock } = harness

	const acmePromise = panel.revokeAgent(acme.clientId)
	const afterAcme = await render()
	expect(afterAcme).not.toContain(row(acme))
	expectRevokeEnabled(afterAcme, cursorOld.clientId)
	expectRevokeEnabled(afterAcme, cursorNew.clientId)
	expectRevokeEnabled(afterAcme, chatgptNew.clientId)

	const cursorPromise = panel.revokeAgent(cursorOld.clientId)
	panel.applyPayload(listedAgents)
	const bothPending = await render()
	expect(bothPending).not.toContain(row(acme))
	expect(bothPending).not.toContain(row(cursorOld))
	expectRevokeEnabled(bothPending, cursorNew.clientId)
	expect(bothPending).toContain('data-agent-label="Cursor"')
	expect(bothPending).toContain('data-agent-label="ChatGPT.com"')

	respond(acme, okAgents([cursorOld, cursorNew, chatgptOld, chatgptNew]))
	await acmePromise

	const afterAcmeCommit = await render()
	expect(afterAcmeCommit).not.toContain(row(acme))
	expect(afterAcmeCommit).not.toContain(row(cursorOld))
	expectRevokeEnabled(afterAcmeCommit, cursorNew.clientId)
	expect(listToasts()).toEqual([toastOf('Agent disconnected.', 'success')])

	respond(
		cursorOld,
		jsonResponse({ ok: false, error: 'Unable to revoke this agent.' }, 500),
	)
	await cursorPromise

	const afterCursorFail = await render()
	expect(afterCursorFail).not.toContain(row(acme))
	expect(afterCursorFail).toContain(row(cursorOld))
	expectRevokeEnabled(afterCursorFail, cursorOld.clientId)
	expectRevokeEnabled(afterCursorFail, cursorNew.clientId)
	expect(listToasts()).toEqual([
		toastOf('Agent disconnected.', 'success'),
		toastOf('Unable to revoke this agent.', 'error'),
	])
	expect(fetchMock).toHaveBeenCalledTimes(2)
	expect(fetchMock).toHaveBeenCalledWith(...revokeCall(acme))
	expect(fetchMock).toHaveBeenCalledWith(...revokeCall(cursorOld))
})

test('a later success with a stale agent list does not restore a sibling that already committed', async () => {
	using harness = createPanelWithDeferredRevokes()
	const { panel, render, respond } = harness

	const acmePromise = panel.revokeAgent(acme.clientId)
	const cursorPromise = panel.revokeAgent(cursorOld.clientId)
	respond(acme, okAgents([cursorOld, cursorNew, chatgptOld, chatgptNew]))
	await acmePromise
	respond(cursorOld, okAgents([acme, cursorNew, chatgptOld, chatgptNew]))
	await cursorPromise

	const html = await render()
	expect(html).not.toContain(row(acme))
	expect(html).not.toContain(row(cursorOld))
	expectRevokeEnabled(html, cursorNew.clientId)
	expect(listToasts()).toEqual([
		toastOf('Agent disconnected.', 'success'),
		toastOf('Agent disconnected.', 'success'),
	])
})
