import { expect, test, vi } from 'vitest'
import {
	BUILTIN_VECTOR_NAMESPACE,
	queryVectorizeWithNamespaceFallback,
	userVectorNamespace,
} from './vector-namespaces.ts'

type TestVector = {
	id: string
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
				.map((vector) => ({ id: vector.id, score: 1 }))
			return { matches, count: matches.length }
		},
	)
	return { index: { query } as unknown as VectorizeIndex, query }
}

test('user namespace queries deny cross-user vectors and fall back to legacy metadata-scoped vectors', async () => {
	const userA = 'a'.repeat(64)
	const userB = 'b'.repeat(64)
	const { index, query } = createVectorIndex([
		{ id: 'package-user-b', namespace: userB, userId: userB },
		{ id: 'package-user-a-legacy', userId: userA },
	])
	const options = {
		topK: 10,
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
		matches: [{ id: 'package-user-a-legacy' }],
	})
	expect(query).toHaveBeenNthCalledWith(
		1,
		[0.1, 0.2],
		expect.objectContaining({ namespace: userA, filter: options.filter }),
	)
	expect(query).toHaveBeenNthCalledWith(
		2,
		[0.1, 0.2],
		expect.not.objectContaining({ namespace: expect.anything() }),
	)
	expect(
		query.mock.results.flatMap((result) =>
			result.type === 'return' ? [result.value] : [],
		),
	).toHaveLength(2)

	query.mockClear()
	const namespaced = createVectorIndex([
		{ id: 'package-user-a', namespace: userA, userId: userA },
		{ id: 'package-user-b', namespace: userB, userId: userB },
	])
	await expect(
		queryVectorizeWithNamespaceFallback({
			index: namespaced.index,
			vector: [0.1, 0.2],
			namespace: userVectorNamespace(userA),
			options,
		}),
	).resolves.toMatchObject({
		matches: [{ id: 'package-user-a' }],
	})
	expect(namespaced.query).toHaveBeenCalledTimes(1)
	expect(BUILTIN_VECTOR_NAMESPACE).not.toMatch(/^[a-f0-9]{64}$/)
})
