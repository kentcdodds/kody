import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	BUILTIN_VECTOR_NAMESPACE,
	userVectorNamespace,
} from './vector-namespaces.ts'

test('Vectorize namespace builders keep user and builtin partitions distinct', () => {
	const userId = ownerIdFromStored('a'.repeat(64))
	expect(userVectorNamespace(userId)).toBe(userId)
	expect(BUILTIN_VECTOR_NAMESPACE).not.toMatch(/^[a-f0-9]{64}$/)
	expect(
		new TextEncoder().encode(BUILTIN_VECTOR_NAMESPACE).length,
	).toBeLessThanOrEqual(64)
})
