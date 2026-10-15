import { expect, test } from 'vitest'
import {
	buildCredentialStamp,
	collectServerRuntimeModulePaths,
	mergeCredentialStampIntoManifestFiles,
	scanCredentialStamp,
} from './credential-stamp.ts'

function manifest(kody: Record<string, unknown> = {}) {
	return JSON.stringify({
		name: '@kody/stamp',
		exports: { '.': './src/index.ts' },
		kody: { id: 'stamp', description: 'Stamp test.', ...kody },
	})
}

test('scanCredentialStamp collects sorted literal keys from credential() and placeholders', () => {
	const result = scanCredentialStamp({
		'package.json': manifest({
			credentials: {
				GITHUB: { kind: 'oauth', description: 'GitHub OAuth.' },
				API_KEY: { kind: 'secret', description: 'API key.' },
			},
		}),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'  const gh = await credential("GITHUB")',
			"  return fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:API_KEY}}' } })",
			'}',
		].join('\n'),
	})
	expect(result.failures).toEqual([])
	expect(result.keys).toEqual(['API_KEY', 'GITHUB'])
})

test('scanCredentialStamp fails non-literal credential(), createAuthenticatedFetch, and secretJwtSign names', () => {
	const credentialVar = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run(key: string) {',
			'  return credential(key)',
			'}',
		].join('\n'),
	})
	expect(credentialVar.failures.some((f) => f.code === 'non_literal')).toBe(
		true,
	)
	expect(credentialVar.failures[0]?.message).toMatch(
		/literal credential\("KEY"\)/,
	)

	const fetchVar = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { createAuthenticatedFetch } from 'kody:runtime'",
			'export default async function run(account: string) {',
			'  return createAuthenticatedFetch(account)',
			'}',
		].join('\n'),
	})
	expect(fetchVar.failures.some((f) => f.code === 'unstampable_pattern')).toBe(
		true,
	)

	const jwtVar = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { kody } from 'kody:runtime'",
			"const keyName = 'APNS_KEY'",
			'export const sign = () => kody.secretJwtSign({ private_key_secret_name: keyName, claims: {} })',
		].join('\n'),
	})
	expect(jwtVar.failures.some((f) => f.code === 'non_literal')).toBe(true)
})

test('scanCredentialStamp fails credential.named() in stamped packages', () => {
	const result = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() {',
			'  return credential.named("API_KEY")',
			'}',
		].join('\n'),
	})
	expect(result.failures.some((f) => f.code === 'credential_named')).toBe(true)
	expect(result.failures[0]?.message).toMatch(/ad hoc execute/)
})

test('scanCredentialStamp fails missing descriptions without inventing placeholders', () => {
	const result = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts': [
			"import { credential } from 'kody:runtime'",
			'export default async function run() { return credential("API_KEY") }',
		].join('\n'),
	})
	expect(result.keys).toEqual(['API_KEY'])
	expect(result.failures.some((f) => f.code === 'missing_description')).toBe(
		true,
	)
	expect(result.failures[0]?.message).toMatch(/Describe what API_KEY is for/)
	expect(result.failures[0]?.message).not.toMatch(/Auto-detected from stamp/)
})

test('mergeCredentialStampIntoManifestFiles adds missing keys and never overwrites descriptions', () => {
	const before = {
		'package.json': manifest({
			credentials: {
				EXISTING: { description: 'Keep me.' },
			},
		}),
		'src/index.ts': 'export default async function run() { return 1 }',
	}
	const { files, addedKeys } = mergeCredentialStampIntoManifestFiles(before, [
		'EXISTING',
		'NEW_KEY',
	])
	expect(addedKeys).toEqual(['NEW_KEY'])
	const parsed = JSON.parse(files['package.json']!) as {
		kody: { credentials: Record<string, { description?: string }> }
	}
	expect(parsed.kody.credentials.EXISTING).toEqual({ description: 'Keep me.' })
	expect(parsed.kody.credentials.NEW_KEY).toEqual({})
})

test('buildCredentialStamp sorts keys and hashes dep stamp pins', async () => {
	const stamp = await buildCredentialStamp({
		keys: ['B', 'A'],
		depStamps: [
			{
				packageId: 'pkg-2',
				publishedCommit: 'bbb',
				stampHash: 'hash-b',
			},
			{
				packageId: 'pkg-1',
				publishedCommit: 'aaa',
				stampHash: 'hash-a',
			},
		],
	})
	expect(stamp.keys).toEqual(['A', 'B'])
	expect(stamp.depStamps.map((d) => d.packageId)).toEqual(['pkg-1', 'pkg-2'])
	expect(stamp.stampHash).toMatch(/^[0-9a-f]{64}$/)
	const again = await buildCredentialStamp({
		keys: ['A', 'B'],
		depStamps: stamp.depStamps,
	})
	expect(again.stampHash).toBe(stamp.stampHash)
})

test('server eval / new Function / non-literal import fail; UI client entry is exempt', () => {
	const serverEval = scanCredentialStamp({
		'package.json': JSON.stringify({
			name: '@kody/app',
			exports: { '.': './src/server.ts' },
			kody: {
				id: 'app',
				description: 'App.',
				app: { entry: './src/server.ts', client: './src/client.ts' },
			},
		}),
		'src/server.ts': 'export default { fetch() { return eval("1") } }',
		'src/client.ts': 'eval("ok"); export {}',
	})
	expect(serverEval.failures.some((f) => f.code === 'server_eval')).toBe(true)
	expect(serverEval.failures.some((f) => f.path === 'src/server.ts')).toBe(true)
	expect(serverEval.failures.some((f) => f.path === 'src/client.ts')).toBe(
		false,
	)

	const uiOnly = scanCredentialStamp({
		'package.json': JSON.stringify({
			name: '@kody/app',
			exports: { '.': './src/server.ts' },
			kody: {
				id: 'app',
				description: 'App.',
				app: { entry: './src/server.ts', client: './src/client.ts' },
			},
		}),
		'src/server.ts': 'export default { fetch() { return new Response("ok") } }',
		'src/client.ts':
			'const run = new Function("return 1"); import(name); export {}',
	})
	expect(uiOnly.failures.filter((f) => f.code === 'server_eval')).toEqual([])

	const shared = scanCredentialStamp({
		'package.json': JSON.stringify({
			name: '@kody/app',
			exports: { '.': './src/server.ts' },
			kody: {
				id: 'app',
				description: 'App.',
				app: { entry: './src/server.ts', client: './src/client.ts' },
			},
		}),
		'src/server.ts':
			'import { boom } from "./shared.ts"; export default { fetch: boom }',
		'src/client.ts': 'import { boom } from "./shared.ts"; boom()',
		'src/shared.ts': 'export const boom = () => eval("1")',
	})
	expect(shared.failures.some((f) => f.path === 'src/shared.ts')).toBe(true)

	const serverPaths = collectServerRuntimeModulePaths({
		'package.json': JSON.stringify({
			name: '@kody/app',
			exports: { '.': './src/server.ts' },
			kody: {
				id: 'app',
				description: 'App.',
				app: { entry: './src/server.ts', client: './src/client.ts' },
			},
		}),
		'src/server.ts': 'export default { fetch() { return new Response("ok") } }',
		'src/client.ts': 'export {}',
	})
	expect(serverPaths.has('src/server.ts')).toBe(true)
	expect(serverPaths.has('src/client.ts')).toBe(false)
})

test('computed |scope= and secretMounts fail the stamp gate', () => {
	const scoped = scanCredentialStamp({
		'package.json': manifest(),
		'src/index.ts':
			"export const h = { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' }",
	})
	expect(scoped.failures.some((f) => f.code === 'unstampable_pattern')).toBe(
		true,
	)

	const mounts = scanCredentialStamp({
		'package.json': manifest({
			secretMounts: { token: { name: 'TOKEN' } },
		}),
		'src/index.ts': 'export const ready = true',
	})
	expect(mounts.failures.some((f) => f.message.includes('secretMounts'))).toBe(
		true,
	)
})
