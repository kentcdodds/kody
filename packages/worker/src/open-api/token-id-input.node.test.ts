import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	resolveTokenIdInput,
	tokenIdInputSchemaForTests,
} from './token-operations.ts'

test('tokenIdInputSchema accepts token_id, id, or matching both', () => {
	assert.equal(
		resolveTokenIdInput(
			tokenIdInputSchemaForTests.parse({ token_id: 'tok_a' }),
		),
		'tok_a',
	)
	assert.equal(
		resolveTokenIdInput(tokenIdInputSchemaForTests.parse({ id: 'tok_b' })),
		'tok_b',
	)
	assert.equal(
		resolveTokenIdInput(
			tokenIdInputSchemaForTests.parse({ token_id: 'tok_c', id: 'tok_c' }),
		),
		'tok_c',
	)
	assert.equal(tokenIdInputSchemaForTests.safeParse({}).success, false)
	assert.equal(
		tokenIdInputSchemaForTests.safeParse({
			token_id: 'tok_a',
			id: 'tok_b',
		}).success,
		false,
	)
})
