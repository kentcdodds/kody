import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { explicitWebhookUrlSecretVerificationCodemod as codemod } from './0012-explicit-webhook-url-secret-verification.ts'

const githubVerification = {
	type: 'hmac-sha256',
	header: 'x-hub-signature-256',
	encoding: 'hex',
	prefix: 'sha256=',
}

function manifest(kodyExtra: Record<string, unknown> = {}, indent = '\t') {
	return `${JSON.stringify(
		{
			name: '@user/demo',
			exports: {
				'./telegram': './src/telegram.ts',
				'./github': './src/github.ts',
			},
			kody: {
				id: 'demo',
				description: 'Demo package for webhook verification codemod tests.',
				...kodyExtra,
			},
		},
		null,
		indent,
	)}\n`
}

test('0012 declares url-secret on webhooks without verification, leaves declared ones alone, and is idempotent', () => {
	const files = {
		'package.json': manifest(
			{
				webhooks: [
					{ name: 'telegram', export: './telegram', responseMode: 'sync' },
					{
						name: 'github',
						export: './github',
						verification: githubVerification,
					},
				],
			},
			'  ',
		),
		'src/telegram.ts': 'export default () => ({ ok: true })\n',
	}
	expect(codemod.detect(files)).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('without verification'),
		},
	])

	const result = codemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['package.json'])
	expect(result.needsManual).toEqual([])
	expect(result.files['src/telegram.ts']).toBe(files['src/telegram.ts'])
	const next = result.files['package.json']!
	expect(next).toContain('\n  "name"')
	expect(JSON.parse(next).kody.webhooks).toEqual([
		{
			name: 'telegram',
			export: './telegram',
			responseMode: 'sync',
			verification: { type: 'url-secret' },
		},
		{ name: 'github', export: './github', verification: githubVerification },
	])
	expect(
		parseAuthoredPackageJson({ content: next }).kody.webhooks?.map(
			(webhook) => webhook.verification?.type,
		),
	).toEqual(['url-secret', 'hmac-sha256'])

	const secondPass = codemod.transform(result.files)
	expect(secondPass.changed).toBe(false)
	expect(secondPass.files['package.json']).toBe(next)
	expect(codemod.detect(result.files)).toEqual([])
})

test('0012 leaves packages without webhooks or with every webhook declared untouched', () => {
	for (const files of [
		{ 'package.json': manifest() },
		{ 'package.json': manifest({ webhooks: [] }) },
		{
			'package.json': manifest({
				webhooks: [
					{
						name: 'telegram',
						export: './telegram',
						verification: { type: 'url-secret' },
					},
				],
			}),
		},
		{ 'package.json': '{ "name": "@user/demo" }\n' },
	]) {
		expect(codemod.detect(files)).toEqual([])
		const result = codemod.transform(files)
		expect(result).toEqual({
			files,
			changed: false,
			changedPaths: [],
			needsManual: [],
		})
	}
})

test('0012 flags unreadable manifests and malformed webhooks for manual review without echoing their contents', () => {
	for (const source of [
		undefined,
		'{ not json',
		manifest({ webhooks: { telegram: './telegram' } }),
		manifest({ webhooks: ['telegram'] }),
		manifest({
			webhooks: [
				{ name: 'telegram', export: './telegram' },
				{ name: 'github', export: './github', verification: 'hmac' },
			],
		}),
	]) {
		const files: Record<string, string> =
			source === undefined ? {} : { 'package.json': source }
		const findings = codemod.detect(files)
		expect(findings).toHaveLength(1)
		expect(findings[0]?.message).toMatch(/manual/)
		expect(findings[0]?.message).not.toContain('telegram')
		const result = codemod.transform(files)
		expect(result.changed).toBe(false)
		expect(result.files).toEqual(files)
		expect(result.needsManual).toEqual(findings)
	}
})
