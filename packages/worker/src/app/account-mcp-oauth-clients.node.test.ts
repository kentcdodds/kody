import { expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listActiveUserMcpOauthClientIds,
	listUserMcpOauthClients,
	maxUserMcpOauthClients,
	mintUserMcpOauthClient,
	parseClientLabel,
	parseRedirectUriText,
	revokeUserMcpOauthClient,
} from './account-mcp-oauth-clients.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('parseClientLabel and parseRedirectUriText reject empty and unsafe values', () => {
	expect(parseClientLabel('')).toMatchObject({ ok: false })
	expect(parseClientLabel('  Open WebUI  ')).toEqual({
		ok: true,
		label: 'Open WebUI',
	})
	expect(parseRedirectUriText('')).toMatchObject({ ok: false })
	expect(parseRedirectUriText('javascript:alert(1)')).toMatchObject({
		ok: false,
	})
	expect(
		parseRedirectUriText(
			'https://openwebui.example/oauth/clients/mcp:kody/callback#x',
		),
	).toMatchObject({ ok: false })
	expect(
		parseRedirectUriText(
			'http://100.64.0.2:8080/oauth/clients/mcp:kody/callback\nhttps://openwebui.example/oauth/clients/mcp:kody/callback\nhttp://100.64.0.2:8080/oauth/clients/mcp:kody/callback',
		),
	).toEqual({
		ok: true,
		uris: [
			'http://100.64.0.2:8080/oauth/clients/mcp:kody/callback',
			'https://openwebui.example/oauth/clients/mcp:kody/callback',
		],
	})
})

test('mint stores ownership without the secret and revoke deletes the provider client', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		VALUES (1, 'one', 'one@example.com', 'user-one', 'hash', CURRENT_TIMESTAMP);
	`)

	const deleteClient = vi.fn(async () => undefined)
	const helpers = {
		createClient: vi.fn(async () => ({
			clientId: 'oauth-client-1',
			clientSecret: 'plain-secret-once',
		})),
		deleteClient,
	}

	const minted = await mintUserMcpOauthClient({
		db,
		helpers,
		userId: 1,
		label: 'Open WebUI',
		redirectUris: ['http://100.64.0.2:8080/oauth/clients/mcp:kody/callback'],
	})
	expect(minted.ok).toBe(true)
	if (!minted.ok) throw new Error('expected mint to succeed')
	expect(minted.client.clientSecret).toBe('plain-secret-once')
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toEqual([
		'oauth-client-1',
	])

	const listed = await listUserMcpOauthClients(db, 1)
	expect(listed).toEqual([
		{
			id: minted.client.id,
			label: 'Open WebUI',
			clientId: 'oauth-client-1',
			redirectUris: ['http://100.64.0.2:8080/oauth/clients/mcp:kody/callback'],
			createdAt: minted.client.createdAt,
			revokedAt: null,
		},
	])
	expect(JSON.stringify(listed)).not.toContain('plain-secret-once')

	const revoked = await revokeUserMcpOauthClient({
		db,
		helpers,
		userId: 1,
		id: minted.client.id,
	})
	expect(revoked).toEqual({ ok: true })
	expect(deleteClient).toHaveBeenCalledWith('oauth-client-1')
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toEqual([])
	expect((await listUserMcpOauthClients(db, 1))[0]?.revokedAt).toBeTruthy()
})

test('mint rolls back the provider client when D1 insert fails', async () => {
	const { db } = createMigratedDb()
	const deleteClient = vi.fn(async () => undefined)
	const helpers = {
		createClient: vi.fn(async () => ({
			clientId: 'oauth-client-orphan',
			clientSecret: 'secret',
		})),
		deleteClient,
	}

	await expect(
		mintUserMcpOauthClient({
			db,
			helpers,
			userId: 99,
			label: 'Broken',
			redirectUris: ['https://example.com/callback'],
		}),
	).rejects.toThrow(/FOREIGN KEY|constraint/i)
	expect(deleteClient).toHaveBeenCalledWith('oauth-client-orphan')
})

test('mint rejects an eleventh active client and deletes the unused provider client', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		VALUES (1, 'one', 'one@example.com', 'user-one', 'hash', CURRENT_TIMESTAMP);
	`)
	const deleteClient = vi.fn(async () => undefined)
	let created = 0
	const helpers = {
		createClient: vi.fn(async () => {
			created += 1
			return {
				clientId: `oauth-client-${created}`,
				clientSecret: 'secret',
			}
		}),
		deleteClient,
	}

	for (let index = 0; index < maxUserMcpOauthClients; index += 1) {
		const minted = await mintUserMcpOauthClient({
			db,
			helpers,
			userId: 1,
			label: `Client ${index + 1}`,
			redirectUris: ['https://example.com/callback'],
		})
		expect(minted.ok).toBe(true)
	}

	const overLimit = await mintUserMcpOauthClient({
		db,
		helpers,
		userId: 1,
		label: 'Too many',
		redirectUris: ['https://example.com/callback'],
	})
	expect(overLimit).toMatchObject({ ok: false, status: 400 })
	expect(helpers.createClient).toHaveBeenCalledTimes(maxUserMcpOauthClients)
	expect(deleteClient).not.toHaveBeenCalled()
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toHaveLength(
		maxUserMcpOauthClients,
	)
})

test('quota-race mint keeps a revoked ownership row when deleteClient fails', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
		VALUES (1, 'one', 'one@example.com', 'user-one', 'hash', CURRENT_TIMESTAMP);
	`)
	const helpers = {
		createClient: vi.fn(async () => ({
			clientId: 'oauth-client-race',
			clientSecret: 'secret',
		})),
		deleteClient: vi.fn(async () => {
			throw new Error('provider delete failed')
		}),
	}

	for (let index = 0; index < maxUserMcpOauthClients - 1; index += 1) {
		const minted = await mintUserMcpOauthClient({
			db,
			helpers: {
				createClient: vi.fn(async () => ({
					clientId: `oauth-client-${index + 1}`,
					clientSecret: 'secret',
				})),
				deleteClient: vi.fn(async () => undefined),
			},
			userId: 1,
			label: `Client ${index + 1}`,
			redirectUris: ['https://example.com/callback'],
		})
		expect(minted.ok).toBe(true)
	}

	const raced = await mintUserMcpOauthClient({
		db,
		helpers: {
			createClient: async () => {
				sqlite.exec(`
					INSERT INTO user_mcp_oauth_clients (
						id, user_id, client_id, label, redirect_uris_json, created_at
					) VALUES (
						'seeded-tenth', 1, 'oauth-client-tenth', 'Tenth',
						'["https://example.com/callback"]', '2026-08-21T00:00:00.000Z'
					);
				`)
				return {
					clientId: 'oauth-client-race',
					clientSecret: 'secret',
				}
			},
			deleteClient: helpers.deleteClient,
		},
		userId: 1,
		label: 'Raced',
		redirectUris: ['https://example.com/callback'],
	})
	expect(raced).toMatchObject({ ok: false, status: 400 })
	expect(helpers.deleteClient).toHaveBeenCalledWith('oauth-client-race')
	expect(await listActiveUserMcpOauthClientIds(db, 1)).toHaveLength(
		maxUserMcpOauthClients,
	)
	const listed = await listUserMcpOauthClients(db, 1)
	expect(listed.some((client) => client.clientId === 'oauth-client-race')).toBe(
		true,
	)
	expect(
		listed.find((client) => client.clientId === 'oauth-client-race')?.revokedAt,
	).toBeTruthy()
})
