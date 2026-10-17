import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	assertPackageScopedSecretWriteAvailable,
	packageScopedSecretWriteUnavailableMessage,
} from './package-scoped-secret-write.ts'

test('package scope without a runtime binding fails closed with a clear message', () => {
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'package',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: null,
			},
		}),
	).toThrowError(McpCallerError)
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'package',
			storageContext: null,
		}),
	).toThrowError(packageScopedSecretWriteUnavailableMessage)
})

test('package scope with a binding is allowed through to authorize', () => {
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'package',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: 'pkg-1',
				storageId: 'pkg-1',
			},
		}),
	).not.toThrow()
})

test('user and session scopes are not gated by package binding', () => {
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'user',
			storageContext: null,
		}),
	).not.toThrow()
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'session',
			storageContext: {
				sessionId: 'sess-1',
				appId: null,
				packageId: null,
				storageId: null,
			},
		}),
	).not.toThrow()
})

test('message names local execute and hosted / UI / Open API fixes', () => {
	expect(packageScopedSecretWriteUnavailableMessage).toMatch(
		/kody execute --local/,
	)
	expect(packageScopedSecretWriteUnavailableMessage).toMatch(
		/hosted package execute/,
	)
	expect(packageScopedSecretWriteUnavailableMessage).toMatch(
		/\/connect\/secret-set/,
	)
	expect(packageScopedSecretWriteUnavailableMessage).toMatch(/secretSet/)
	// Do not suggest trusting a client-supplied package id.
	expect(packageScopedSecretWriteUnavailableMessage).toMatch(
		/client-supplied package id is not trusted/,
	)
})

test('assert runs before authorize so insufficient_scope is not the first error', async () => {
	const authorize = vi.fn(async () => {
		throw new Error('authorize should not run')
	})
	try {
		assertPackageScopedSecretWriteAvailable({
			scope: 'package',
			storageContext: null,
		})
		await authorize()
		expect.unreachable('expected assert to throw')
	} catch (error) {
		expect(error).toBeInstanceOf(McpCallerError)
		expect(authorize).not.toHaveBeenCalled()
	}
})
