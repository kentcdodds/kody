import { beforeEach, expect, test, vi } from 'vitest'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'

const mocks = vi.hoisted(() => ({
	kv: new Map<string, unknown>(),
	packages: new Map<string, { userId: string; sourceId: string }>(),
	sources: new Map<
		string,
		{ id: string; user_id: string; published_commit: string | null }
	>(),
	manifests: new Map<string, unknown>(),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedCredentialNeeds: async (input: {
		sourceId: string
		publishedCommit: string
	}) => mocks.kv.get(`${input.sourceId}:${input.publishedCommit}`) ?? null,
	writePublishedCredentialNeeds: async (input: {
		sourceId: string
		publishedCommit: string
		needs: unknown
	}) => {
		mocks.kv.set(`${input.sourceId}:${input.publishedCommit}`, input.needs)
	},
}))

vi.mock(
	import('#worker/package-runtime/package-import-resolution.ts'),
	async (importOriginal) => ({
		...(await importOriginal()),
		resolveSavedPackageImport: async (input) => {
			const row = mocks.packages.get(String(input.specifier))
			return row ? ({ row } as never) : null
		},
	}),
)

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: async (_db: unknown, id: string) =>
		mocks.sources.get(id) ?? null,
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: async (input: { sourceId: string }) => ({
		manifest: mocks.manifests.get(input.sourceId),
	}),
}))

const {
	computeCredentialNeedsClosure,
	loadPublishedCredentialNeeds,
	storeCredentialNeedsClosure,
} = await import('./credential-needs-closure.ts')

const env = { APP_DB: {} } as unknown as Env

function manifest(
	name: string,
	credentials: AuthoredPackageJson['kody']['credentials'],
) {
	return {
		name,
		exports: { '.': './index.ts' },
		kody: { description: 'x', credentials },
	} as unknown as AuthoredPackageJson
}

function addPackage(input: {
	name: string
	sourceId: string
	commit: string
	credentials?: AuthoredPackageJson['kody']['credentials']
	storedNeeds?: unknown
}) {
	mocks.packages.set(input.name, { userId: 'org-1', sourceId: input.sourceId })
	mocks.sources.set(input.sourceId, {
		id: input.sourceId,
		user_id: 'org-1',
		published_commit: input.commit,
	})
	mocks.manifests.set(input.sourceId, manifest(input.name, input.credentials))
	if (input.storedNeeds !== undefined) {
		mocks.kv.set(`${input.sourceId}:${input.commit}`, input.storedNeeds)
	}
}

beforeEach(() => {
	mocks.kv.clear()
	mocks.packages.clear()
	mocks.sources.clear()
	mocks.manifests.clear()
})

test('publish stores own needs plus each imported package closure, and reads it back', async () => {
	addPackage({
		name: '@acme/triage',
		sourceId: 'src-triage',
		commit: 'c1',
		storedNeeds: [
			{
				key: 'linear',
				kind: 'mcp',
				provider: 'linear',
				description: 'Linear.',
				multiple: false,
				from: '@acme/linear-tools',
			},
		],
	})
	addPackage({
		name: '@acme/notify',
		sourceId: 'src-notify',
		commit: 'c2',
		// Published before closures were stored: its own needs stand in.
		credentials: { resend: { kind: 'secret', description: 'Email.' } },
	})
	const files = {
		'index.ts': [
			"import triage from 'kody:@acme/triage'",
			"import notify from 'kody:@acme/notify/send'",
			"import self from 'kody:@acme/app/other'",
			"import missing from 'kody:@acme/missing'",
			'export default () => [triage, notify, self, missing]',
		].join('\n'),
	}
	const app = manifest('@acme/app', {
		github: { kind: 'oauth', description: 'Repos.' },
	})
	await storeCredentialNeedsClosure({
		env,
		userId: 'org-1',
		sourceId: 'src-app',
		publishedCommit: 'c3',
		manifest: app,
		files,
	})
	const expected = [
		{
			key: 'github',
			kind: 'oauth',
			provider: 'github',
			description: 'Repos.',
			multiple: false,
		},
		{
			key: 'linear',
			kind: 'mcp',
			provider: 'linear',
			description: 'Linear.',
			multiple: false,
			from: '@acme/linear-tools',
		},
		{
			key: 'resend',
			kind: 'secret',
			provider: 'resend',
			description: 'Email.',
			multiple: false,
			from: '@acme/notify',
		},
	]
	expect(mocks.kv.get('src-app:c3')).toEqual(expected)
	mocks.sources.set('src-app', {
		id: 'src-app',
		user_id: 'org-1',
		published_commit: 'c3',
	})
	expect(
		await loadPublishedCredentialNeeds({
			env,
			userId: 'org-1',
			sourceId: 'src-app',
		}),
	).toEqual(expected)
	expect(
		await loadPublishedCredentialNeeds({
			env,
			userId: 'org-2',
			sourceId: 'src-app',
		}),
	).toEqual([])
})

test('a dependency that declares the same key with another kind is a conflict', async () => {
	addPackage({
		name: '@acme/gh-pat',
		sourceId: 'src-pat',
		commit: 'c1',
		credentials: { github: { kind: 'secret', description: 'PAT.' } },
	})
	const { conflicts } = await computeCredentialNeedsClosure({
		env,
		userId: 'org-1',
		manifest: manifest('@acme/app', {
			github: { kind: 'oauth', description: 'Repos.' },
		}),
		files: { 'index.ts': "import pat from 'kody:@acme/gh-pat'" },
	})
	expect(conflicts).toEqual([
		'kody.credentials.github: oauth from provider "github" (declared by this package) conflicts with secret from provider "github" (declared by @acme/gh-pat). Give one of them a different key.',
	])
})
