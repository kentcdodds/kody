import { expect, test, vi } from 'vitest'
import {
	BUILTIN_VECTOR_NAMESPACE,
	queryVectorizeWithNamespaceFallback,
	userVectorNamespace,
} from './vector-namespaces.ts'

type TestVector = {
	id: string
	score: number
	namespace?: string
	userId?: string
}

function createVectorIndex(vectors: ReadonlyArray<TestVector>) {
	const query = vi.fn(
		async (_vector: Array<number>, options?: VectorizeQueryOptions) => {
			const expectedUserId = (
				options?.filter?.['userId'] as { $eq?: string } | undefined
			)?.$eq
			const matches = vectors
				.filter((vector) => vector.namespace === options?.namespace)
				.filter((vector) => !expectedUserId || vector.userId === expectedUserId)
				.map((vector) => ({ id: vector.id, score: vector.score }))
			return { matches, count: matches.length }
		},
	)
	return { index: { query } as unknown as VectorizeIndex, query }
}

test('user namespace queries merge partial reindex results and deny cross-user vectors', async () => {
	const userA = 'a'.repeat(64)
	const userB = 'b'.repeat(64)
	const { index, query } = createVectorIndex([
		{
			id: 'package-user-a-namespaced',
			score: 0.8,
			namespace: userA,
			userId: userA,
		},
		{
			id: 'package-user-a-namespaced',
			score: 0.7,
			userId: userA,
		},
		{ id: 'package-user-a-legacy', score: 0.9, userId: userA },
		{
			id: 'package-user-b',
			score: 0.99,
			namespace: userB,
			userId: userB,
		},
	])
	const options = {
		topK: 2,
		namespace: userB,
		filter: {
			kind: { $eq: 'package' },
			userId: { $eq: userA },
		},
	} satisfies VectorizeQueryOptions

	await expect(
		queryVectorizeWithNamespaceFallback({
			index,
			vector: [0.1, 0.2],
			namespace: userVectorNamespace(userA),
			options,
		}),
	).resolves.toMatchObject({
		matches: [
			{ id: 'package-user-a-legacy', score: 0.9 },
			{ id: 'package-user-a-namespaced', score: 0.8 },
		],
		count: 2,
	})
	expect(query).toHaveBeenNthCalledWith(
		1,
		[0.1, 0.2],
		expect.objectContaining({ namespace: userA, filter: options.filter }),
	)
	expect(query).toHaveBeenNthCalledWith(
		2,
		[0.1, 0.2],
		expect.objectContaining({ filter: options.filter }),
	)
	expect(query.mock.calls[1]?.[1]).not.toHaveProperty('namespace')
	expect(query).toHaveBeenCalledTimes(2)
	expect(BUILTIN_VECTOR_NAMESPACE).not.toMatch(/^[a-f0-9]{64}$/)
})
