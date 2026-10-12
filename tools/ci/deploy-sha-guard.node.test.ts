import { expect, test } from 'vitest'
import {
	decideProductionDeploy,
	parseLiveCommitSha,
} from './deploy-sha-guard.ts'

const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const c = 'c'.repeat(40)
const unrelated = 'd'.repeat(40)

// Linear main history a -> b -> c.
const order = [a, b, c]
function isAncestor(ancestor: string, descendant: string) {
	const from = order.indexOf(ancestor)
	const to = order.indexOf(descendant)
	return from !== -1 && to !== -1 && from <= to
}

function decide(input: {
	eventName?: string
	deploySha: string
	headSha?: string
	liveSha: string | null
}) {
	let liveReads = 0
	const decision = decideProductionDeploy({
		eventName: input.eventName ?? 'workflow_run',
		deploySha: input.deploySha,
		headSha: input.headSha ?? c,
		readLiveSha: async () => {
			liveReads += 1
			return input.liveSha
		},
		isAncestor,
	})
	return decision.then((result) => ({ ...result, liveReads }))
}

test('main HEAD always deploys without reading production', async () => {
	await expect(decide({ deploySha: c, liveSha: null })).resolves.toMatchObject({
		deploy: true,
		liveReads: 0,
	})
	await expect(
		decide({ eventName: 'workflow_dispatch', deploySha: c, liveSha: null }),
	).resolves.toMatchObject({ deploy: true, liveReads: 0 })
})

test('an older validated main commit deploys only when production is behind it', async () => {
	await expect(decide({ deploySha: b, liveSha: a })).resolves.toMatchObject({
		deploy: true,
	})
	await expect(decide({ deploySha: b, liveSha: b })).resolves.toMatchObject({
		deploy: false,
	})
	await expect(decide({ deploySha: a, liveSha: b })).resolves.toMatchObject({
		deploy: false,
	})
	await expect(
		decide({ deploySha: b, liveSha: unrelated }),
	).resolves.toMatchObject({ deploy: false })
	await expect(decide({ deploySha: b, liveSha: null })).resolves.toMatchObject({
		deploy: false,
	})
})

test('non-HEAD targets outside workflow_run or off main never deploy', async () => {
	await expect(
		decide({ eventName: 'workflow_dispatch', deploySha: b, liveSha: a }),
	).resolves.toMatchObject({ deploy: false, liveReads: 0 })
	await expect(
		decide({ deploySha: unrelated, liveSha: a }),
	).resolves.toMatchObject({ deploy: false, liveReads: 0 })
})

test('parseLiveCommitSha reads only a full commitSha from /health', () => {
	expect(parseLiveCommitSha(JSON.stringify({ ok: true, commitSha: a }))).toBe(a)
	expect(
		parseLiveCommitSha(JSON.stringify({ ok: true, commitSha: null })),
	).toBe(null)
	expect(parseLiveCommitSha(JSON.stringify({ commitSha: 'abc123' }))).toBe(null)
	expect(parseLiveCommitSha('<html>')).toBe(null)
})
