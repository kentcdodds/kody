import { expect, test } from 'vitest'
import {
	buildProviderSecretPlaceholder,
	containsSecretPlaceholder,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
} from '#mcp/secrets/placeholders.ts'
import {
	canonicalizeOpSecretReference,
	isCanonicalProviderRef,
	tryCanonicalizeProviderRef,
} from './canonicalize.ts'
import { providerHostsAllowRequestHost } from './hosts.ts'
import { isSealedSecretProviderExport } from './sealed-export.ts'

test('provider placeholders split on the first colon after secret/ and leave user secrets unchanged', () => {
	const text = [
		'Authorization: Bearer {{secret/1password:i/11111111-1111-4111-8111-111111111111/password}}',
		'X-User: {{secret:githubAccessToken}}',
		'X-Op: {{secret/1password:op://Vault/Item/password}}',
		'X-Scoped: {{secret:token|scope=user}}',
	].join('\n')

	expect(parseSecretPlaceholders(text)).toEqual([
		{ name: 'githubAccessToken', scope: null },
		{ name: 'token', scope: 'user' },
	])
	expect(parseProviderSecretPlaceholders(text)).toEqual([
		{
			provider: '1password',
			ref: 'i/11111111-1111-4111-8111-111111111111/password',
		},
		{ provider: '1password', ref: 'op://Vault/Item/password' },
	])
	expect(
		buildProviderSecretPlaceholder({
			provider: '1password',
			ref: 'i/11111111-1111-4111-8111-111111111111/password',
		}),
	).toBe('{{secret/1password:i/11111111-1111-4111-8111-111111111111/password}}')
	expect(containsSecretPlaceholder('{{secret/1password:i/x/y}}')).toBe(true)
	expect(containsSecretPlaceholder('{{secret:name}}')).toBe(true)
	expect(
		containsSecretPlaceholder('{{secret-basic:username=a,password=b}}'),
	).toBe(true)
	expect(containsSecretPlaceholder('plain text')).toBe(false)
})

test('canonicalize maps op:// UUID synonyms to i/<uuid>/<field> and leaves name-based refs for the provider', () => {
	const itemId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	expect(tryCanonicalizeProviderRef(`i/${itemId}/password`)).toBe(
		`i/${itemId}/password`,
	)
	expect(tryCanonicalizeProviderRef(`op://Personal/${itemId}/password`)).toBe(
		`i/${itemId}/password`,
	)
	expect(
		canonicalizeOpSecretReference(`op://Work/${itemId}/section/field`),
	).toBe(`i/${itemId}/section/field`)
	expect(tryCanonicalizeProviderRef('op://Vault/Item/password')).toBeNull()
	expect(isCanonicalProviderRef('op://Vault/Item/password')).toBe(false)
	expect(isCanonicalProviderRef(`i/${itemId}/password`)).toBe(true)
})

test('provider host match uses hostname only and empty hosts deny every use', () => {
	expect(
		providerHostsAllowRequestHost(
			['https://app.example.com/login'],
			'app.example.com',
		),
	).toBe(true)
	expect(
		providerHostsAllowRequestHost(
			['https://app.example.com/login'],
			'other.example.com',
		),
	).toBe(false)
	expect(providerHostsAllowRequestHost([], 'app.example.com')).toBe(false)
	expect(providerHostsAllowRequestHost(['https://'], 'app.example.com')).toBe(
		false,
	)
})

test('sealed secret-provider export names are reserved', () => {
	expect(isSealedSecretProviderExport('secretProvider')).toBe(true)
	expect(isSealedSecretProviderExport('./secretProvider')).toBe(true)
	expect(isSealedSecretProviderExport('./run')).toBe(false)
})
