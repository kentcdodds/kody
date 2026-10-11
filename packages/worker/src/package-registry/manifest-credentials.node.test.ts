import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { readRootPackage } from '#worker/package-runtime/module-graph-workspace.ts'
import { parseAuthoredPackageJson } from './manifest.ts'

function manifestWithCredentials(credentials: unknown) {
	return JSON.stringify({
		name: '@acme/demo',
		exports: { '.': './index.ts' },
		kody: { description: 'Demo package.', credentials },
	})
}

function publishError(credentials: unknown) {
	try {
		parseAuthoredPackageJson({ content: manifestWithCredentials(credentials) })
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('Expected publish to reject the manifest.')
}

test('the kody.credentials example in docs/use/packages.md publishes', () => {
	const doc = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../../../../docs/use/packages.md',
		),
		'utf8',
	)
	const section = doc.split('### Credential slots (`kody.credentials`)')[1]
	const example = section?.match(/```json\n([\s\S]*?)```/)?.[1]
	expect(example).toBeDefined()
	const manifest = parseAuthoredPackageJson({ content: example! })
	expect(manifest.kody.credentials).toEqual({
		GOOGLE: {
			kind: 'oauth',
			provider: 'google',
			multiple: true,
			description: 'Google accounts whose calendars go in the digest.',
		},
		RESEND_API_KEY: {
			kind: 'secret',
			provider: 'resend',
			description: 'Resend API key that sends the digest email.',
			placement: { header: 'Authorization', template: 'Bearer {value}' },
		},
	})
})

test('publish requires placement on secret slots and validates it', () => {
	const secret = { kind: 'secret', provider: 'acme', description: 'x' }
	expect(publishError({ KEY: secret })).toMatch(
		/kody\.credentials\.KEY\.placement: Secret slots declare placement/,
	)
	expect(
		publishError({ KEY: { ...secret, placement: { header: 'bad header' } } }),
	).toMatch(/valid HTTP header name[\s\S]*kody\.credentials\.KEY\.placement/)
	expect(
		publishError({
			KEY: { ...secret, placement: { header: 'X-Kody-Secret-Resolution' } },
		}),
	).toContain('x-kody-* headers are reserved')
	for (const template of ['Bearer', '{value} {value}', 'a\n{value}']) {
		expect(
			publishError({
				KEY: { ...secret, placement: { header: 'Authorization', template } },
			}),
		).toContain('contains {value} exactly once')
	}
	expect(
		publishError({
			LINEAR: {
				kind: 'mcp',
				provider: 'linear',
				description: 'x',
				placement: { header: 'Authorization' },
			},
		}),
	).toContain('mcp slots never send their value')

	const manifest = parseAuthoredPackageJson({
		content: manifestWithCredentials({
			KEY: { ...secret, placement: { header: 'x-api-key' } },
			GOOGLE: { kind: 'oauth', provider: 'google', description: 'x' },
		}),
	})
	expect(manifest.kody.credentials?.KEY?.placement).toEqual({
		header: 'x-api-key',
	})
	expect(manifest.kody.credentials?.GOOGLE?.placement).toBeUndefined()
})

test('publish rejects invalid kody.credentials slots and names the slot', () => {
	expect(
		publishError({
			GOOGLE: { kind: 'token', provider: 'google', description: 'x' },
		}),
	).toBe(
		'Invalid package.json:\n✖ Invalid option: expected one of "secret"|"oauth"|"mcp"\n  → at kody.credentials.GOOGLE.kind',
	)
	expect(publishError({ GOOGLE: { kind: 'oauth', description: 'x' } })).toMatch(
		/kody\.credentials\.GOOGLE\.provider/,
	)
	expect(
		publishError({ GOOGLE: { kind: 'oauth', provider: 'google' } }),
	).toMatch(/kody\.credentials\.GOOGLE\.description/)
	expect(
		publishError({
			GOOGLE: {
				kind: 'oauth',
				provider: 'google',
				description: 'x',
				mulitple: true,
			},
		}),
	).toMatch(/Unrecognized key: "mulitple"[\s\S]*kody\.credentials\.GOOGLE/)
	expect(
		publishError({
			'@me/GOOGLE': { kind: 'oauth', provider: 'g', description: 'x' },
		}),
	).toContain('Credential slot names start with a letter')
	expect(publishError(['GOOGLE'])).toMatch(/kody\.credentials/)
})

test('published snapshots load when an old kody.credentials key predates the schema', () => {
	const content = manifestWithCredentials({ GOOGLE: 'my google account' })
	expect(
		readRootPackage({ 'package.json': content })?.manifest.kody.credentials,
	).toBeUndefined()
	expect(
		parseAuthoredPackageJson({ content, mode: 'published' }).kody.credentials,
	).toBeUndefined()
	expect(() => parseAuthoredPackageJson({ content })).toThrow(
		/kody\.credentials\.GOOGLE/,
	)

	const valid = manifestWithCredentials({
		LINEAR: { kind: 'mcp', provider: 'linear', description: 'Linear MCP.' },
	})
	expect(
		parseAuthoredPackageJson({ content: valid, mode: 'published' }).kody
			.credentials,
	).toEqual({
		LINEAR: { kind: 'mcp', provider: 'linear', description: 'Linear MCP.' },
	})
})

test('published snapshots keep slots whose secret slot predates placement', () => {
	const slots = {
		KEY: { kind: 'secret', provider: 'acme', description: 'Acme API key.' },
		GOOGLE: { kind: 'oauth', provider: 'google', description: 'Google.' },
	}
	const content = manifestWithCredentials(slots)
	expect(
		parseAuthoredPackageJson({ content, mode: 'published' }).kody.credentials,
	).toEqual(slots)
	expect(
		readRootPackage({ 'package.json': content })?.manifest.kody.credentials,
	).toEqual(slots)
	expect(() => parseAuthoredPackageJson({ content })).toThrow(
		/kody\.credentials\.KEY\.placement/,
	)
})
