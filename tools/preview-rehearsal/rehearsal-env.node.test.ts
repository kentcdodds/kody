import { expect, test } from 'vitest'
import {
	deriveRehearsalPassword,
	rehearsalOrigins,
	rehearsalUsers,
} from './rehearsal-env.ts'

test('rehearsal passwords are deterministic per preview and role, and distinct otherwise', async () => {
	const base = { key: 'ci-token', workerName: 'kody-branch-teams-rehearsal' }
	const alice = await deriveRehearsalPassword({ ...base, role: 'alice' })
	expect(alice).toBe(await deriveRehearsalPassword({ ...base, role: 'alice' }))
	expect(alice).toMatch(/^Rh-[A-Za-z0-9_-]{32}$/)
	const others = await Promise.all([
		deriveRehearsalPassword({ ...base, role: 'bob' }),
		deriveRehearsalPassword({
			...base,
			workerName: 'kody-branch-other',
			role: 'alice',
		}),
		deriveRehearsalPassword({ ...base, key: 'rotated-token', role: 'alice' }),
	])
	expect(new Set([alice, ...others]).size).toBe(4)
	await expect(
		deriveRehearsalPassword({ ...base, key: ' ', role: 'alice' }),
	).rejects.toThrow('Missing rehearsal password key')
	await expect(
		deriveRehearsalPassword({
			...base,
			workerName: 'kody-pr-12',
			role: 'alice',
		}),
	).rejects.toThrow('rehearsals run only on branch previews')
})

test('roster covers both id shapes and exactly one site admin', () => {
	expect(new Set(rehearsalUsers.map((user) => user.origin))).toEqual(
		new Set(['seed-sql', 'admin-create', 'signup']),
	)
	expect(
		rehearsalUsers.filter((user) => user.siteAdmin).map((user) => user.role),
	).toEqual(['admin'])
})

test('origins follow the preview worker naming', () => {
	expect(rehearsalOrigins('kody-branch-teams-rehearsal', 'kody-a99')).toEqual({
		app: 'https://kody-branch-teams-rehearsal.kody-a99.workers.dev',
		api: 'https://kody-branch-teams-rehearsal-api.kody-a99.workers.dev',
		mockCloudflare:
			'https://kody-branch-teams-rehearsal-mock-cloudflare.kody-a99.workers.dev',
	})
	expect(() => rehearsalOrigins('kody-production', 'kody-a99')).toThrow(
		'rehearsals run only on branch previews',
	)
})
