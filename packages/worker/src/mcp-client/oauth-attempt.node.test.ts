import { expect, test } from 'vitest'
import {
	buildMcpOAuthAttemptIdentity,
	markMcpOAuthAttemptVerified,
	mcpOAuthAttemptStorageKey,
	mcpOAuthAttemptVerifiedStorageKey,
	oauthAttemptMatchesLiveServer,
	parseMcpOAuthAttemptIdentity,
	writeMcpOAuthAttemptIdentity,
	readMcpOAuthAttemptIdentity,
	clearMcpOAuthAttemptIdentity,
	isMcpOAuthAttemptVerified,
} from './oauth-attempt.ts'

const serverUrl = 'https://mcp.example/mcp'

test('oauthAttemptMatchesLiveServer fences server id, url/origin, client, and AS origin', () => {
	const pending = buildMcpOAuthAttemptIdentity({
		serverId: 'srv-1',
		serverUrl,
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		discovery: {
			authorizationServerMetadata: {
				issuer: 'https://auth.example',
				authorization_endpoint: 'https://auth.example/authorize',
				token_endpoint: 'https://auth.example/token',
			},
		},
	})
	expect(pending).not.toBeNull()
	const live = {
		serverId: 'srv-1',
		serverUrl,
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
		name: 'docs',
	}
	const discovery = {
		authorizationServerMetadata: {
			issuer: 'https://auth.example',
			authorization_endpoint: 'https://auth.example/authorize',
			token_endpoint: 'https://auth.example/token',
		},
	}
	expect(oauthAttemptMatchesLiveServer({ pending, live, discovery })).toBe(true)

	// Remove and re-add under the same name/URL → new stable id.
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live: { ...live, serverId: 'srv-2' },
			discovery,
		}),
	).toBe(false)

	// Client reset / replace mid-flow.
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live: { ...live, clientId: 'other-client' },
			discovery,
		}),
	).toBe(false)
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live: { ...live, clientId: null },
			discovery,
		}),
	).toBe(false)

	// Owner org or person changed mid-flow.
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live: { ...live, ownerOrgId: 'org-other' },
			discovery,
		}),
	).toBe(false)
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live: { ...live, personId: 'person-other' },
			discovery,
		}),
	).toBe(false)

	// URL / origin change.
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live: { ...live, serverUrl: 'https://other.example/mcp' },
			discovery,
		}),
	).toBe(false)

	// Token endpoint moved off the AS origin discovered at start.
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live,
			discovery: {
				authorizationServerMetadata: {
					issuer: 'https://auth.example',
					token_endpoint: 'https://evil.example/token',
				},
			},
		}),
	).toBe(false)

	// Legacy pending without ids fails closed.
	expect(
		oauthAttemptMatchesLiveServer({
			pending: null,
			live,
			discovery,
		}),
	).toBe(false)
	expect(
		oauthAttemptMatchesLiveServer({
			pending,
			live: null,
			discovery,
		}),
	).toBe(false)
})

test('attempt identity storage round-trips and rejects malformed rows', async () => {
	const values = new Map<string, unknown>()
	const storage = {
		get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => {
			values.set(key, value)
		},
		delete: async (key: string | Array<string>) => {
			for (const item of Array.isArray(key) ? key : [key]) {
				values.delete(item)
			}
		},
	}
	const identity = buildMcpOAuthAttemptIdentity({
		serverId: 'srv-1',
		serverUrl,
		clientId: 'client-1',
		ownerOrgId: 'org-1',
		personId: 'person-1',
	})
	expect(identity).not.toBeNull()
	await writeMcpOAuthAttemptIdentity(storage, identity!)
	expect(values.get(mcpOAuthAttemptStorageKey('srv-1'))).toEqual(identity)
	expect(await readMcpOAuthAttemptIdentity(storage, 'srv-1')).toEqual(identity)
	await markMcpOAuthAttemptVerified(storage, 'srv-1')
	expect(await isMcpOAuthAttemptVerified(storage, 'srv-1')).toBe(true)
	// Rewriting the attempt must drop a leftover verified marker.
	await writeMcpOAuthAttemptIdentity(storage, identity!)
	expect(await isMcpOAuthAttemptVerified(storage, 'srv-1')).toBe(false)
	await markMcpOAuthAttemptVerified(storage, 'srv-1')
	await clearMcpOAuthAttemptIdentity(storage, 'srv-1')
	expect(await readMcpOAuthAttemptIdentity(storage, 'srv-1')).toBeNull()
	expect(await isMcpOAuthAttemptVerified(storage, 'srv-1')).toBe(false)
	expect(values.get(mcpOAuthAttemptVerifiedStorageKey('srv-1'))).toBeUndefined()
	expect(parseMcpOAuthAttemptIdentity({ serverId: 'srv-1' })).toBeNull()
	expect(
		parseMcpOAuthAttemptIdentity({
			...identity,
			clientId: '',
		}),
	).toBeNull()
})
