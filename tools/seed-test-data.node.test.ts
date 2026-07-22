import { expect, test } from 'vitest'

import { toHex } from '../packages/shared/src/hex.ts'
import { stableUserIdFromEmail } from './seed-sql.ts'
import {
	buildSeedSql,
	shouldSeedCompanionAccount,
	parseArgs,
	resolveWranglerEnv,
} from './seed-test-data.ts'

test('seed data arg parsing defaults to local mode and derives usernames from email unless overridden', () => {
	const defaultOptions = parseArgs(['--email', 'alice.dev+preview@example.com'])
	expect(defaultOptions.local).toBe(true)
	expect(defaultOptions.remote).toBe(false)
	expect(defaultOptions.email).toBe('alice.dev+preview@example.com')
	expect(defaultOptions.username).toBe('alice-dev-preview')
	expect(defaultOptions.env).toBe('production')

	const explicitUsernameOptions = parseArgs([
		'--email',
		'alice@example.com',
		'--username',
		'alice',
		'--local',
	])
	expect(explicitUsernameOptions.email).toBe('alice@example.com')
	expect(explicitUsernameOptions.username).toBe('alice')

	const adminOptions = parseArgs(['--local', '--admin'])
	expect(adminOptions.admin).toBe(true)

	expect(
		resolveWranglerEnv({
			config: 'packages/worker/wrangler-preview.generated.json',
		}),
	).toBe('preview')
})

test('seed data grants admin to the default fixture account only', () => {
	// Default account (kody@example.com) is admin so RBAC is testable.
	const defaultOptions = parseArgs(['--local'])
	expect(defaultOptions.email).toBe('kody@example.com')
	expect(defaultOptions.admin).toBe(true)

	// Custom accounts stay non-admin unless requested.
	const customOptions = parseArgs(['--local', '--email', 'me@example.com'])
	expect(customOptions.admin).toBe(false)

	const customAdminOptions = parseArgs([
		'--local',
		'--email',
		'me@example.com',
		'--admin',
	])
	expect(customAdminOptions.admin).toBe(true)

	// --no-admin opts the default account out.
	const optOutOptions = parseArgs(['--local', '--no-admin'])
	expect(optOutOptions.admin).toBe(false)
})

test('buildSeedSql seeds each account with its roles', () => {
	const sql = buildSeedSql([
		{
			email: 'kody@example.com',
			username: 'kody',
			passwordHash: 'hash-a',
			admin: true,
		},
		{
			email: 'jane@example.com',
			username: 'jane',
			passwordHash: 'hash-b',
			admin: false,
		},
	])

	expect(sql).toContain(`'kody@example.com'`)
	expect(sql).toContain(`'jane@example.com'`)
	// Both accounts get the user role; only the admin account gets admin.
	expect(sql.match(/r\.name = 'user'/g)).toHaveLength(2)
	expect(sql.match(/r\.name = 'admin'/g)).toHaveLength(1)
	expect(sql).toContain(
		`WHERE u.email = 'kody@example.com' AND r.name = 'admin'`,
	)
})

test('seeded users carry the same stable id the signup path derives', async () => {
	const email = 'Kody+Mixed.Case@Example.com '
	// Reference implementation mirroring the worker's async derivation in
	// `packages/worker/src/user-id.ts` (`createStableUserIdFromEmail`): the
	// sync seeding helper must stay byte-identical so fixtures match signup.
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(email.trim().toLowerCase()),
	)
	expect(stableUserIdFromEmail(email)).toBe(toHex(new Uint8Array(digest)))
	const sql = buildSeedSql([
		{
			email: 'kody@example.com',
			username: 'kody',
			passwordHash: 'hash-a',
			admin: true,
		},
	])
	expect(sql).toContain(stableUserIdFromEmail('kody@example.com'))
})

test('companion fixture account is local-only', () => {
	expect(
		shouldSeedCompanionAccount({ local: true, email: 'kody@example.com' }),
	).toBe(true)
	// Never seed the fixed-password companion into remote environments.
	expect(
		shouldSeedCompanionAccount({ local: false, email: 'kody@example.com' }),
	).toBe(false)
	// Avoid duplicating the companion when it is the primary account.
	expect(
		shouldSeedCompanionAccount({ local: true, email: 'jane@example.com' }),
	).toBe(false)
})
