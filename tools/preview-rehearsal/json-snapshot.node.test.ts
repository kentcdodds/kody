import { expect, test } from 'vitest'
import { diffSnapshots, stripVolatile } from './json-snapshot.ts'

test('stripVolatile drops per-read fields but keeps job schedules', () => {
	expect(
		stripVolatile({
			jobs: [
				{ id: 'j1', next_run_at: '2026-10-09T00:00:00Z', last_run_at: 'x' },
			],
			updated_at: 'x',
			serverTiming: [{ name: 'a', durationMs: 1 }],
			matches: [{ id: 'm1', mutation_guidance: 'x' }],
		}),
	).toEqual({
		jobs: [{ id: 'j1', next_run_at: '2026-10-09T00:00:00Z' }],
		matches: [{ id: 'm1' }],
	})
})

test('diffSnapshots reports changed, added, and removed paths, ignoring takenAt and observed', () => {
	const before = {
		takenAt: 'a',
		people: [
			{
				role: 'alice',
				tokens: [{ id: 't1' }],
				proofs: { user: 'h1' },
				observed: { usage: { executes: 3 } },
			},
		],
	}
	const after = {
		takenAt: 'b',
		people: [
			{
				role: 'alice',
				tokens: [{ id: 't1' }, { id: 't2' }],
				proofs: { user: 'h2' },
				observed: { usage: { executes: 9 } },
			},
		],
	}
	expect(diffSnapshots(before, before)).toEqual([])
	expect(diffSnapshots(before, after)).toEqual([
		{ path: '.people[0].proofs.user', before: 'h1', after: 'h2' },
		{ path: '.people[0].tokens[1]', before: undefined, after: { id: 't2' } },
	])
})
