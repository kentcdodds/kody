import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import {
	assertCredentialScopeAllows,
	type ResolverCall,
} from './credential-resolver.ts'

function callWithScopes(scopes: ReadonlyArray<string> | null): ResolverCall {
	return {
		input: {
			env: {} as Env,
			orgId: ownerIdFromStored('org-acme'),
			baseUrl: 'https://example.com',
			actor: scopes
				? {
						actor: { userId: personIdFromStored('person-1') },
						credential: { scopes },
					}
				: undefined,
		},
		credential: { use: 'secret', name: 'token' },
		subject: { name: 'token', credentialId: 'cred-1' },
	} as unknown as ResolverCall
}

test('assertCredentialScopeAllows accepts session actors and tokens that list the permission', () => {
	expect(() =>
		assertCredentialScopeAllows(callWithScopes(null), 'secret:use'),
	).not.toThrow()
	expect(() =>
		assertCredentialScopeAllows(
			callWithScopes(['secret:use', 'org:read']),
			'secret:use',
		),
	).not.toThrow()
})

test('assertCredentialScopeAllows refuses scoped tokens missing the family permission', () => {
	try {
		assertCredentialScopeAllows(callWithScopes(['org:read']), 'secret:use')
		expect.unreachable('expected AuthorizationError')
	} catch (error) {
		expect(error).toBeInstanceOf(AuthorizationError)
		expect(error).toMatchObject({
			code: 'credential_scope',
			permission: 'secret:use',
		})
	}
})
