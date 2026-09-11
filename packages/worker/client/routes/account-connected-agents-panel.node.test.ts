import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { createAccountConnectedAgents } from './account-connected-agents-panel.tsx'

test('connected agents panel groups same-name hosts, shows logos, and keeps revoke inside details', async () => {
	const panel = createAccountConnectedAgents({
		update() {},
	} as Handle)
	panel.applyPayload({
		ok: true,
		mcpServerUrl: 'https://kody.example/mcp',
		agents: [
			{
				clientId: 'cursor-old',
				grantIds: ['grant-old'],
				label: 'Cursor',
				kind: 'cursor',
				connectedAt: '2024-01-01T00:00:00.000Z',
			},
			{
				clientId: 'cursor-new',
				grantIds: ['grant-new'],
				label: 'Cursor',
				kind: 'cursor',
				connectedAt: '2024-06-01T00:00:00.000Z',
			},
			{
				clientId: 'https://chatgpt.com/oauth/vG3/client.json',
				grantIds: ['grant-chatgpt-old'],
				label: 'ChatGPT.com',
				kind: 'chatgpt',
				connectedAt: '2024-03-01T00:00:00.000Z',
			},
			{
				clientId: 'https://chatgpt.com/oauth/vG4/client.json',
				grantIds: ['grant-chatgpt-new'],
				label: 'ChatGPT.com',
				kind: 'chatgpt',
				connectedAt: '2024-04-01T00:00:00.000Z',
			},
			{
				clientId: 'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
				grantIds: ['grant-acme'],
				label: 'Acme Agent',
				kind: null,
				connectedAt: '2024-05-01T00:00:00.000Z',
			},
		],
	})

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
	expect(cursorBlock.indexOf('cursor-new')).toBeLessThan(
		cursorBlock.indexOf('cursor-old'),
	)
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
})
