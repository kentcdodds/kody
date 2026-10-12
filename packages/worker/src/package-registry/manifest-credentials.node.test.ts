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
		},
	})
})

test('publish rejects a retired placement, and published snapshots drop it', () => {
	const secret = { kind: 'secret', provider: 'acme', description: 'x' }
	expect(
		parseAuthoredPackageJson({
			content: manifestWithCredentials({ KEY: secret }),
		}).kody.credentials,
	).toEqual({ KEY: secret })
	const placed = {
		KEY: {
			...secret,
			placement: { header: 'Authorization', template: 'Bearer {value}' },
		},
	}
	expect(publishError(placed)).toContain(
		'kody.credentials slots take no placement: the fetch gateway fills a credential anywhere in a request',
	)
	expect(publishError(placed)).toMatch(/kody\.credentials\.KEY\.placement/)
	const content = manifestWithCredentials(placed)
	for (const { kody } of [
		parseAuthoredPackageJson({ content, mode: 'published' }),
		readRootPackage({ 'package.json': content })!.manifest,
	]) {
		expect(kody.credentials).toEqual({ KEY: secret })
		expect(kody.invalidCredentialSlots).toBeUndefined()
	}
})

test('publish rejects invalid kody.credentials slots and names the slot', () => {
	expect(
		publishError({
			GOOGLE: { kind: 'token', provider: 'google', description: 'x' },
		}),
	).toBe(
		'Invalid package.json:\n✖ Invalid option: expected one of "secret"|"oauth"|"mcp"|"url"|"login"|"signing"\n  → at kody.credentials.GOOGLE.kind',
	)
	expect(
		publishError({ GOOGLE: { kind: 'oauth', provider: '', description: 'x' } }),
	).toMatch(/kody\.credentials\.GOOGLE\.provider/)
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

test('needs may omit provider and use the opt-in kinds', () => {
	const credentials = {
		github: { kind: 'oauth', description: 'Repos to triage.' },
		telegram: { kind: 'url', description: 'Bot URL.' },
		portal: { kind: 'login', provider: 'acme-portal', description: 'Portal.' },
		webhook: { kind: 'signing', description: 'Signs requests.' },
	}
	expect(
		parseAuthoredPackageJson({ content: manifestWithCredentials(credentials) })
			.kody.credentials,
	).toEqual(credentials)
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

	for (const garbage of ['x', ['GOOGLE'], { GOOGLE: 'x', LINEAR: 1 }]) {
		expect(
			parseAuthoredPackageJson({
				content: manifestWithCredentials(garbage),
				mode: 'published',
			}).kody,
		).not.toHaveProperty('credentials')
	}
	const empty = manifestWithCredentials({})
	for (const mode of ['published', 'authoring'] as const) {
		expect(
			parseAuthoredPackageJson({ content: empty, mode }).kody.credentials,
		).toEqual({})
	}

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

test('published snapshots keep valid slots when one slot fails the slot schema, and name the bad slot', () => {
	const google = { kind: 'oauth', provider: 'google', description: 'Google.' }
	const linear = { kind: 'mcp', provider: 'linear', description: 'Linear.' }
	const content = manifestWithCredentials({
		GOOGLE: google,
		KEY: {
			kind: 'secret',
			provider: 'acme',
			description: 'Acme API key.',
			placement: { header: 'X-Kody-Key' },
		},
		LINEAR: { ...linear, futureRule: true },
		'bad name': google,
		toString: google,
	})
	for (const { kody } of [
		parseAuthoredPackageJson({ content, mode: 'published' }),
		readRootPackage({ 'package.json': content })!.manifest,
	]) {
		expect(kody.credentials).toEqual({
			GOOGLE: google,
			KEY: { kind: 'secret', provider: 'acme', description: 'Acme API key.' },
			toString: google,
		})
		expect(kody.invalidCredentialSlots).toEqual({
			LINEAR: 'kody.credentials.LINEAR: Unrecognized key: "futureRule"',
			'bad name':
				'kody.credentials.bad name: Credential slot names start with a letter and use letters, numbers, dots, underscores, or hyphens (max 64).',
		})
	}
	expect(() => parseAuthoredPackageJson({ content })).toThrow(
		/kody\.credentials\.KEY\.placement/,
	)

	const allInvalid = parseAuthoredPackageJson({
		content: manifestWithCredentials({ LINEAR: { ...linear, futureRule: 1 } }),
		mode: 'published',
	})
	expect(allInvalid.kody.credentials).toEqual({})
	expect(Object.keys(allInvalid.kody.invalidCredentialSlots ?? {})).toEqual([
		'LINEAR',
	])
})

test('package.json cannot set invalidCredentialSlots', () => {
	const content = JSON.stringify({
		name: '@acme/demo',
		exports: { '.': './index.ts' },
		kody: {
			description: 'Demo package.',
			invalidCredentialSlots: { GOOGLE: 'forged' },
		},
	})
	expect(
		parseAuthoredPackageJson({ content }).kody.invalidCredentialSlots,
	).toBeUndefined()
	expect(
		parseAuthoredPackageJson({ content, mode: 'published' }).kody
			.invalidCredentialSlots,
	).toBeUndefined()
})
