import { expect, test } from 'vitest'
import {
	isLocalAppOrigin,
	looksLikeUnreadyLocalAppDb,
	withLocalAppDbRemediation,
} from './local-app-db.ts'

const localSeeds = ['jane@example.com', 'kody@example.com']

test('local APP_DB readiness matches localhost login failures and appends remediation', () => {
	expect(isLocalAppOrigin('http://127.0.0.1:3742')).toBe(true)
	expect(isLocalAppOrigin('https://kody-pr-9.kody.workers.dev')).toBe(false)

	expect(
		looksLikeUnreadyLocalAppDb({
			origin: 'http://localhost:3742',
			status: 500,
			detail: 'HTTP 500 {"error":"Internal Error"}',
			email: 'jane@example.com',
			localSeedEmails: localSeeds,
		}),
	).toBe(false)
	expect(
		looksLikeUnreadyLocalAppDb({
			origin: 'http://localhost:3742',
			status: 500,
			detail: 'HTTP 500 no such table: users',
			email: 'jane@example.com',
			localSeedEmails: localSeeds,
		}),
	).toBe(true)
	expect(
		looksLikeUnreadyLocalAppDb({
			origin: 'http://localhost:3742',
			status: 401,
			detail: 'HTTP 401 {"error":"Invalid email or password."}',
			email: 'jane@example.com',
			localSeedEmails: localSeeds,
		}),
	).toBe(true)
	expect(
		looksLikeUnreadyLocalAppDb({
			origin: 'http://localhost:3742',
			status: 401,
			detail: 'HTTP 401 {"error":"Invalid email or password."}',
			email: 'other@example.com',
			localSeedEmails: localSeeds,
		}),
	).toBe(false)
	expect(
		looksLikeUnreadyLocalAppDb({
			origin: 'https://kody-pr-9.kody.workers.dev',
			status: 500,
			detail: 'HTTP 500',
			email: 'me@kentcdodds.com',
			localSeedEmails: localSeeds,
		}),
	).toBe(false)

	const detail = withLocalAppDbRemediation(
		'http://localhost:3742',
		{
			status: 500,
			detail: 'HTTP 500 no such table: users',
			email: 'jane@example.com',
		},
		localSeeds,
	)
	expect(detail.startsWith('HTTP 500 no such table: users')).toBe(true)
	expect(detail).not.toBe('HTTP 500 no such table: users')
	expect(
		withLocalAppDbRemediation(
			'https://kody-pr-9.kody.workers.dev',
			{ status: 500, detail: 'HTTP 500 boom' },
			localSeeds,
		),
	).toBe('HTTP 500 boom')
})
