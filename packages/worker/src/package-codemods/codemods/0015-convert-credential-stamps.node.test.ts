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

test('0015 converts |scope=package placeholders and seals descriptions', () => {
	const result = convertCredentialStampsCodemod.transform(
		{
			'package.json': manifest(),
			'index.ts':
				"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
		},
		packageContext,
	)
	expect(result.changed).toBe(true)
	expect(result.needsManual).toEqual([])
	expect(result.files['index.ts']).toContain('{{secret:TOKEN}}')
	expect(result.files['index.ts']).not.toContain('|scope=package')
	const slots = JSON.parse(result.files['package.json']!).kody.credentials
	expect(slots.TOKEN.description).toMatch(/TOKEN/)
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
