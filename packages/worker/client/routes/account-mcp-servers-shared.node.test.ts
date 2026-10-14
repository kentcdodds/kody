import { expect, test } from 'vitest'
import {
	readAddServerPrefill,
	readOAuthResultFromHref,
	stateColor,
	stateLabel,
} from './account-mcp-servers-shared.tsx'
import { colors } from '#universal/styles/tokens.ts'

test('Status labels stay consistent with post-IdP tool-discovery errors', () => {
	expect(
		stateLabel({
			state: 'connected',
			enabled: true,
			error: null,
		}),
	).toBe('Discovering tools')
	expect(
		stateLabel({
			state: 'connected',
			enabled: true,
			error:
				"Authorization completed at the identity provider, but tool discovery didn't finish (phase server/discover, id attempt-1).",
		}),
	).toBe("Tool discovery didn't finish")
	expect(
		stateLabel({
			state: 'discovering',
			enabled: true,
			error: 'HTTP 403 insufficient_scope',
		}),
	).toBe("Tool discovery didn't finish")
	expect(
		stateColor({
			state: 'connected',
			enabled: true,
			error: "tool discovery didn't finish",
		}),
	).toBe(colors.error)

	const banner = readOAuthResultFromHref(
		'/account/mcp-servers/server-1?auth=error&reason=' +
			encodeURIComponent(
				"Authorization completed at the identity provider, but tool discovery didn't finish (phase server/discover, id attempt-1).",
			),
	)
	expect(banner?.tone).toBe('error')
	expect(banner?.message).toContain("tool discovery didn't finish")
})

test('the add-server form starts from a creation link name and url', () => {
	expect(
		readAddServerPrefill(
			'/@acme/-/mcp-servers/new?name=docs&url=https%3A%2F%2Fmcp.example.com',
		),
	).toEqual({ name: 'docs', url: 'https://mcp.example.com' })
	expect(readAddServerPrefill('/@acme/-/mcp-servers/new')).toEqual({
		name: '',
		url: '',
	})
})
