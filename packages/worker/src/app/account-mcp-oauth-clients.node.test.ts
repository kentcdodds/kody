import { expect, test, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listActiveUserMcpOauthClientIds,
	listUserMcpOauthClients,
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
	expect(parseClientLabel('')).toEqual({
		ok: false,
		error: 'Enter a label for this client.',
	})
	expect(parseClientLabel('  Open WebUI  ')).toEqual({
		ok: true,
		label: 'Open WebUI',
	})
	expect(parseRedirectUriText('')).toEqual({
		ok: false,
		error: 'Enter at least one redirect URI.',
	})
	expect(parseRedirectUriText('javascript:alert(1)')).toEqual({
		ok: false,
		error: 'Redirect URIs must use http or https: javascript:alert(1)',
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
