/// <reference types="bun" />
import { expect, test } from 'bun:test'
import { createMcpCallerContext, parseMcpCallerContext } from './context.ts'

test('createMcpCallerContext normalizes missing user to null', () => {
	expect(
		createMcpCallerContext({
			baseUrl: 'https://example.com',
		}),
	).toEqual({
		baseUrl: 'https://example.com',
		user: null,
	})
})

test('parseMcpCallerContext validates caller context shape', () => {
	expect(
		parseMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: '123',
				email: 'user@example.com',
				displayName: 'user',
			},
		}),
	).toEqual({
		baseUrl: 'https://example.com',
		user: {
			userId: '123',
			email: 'user@example.com',
			displayName: 'user',
		},
	})
})
