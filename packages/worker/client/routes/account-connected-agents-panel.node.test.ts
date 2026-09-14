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

function revokeButtonHtml(html: string, clientId: string) {
	const rowStart = html.indexOf(`data-client-id="${clientId}"`)
	expect(rowStart).toBeGreaterThan(-1)
	const buttonStart = html.indexOf('<button', rowStart)
	expect(buttonStart).toBeGreaterThan(-1)
	const buttonEnd = html.indexOf('>', buttonStart) + 1
	return html.slice(buttonStart, buttonEnd)
}

function expectRevokeEnabled(html: string, clientId: string) {
	const button = revokeButtonHtml(html, clientId)
	expect(button).toContain('type="button"')
	expect(button).toContain('aria-label="Revoke ')
	expect(button).not.toMatch(/\sdisabled(?:[=>\s]|$)/)
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
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
		expectRevokeEnabled(pendingHtml, cursorOld.clientId)
		expectRevokeEnabled(pendingHtml, cursorNew.clientId)

		resolveRevoke!(
			jsonResponse(
				{
					ok: false,
					error: 'Connected agent not found.',
				},
				404,
			),
		)
		await revokePromise

		const restoredHtml = await renderToString(panel.render())
		expect(restoredHtml).toContain(`data-client-id="${acme.clientId}"`)
		expect(restoredHtml).toContain('data-agent-label="Acme Agent"')
		expectRevokeEnabled(restoredHtml, acme.clientId)
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
			jsonResponse(
				{
					ok: true,
					mcpServerUrl: listedAgents.mcpServerUrl,
					agents: [cursorNew, chatgptOld, chatgptNew, acme],
				},
				200,
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

test('each row revokes on its own: another in-flight request does not lock remaining Revoke controls', async () => {
	toast.dismiss()
	const { handle } = createStubHandle()
	const panel = createAccountConnectedAgents(handle)
	panel.applyPayload(listedAgents)

	const resolveByClientId = new Map<string, (response: Response) => void>()
	globalThis.fetch = vi.fn((_input, init) => {
		const body = JSON.parse(String(init?.body)) as { clientId: string }
		return new Promise<Response>((resolve) => {
			resolveByClientId.set(body.clientId, resolve)
		})
	}) as typeof fetch

	try {
		const acmePromise = panel.revokeAgent(acme.clientId)
		const afterAcme = await renderToString(panel.render())
		expect(afterAcme).not.toContain(`data-client-id="${acme.clientId}"`)
		expectRevokeEnabled(afterAcme, cursorOld.clientId)
		expectRevokeEnabled(afterAcme, cursorNew.clientId)
		expectRevokeEnabled(afterAcme, chatgptNew.clientId)

		const cursorPromise = panel.revokeAgent(cursorOld.clientId)
		panel.applyPayload(listedAgents)
		const bothPending = await renderToString(panel.render())
		expect(bothPending).not.toContain(`data-client-id="${acme.clientId}"`)
		expect(bothPending).not.toContain(`data-client-id="${cursorOld.clientId}"`)
		expectRevokeEnabled(bothPending, cursorNew.clientId)
		expect(bothPending).toContain('data-agent-label="Cursor"')
		expect(bothPending).toContain('data-agent-label="ChatGPT.com"')

		resolveByClientId.get(acme.clientId)!(
			jsonResponse(
				{
					ok: true,
					mcpServerUrl: listedAgents.mcpServerUrl,
					agents: [cursorOld, cursorNew, chatgptOld, chatgptNew],
				},
				200,
			),
		)
		await acmePromise

		const afterAcmeCommit = await renderToString(panel.render())
		expect(afterAcmeCommit).not.toContain(`data-client-id="${acme.clientId}"`)
		expect(afterAcmeCommit).not.toContain(
			`data-client-id="${cursorOld.clientId}"`,
		)
		expectRevokeEnabled(afterAcmeCommit, cursorNew.clientId)
		expect(listToasts()).toEqual([
			expect.objectContaining({
				message: 'Agent disconnected.',
				tone: 'success',
			}),
		])

		resolveByClientId.get(cursorOld.clientId)!(
			jsonResponse(
				{
					ok: false,
					error: 'Unable to revoke this agent.',
				},
				500,
			),
		)
		await cursorPromise

		const afterCursorFail = await renderToString(panel.render())
		expect(afterCursorFail).not.toContain(`data-client-id="${acme.clientId}"`)
		expect(afterCursorFail).toContain(`data-client-id="${cursorOld.clientId}"`)
		expectRevokeEnabled(afterCursorFail, cursorOld.clientId)
		expectRevokeEnabled(afterCursorFail, cursorNew.clientId)
		expect(listToasts()).toEqual([
			expect.objectContaining({
				message: 'Agent disconnected.',
				tone: 'success',
			}),
			expect.objectContaining({
				message: 'Unable to revoke this agent.',
				tone: 'error',
			}),
		])
		expect(globalThis.fetch).toHaveBeenCalledTimes(2)
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
		expect(globalThis.fetch).toHaveBeenCalledWith(
			connectedAgentsApiPath,
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					intent: 'revoke',
					clientId: cursorOld.clientId,
				}),
			}),
		)
	} finally {
		toast.dismiss()
		globalThis.fetch = originalFetch
	}
})

test('a later success with a stale agent list does not restore a sibling that already committed', async () => {
	toast.dismiss()
	const { handle } = createStubHandle()
	const panel = createAccountConnectedAgents(handle)
	panel.applyPayload(listedAgents)

	const resolveByClientId = new Map<string, (response: Response) => void>()
	globalThis.fetch = vi.fn((_input, init) => {
		const body = JSON.parse(String(init?.body)) as { clientId: string }
		return new Promise<Response>((resolve) => {
			resolveByClientId.set(body.clientId, resolve)
		})
	}) as typeof fetch

	try {
		const acmePromise = panel.revokeAgent(acme.clientId)
		const cursorPromise = panel.revokeAgent(cursorOld.clientId)

		resolveByClientId.get(acme.clientId)!(
			jsonResponse(
				{
					ok: true,
					mcpServerUrl: listedAgents.mcpServerUrl,
					agents: [cursorOld, cursorNew, chatgptOld, chatgptNew],
				},
				200,
			),
		)
		await acmePromise

		resolveByClientId.get(cursorOld.clientId)!(
			jsonResponse(
				{
					ok: true,
					mcpServerUrl: listedAgents.mcpServerUrl,
					agents: [acme, cursorNew, chatgptOld, chatgptNew],
				},
				200,
			),
		)
		await cursorPromise

		const html = await renderToString(panel.render())
		expect(html).not.toContain(`data-client-id="${acme.clientId}"`)
		expect(html).not.toContain(`data-client-id="${cursorOld.clientId}"`)
		expectRevokeEnabled(html, cursorNew.clientId)
		expect(listToasts()).toEqual([
			expect.objectContaining({
				message: 'Agent disconnected.',
				tone: 'success',
			}),
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
