import { describe, expect, test } from 'vitest'
import {
	resolveTokenIdInput,
	tokenIdInputSchemaForTests,
} from './token-operations.ts'

describe('tokenIdInputSchema', () => {
	test('accepts token_id, id, or matching both', () => {
		expect(
			resolveTokenIdInput(
				tokenIdInputSchemaForTests.parse({ token_id: 'tok_a' }),
			),
		).toBe('tok_a')
		expect(
			resolveTokenIdInput(tokenIdInputSchemaForTests.parse({ id: 'tok_b' })),
		).toBe('tok_b')
		expect(
			resolveTokenIdInput(
				tokenIdInputSchemaForTests.parse({ token_id: 'tok_c', id: 'tok_c' }),
			),
		).toBe('tok_c')
		expect(tokenIdInputSchemaForTests.safeParse({}).success).toBe(false)
		expect(
			tokenIdInputSchemaForTests.safeParse({
				token_id: 'tok_a',
				id: 'tok_b',
			}).success,
		).toBe(false)
	})
})
