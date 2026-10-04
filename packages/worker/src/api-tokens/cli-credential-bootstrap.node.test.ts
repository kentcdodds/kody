import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parseApiToken } from '@kody-internal/shared/api-token-format.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	cliBootstrapCodePrefix,
	mintCliCredentialBootstrap,
	parseCliBootstrapCode,
	redeemCliCredentialBootstrap,
} from './cli-credential-bootstrap.ts'
import { authenticateApiToken } from './service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const userId = 'stable-user-bootstrap-1'
const start = new Date('2026-10-01T12:00:00.000Z')

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('bootstrap-user', 'bootstrap@example.com', 'hash', ?)`,
		)
		.run(userId)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function at(seconds: number) {
	return new Date(start.getTime() + seconds * 1000)
}

test('bootstrap mint returns a one-shot code, not a kody_at_, and redeem yields a working token', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		now: start,
	})

	expect(minted.bootstrap_code.startsWith(cliBootstrapCodePrefix)).toBe(true)
	expect(minted.cli_command).toBe(
		`npx @kodycodes/cli auth bootstrap --code ${minted.bootstrap_code}`,
	)
	expect(minted.scopes).toEqual(['account:read', 'local-execute'])
	expect(minted.idle_ttl_seconds).toBe(14 * 24 * 60 * 60)
	expect(minted.max_lifetime_seconds).toBe(90 * 24 * 60 * 60)
	expect(parseApiToken(minted.bootstrap_code)).toBeNull()
	expect(parseCliBootstrapCode(minted.bootstrap_code)?.codeId).toBeTruthy()

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		now: at(30),
	})
	expect(redeemed.userId).toBe(userId)
	expect(redeemed.token.created_via).toBe('cli-bootstrap')
	expect(redeemed.token.scopes).toEqual(['account:read', 'local-execute'])
	expect(redeemed.token.idle_ttl_seconds).toBe(14 * 24 * 60 * 60)
	expect(redeemed.token.expires_at).toBe(
		at(30 + 14 * 24 * 60 * 60).toISOString(),
	)
	expect(redeemed.token.max_expires_at).toBe(
		at(30 + 90 * 24 * 60 * 60).toISOString(),
	)
	const auth = await authenticateApiToken({
		db,
		token: redeemed.token.token,
		now: at(60),
	})
	expect(auth.ok && auth.record.user_id).toBe(userId)

	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			now: at(90),
		}),
	).rejects.toBeInstanceOf(McpCallerError)
})

test('bootstrap redeem rejects expired codes', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		redeemTtlSeconds: 60,
		now: start,
	})
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			now: at(120),
		}),
	).rejects.toThrow(/expired/i)
})

test('bootstrap codes issued before a password change are burned and rejected', async () => {
	const { db, sqlite } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		now: start,
	})
	sqlite
		.prepare(
			'UPDATE users SET password_changed_at = ? WHERE stable_user_id = ?',
		)
		.run(at(30).toISOString(), userId)

	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			now: at(60),
		}),
	).rejects.toThrow('Invalid CLI bootstrap code.')
	expect(
		sqlite
			.prepare(
				'SELECT consumed_at FROM cli_credential_bootstrap_codes WHERE user_id = ?',
			)
			.get(userId),
	).toMatchObject({ consumed_at: at(60).toISOString() })
})

test('bootstrap codes issued after a password change can be redeemed', async () => {
	const { db, sqlite } = createDb()
	sqlite
		.prepare(
			'UPDATE users SET password_changed_at = ? WHERE stable_user_id = ?',
		)
		.run(at(30).toISOString(), userId)
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		now: at(60),
	})

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		now: at(90),
	})
	expect(redeemed.userId).toBe(userId)
})

test('bootstrap codes for suspended users are burned and rejected generically', async () => {
	const { db, sqlite } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		now: start,
	})
	sqlite
		.prepare('UPDATE users SET suspended_at = ? WHERE stable_user_id = ?')
		.run(at(30).toISOString(), userId)

	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			now: at(60),
		}),
	).rejects.toThrow('Invalid CLI bootstrap code.')
	expect(
		sqlite
			.prepare(
				'SELECT consumed_at FROM cli_credential_bootstrap_codes WHERE user_id = ?',
			)
			.get(userId),
	).toMatchObject({ consumed_at: at(60).toISOString() })
})

test('bootstrap respects parent token scopes', async () => {
	const { db } = createDb()
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			scopes: ['local-execute', 'packages:write'],
			parent: {
				scopes: ['tokens:write', 'local-execute', 'account:read'],
				maxExpiresAt: at(24 * 60 * 60).toISOString(),
			},
			now: start,
		}),
	).rejects.toThrow(/scopes it does not hold/)
})

test('bootstrap defaults to a 2-week idle TTL and 3-month max lifetime', async () => {
	const { db } = createDb()
	const minted = await mintCliCredentialBootstrap({
		db,
		userId,
		now: start,
	})
	expect(minted.idle_ttl_seconds).toBe(1_209_600)
	expect(minted.max_lifetime_seconds).toBe(7_776_000)

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		now: start,
	})
	expect(redeemed.token.idle_ttl_seconds).toBe(1_209_600)
	expect(redeemed.token.expires_at).toBe(at(1_209_600).toISOString())
	expect(redeemed.token.max_expires_at).toBe(at(7_776_000).toISOString())
})

test('bootstrap rejects idle or max lifetime values above the bootstrap policy caps', async () => {
	const { db } = createDb()
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			idleTtlSeconds: 14 * 24 * 60 * 60 + 1,
			now: start,
		}),
	).rejects.toThrow(/idle_ttl_seconds/)
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			maxLifetimeSeconds: 90 * 24 * 60 * 60 + 1,
			now: start,
		}),
	).rejects.toThrow(/max_lifetime_seconds/)
})
