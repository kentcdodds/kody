import { expect, test } from 'vitest'
import { credentialStampConvertMessages } from '#worker/credentials/credential-stamp-convert.ts'
import {
	convertCredentialStampsCodemod,
	convertCredentialStampsCodemodId,
} from './0015-convert-credential-stamps.ts'

const packageContext = { packageName: '@acme/demo' }

function manifest(kody: Record<string, unknown> = {}) {
	return `${JSON.stringify(
		{
			name: '@acme/demo',
			exports: { '.': './index.ts' },
			kody: { description: 'Demo package.', ...kody },
		},
		null,
		'\t',
	)}\n`
}

test('0015 id matches the convert module export', () => {
	expect(convertCredentialStampsCodemod.id).toBe(
		convertCredentialStampsCodemodId,
	)
	expect(convertCredentialStampsCodemod.applyMode).toBe('published-only')
})

test('0015 leaves |scope=package alone and does not rewrite', () => {
	const files = {
		'package.json': manifest(),
		'index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	}
	const result = convertCredentialStampsCodemod.transform(files, packageContext)
	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(result.needsManual[0]?.message).toBe(
		credentialStampConvertMessages.unconvertible,
	)
})

test('0015 seals literal credential() and declares side-effect remix', () => {
	const result = convertCredentialStampsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': [
				"import 'remix/setup'",
				"import { credential } from 'kody:runtime'",
				'export default async function run() {',
				'\treturn credential("TOKEN")',
				'}',
			].join('\n'),
		},
		packageContext,
	)
	expect(result.changed).toBe(true)
	expect(result.needsManual).toEqual([])
	const parsed = JSON.parse(result.files['package.json']!)
	expect(parsed.dependencies.remix).toBe('3.0.0')
	expect(parsed.kody.credentials.TOKEN.description).toMatch(/TOKEN/)
})

test('0015 skips holdouts', () => {
	const files = {
		'package.json': manifest(),
		'index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	}
	const result = convertCredentialStampsCodemod.transform(files, {
		packageName: '@kentcdodds/oauth-integration-health',
	})
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([
		{ path: null, message: credentialStampConvertMessages.holdout },
	])
	expect(result.files).toEqual(files)
})

test('0015 skips unconvertible computed names', () => {
	const result = convertCredentialStampsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts': [
				"import { credential } from 'kody:runtime'",
				'export default async function run(key: string) {',
				'\treturn credential(key)',
				'}',
			].join('\n'),
		},
		packageContext,
	)
	expect(result.changed).toBe(false)
	expect(result.needsManual[0]?.message).toBe(
		credentialStampConvertMessages.unconvertible,
	)
})
