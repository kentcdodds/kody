import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { parseApiToken } from '@kody-internal/shared/api-token-format.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	cliBootstrapCodePrefix,
	cliCredentialBootstrapPolicy,
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
		allowLocalExecute: true,
		now: start,
	})

	expect(minted.bootstrap_code.startsWith(cliBootstrapCodePrefix)).toBe(true)
	expect(minted.cli_command).toBe(
		cliCredentialBootstrapPolicy.cliCommand(minted.bootstrap_code),
	)
	expect(minted.scopes).toEqual(['account:read', 'local-execute'])
	expect(parseApiToken(minted.bootstrap_code)).toBeNull()
	expect(parseCliBootstrapCode(minted.bootstrap_code)?.codeId).toBeTruthy()

	const redeemed = await redeemCliCredentialBootstrap({
		db,
		code: minted.bootstrap_code,
		allowLocalExecuteForUser: async () => true,
		now: at(30),
	})
	expect(redeemed.userId).toBe(userId)
	expect(redeemed.token.created_via).toBe('cli-bootstrap')
	expect(redeemed.token.scopes).toEqual(['account:read', 'local-execute'])
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
			allowLocalExecuteForUser: async () => true,
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
		allowLocalExecute: true,
		now: start,
	})
	await expect(
		redeemCliCredentialBootstrap({
			db,
			code: minted.bootstrap_code,
			allowLocalExecuteForUser: async () => true,
			now: at(120),
		}),
	).rejects.toThrow(/expired/i)
})

test('bootstrap respects parent token scopes', async () => {
	const { db } = createDb()
	await expect(
		mintCliCredentialBootstrap({
			db,
			userId,
			scopes: ['local-execute', 'packages:write'],
			allowLocalExecute: true,
			parent: {
				scopes: ['tokens:write', 'local-execute', 'account:read'],
				maxExpiresAt: at(24 * 60 * 60).toISOString(),
			},
			now: start,
		}),
	).rejects.toThrow(/scopes it does not hold/)
})
