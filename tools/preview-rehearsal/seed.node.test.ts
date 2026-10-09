import { expect, test } from 'vitest'
import {
	assertNotSeeded,
	classifyRehearsalSeedCount,
	rehearsalSeedEmails,
	rehearsalSeedRosterSize,
	rehearsalSeedStatus,
} from './seed.ts'

function fakeSeedStatusApi(userCount: number) {
	const querySql: Array<string> = []
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input))
		const method = init?.method ?? 'GET'
		const path = url.pathname.replace(/^.*\/d1\/database/, '')
		if (path === '' && method === 'GET') {
			const name = url.searchParams.get('name') ?? ''
			const uuid = name.endsWith('-audit-db')
				? 'audit-uuid'
				: name.endsWith('-jobs-db')
					? 'jobs-uuid'
					: 'app-uuid'
			return Response.json({ success: true, result: [{ name, uuid }] })
		}
		const [, uuid = '', ...rest] = path.split('/')
		const action = rest.join('/')
		if (action === 'query' && method === 'POST' && uuid === 'app-uuid') {
			const sql = String(JSON.parse(String(init?.body)).sql)
			querySql.push(sql)
			return Response.json({
				success: true,
				result: [{ results: [{ n: userCount }] }],
			})
		}
		throw new Error(`unexpected ${method} ${url.pathname}`)
	}
	return {
		fetcher,
		querySql,
		client: {
			accountId: 'acct',
			apiToken: 'token',
			fetcher,
			sleep: async () => {},
		},
	}
}

const worker = 'kody-branch-teams-rehearsal'

test('roster emails are the five people plus the platform account', () => {
	expect(rehearsalSeedRosterSize).toBe(6)
	expect(rehearsalSeedEmails).toEqual([
		'rh-admin@example.com',
		'rh-alice@example.com',
		'rh-bob@example.com',
		'rh-carol@example.com',
		'rh-dave@example.com',
		'rh-platform@example.com',
	])
})

test('classifyRehearsalSeedCount maps count onto empty, partial, or complete', () => {
	expect(classifyRehearsalSeedCount(0)).toBe('empty')
	expect(classifyRehearsalSeedCount(Number.NaN)).toBe('empty')
	expect(classifyRehearsalSeedCount(-1)).toBe('empty')
	expect(classifyRehearsalSeedCount(1)).toBe('partial')
	expect(classifyRehearsalSeedCount(5)).toBe('partial')
	expect(classifyRehearsalSeedCount(6)).toBe('complete')
	expect(classifyRehearsalSeedCount(7)).toBe('complete')
})

test('rehearsalSeedStatus counts every roster email and classifies the live count', async () => {
	const empty = fakeSeedStatusApi(0)
	await expect(rehearsalSeedStatus(empty.client, worker)).resolves.toEqual({
		workerName: worker,
		state: 'empty',
		count: 0,
		expected: 6,
		app: { role: 'app', name: `${worker}-db`, uuid: 'app-uuid' },
	})
	expect(empty.querySql).toHaveLength(1)
	for (const email of rehearsalSeedEmails) {
		expect(empty.querySql[0]).toContain(`'${email}'`)
	}

	const partial = fakeSeedStatusApi(3)
	await expect(
		rehearsalSeedStatus(partial.client, worker),
	).resolves.toMatchObject({ state: 'partial', count: 3, expected: 6 })

	const complete = fakeSeedStatusApi(6)
	await expect(
		rehearsalSeedStatus(complete.client, worker),
	).resolves.toMatchObject({ state: 'complete', count: 6, expected: 6 })
})

test('assertNotSeeded allows an empty roster and refuses partial or complete', async () => {
	const empty = fakeSeedStatusApi(0)
	await expect(assertNotSeeded(empty.client, worker)).resolves.toEqual({
		role: 'app',
		name: `${worker}-db`,
		uuid: 'app-uuid',
	})

	await expect(
		assertNotSeeded(fakeSeedStatusApi(3).client, worker),
	).rejects.toThrow('partial rehearsal roster (3/6)')
	await expect(
		assertNotSeeded(fakeSeedStatusApi(6).client, worker),
	).rejects.toThrow('already has the full rehearsal roster (6/6)')
})
