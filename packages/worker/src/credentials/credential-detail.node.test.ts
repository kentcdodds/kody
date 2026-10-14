import { DatabaseSync } from 'node:sqlite'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type CredentialListItem } from '#universal/credential-contracts.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import type * as CredentialCandidates from './credential-candidates.ts'
import { type CredentialNeed } from './credential-needs.ts'

const mocks = vi.hoisted(() => ({
	needs: new Map<string, Array<CredentialNeed>>(),
	usable: [] as Array<{
		id: string
		name: string
		kind: CredentialNeed['kind']
		provider: string | null
		hosts: Array<string>
		scope: 'org' | 'personal'
	}>,
}))

vi.mock('./credential-needs-closure.ts', () => ({
	loadPublishedCredentialNeeds: async (input: { sourceId: string }) => {
		if (input.sourceId === 'broken') throw new Error('closure unreadable')
		return mocks.needs.get(input.sourceId) ?? []
	},
}))

vi.mock('./credential-candidates.ts', async (importOriginal) => ({
	...(await importOriginal<typeof CredentialCandidates>()),
	listUsableCredentials: async () => mocks.usable,
}))

const { credentialPlaceholder, loadCredentialDetail, maxUsagePackages } =
	await import('./credential-detail.ts')

function item(
	overrides: Partial<CredentialListItem> & { id: string; name: string },
): CredentialListItem {
	return {
		kind: 'secret',
		scope: 'org',
		provider: null,
		description: '',
		hosts: [],
		inject: null,
		packageId: null,
		lockedToPackageIds: [],
		expiresAt: null,
		createdAt: '2026-10-11T00:00:00.000Z',
		updatedAt: '2026-10-11T00:00:00.000Z',
		status: 'ok',
		statusMessage: null,
		mcp: null,
		...overrides,
	}
}

function pkg(id: string, sourceId = `src-${id}`) {
	return { id, kodyId: id, sourceId } as SavedPackageRecord
}

function need(key: string, kind: CredentialNeed['kind'], provider: string) {
	return { key, kind, provider, description: '', multiple: false }
}

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const env = { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
	return { sqlite, env }
}

beforeEach(() => {
	mocks.needs.clear()
	mocks.usable = []
})

test('placeholders cover Keys and OAuth only, with the package scope when it has one', () => {
	expect(credentialPlaceholder(item({ id: 'a', name: 'OPENAI_KEY' }))).toBe(
		'{{secret:OPENAI_KEY}}',
	)
	expect(
		credentialPlaceholder(item({ id: 'b', name: 'SLACK', packageId: 'pkg-1' })),
	).toBe('{{secret:SLACK|scope=package}}')
	expect(
		credentialPlaceholder(item({ id: 'c', name: 'github', kind: 'oauth' })),
	).toBe('{{integration-token:github}}')
	for (const kind of ['url', 'login', 'signing', 'mcp'] as const) {
		expect(credentialPlaceholder(item({ id: kind, name: 'x', kind }))).toBe(
			null,
		)
	}
	// Placeholders and credential() share one rule, so a granted personal
	// secret still shows the same placeholder (owner's runs only).
	expect(
		credentialPlaceholder(item({ id: 'e', name: 'MINE', scope: 'personal' })),
	).toBe('{{secret:MINE}}')
	// A name the placeholder grammar cannot spell has no placeholder.
	expect(credentialPlaceholder(item({ id: 'd', name: 'work github' }))).toBe(
		null,
	)
})

test('usage reports how each package need relates to the credential', async () => {
	const { env } = setup()
	mocks.usable = [
		{
			id: 'openai-1',
			name: 'OPENAI',
			kind: 'secret',
			provider: 'openai',
			hosts: [],
			scope: 'org',
		},
		{
			id: 'gh-1',
			name: 'gh-work',
			kind: 'oauth',
			provider: 'github',
			hosts: [],
			scope: 'org',
		},
		{
			id: 'gh-2',
			name: 'gh-home',
			kind: 'oauth',
			provider: 'github',
			hosts: [],
			scope: 'org',
		},
		{
			id: 'loose',
			name: 'TOKEN',
			kind: 'secret',
			provider: null,
			hosts: [],
			scope: 'org',
		},
	]
	mocks.needs.set('src-triage', [
		need('openai', 'secret', 'openai'),
		need('github', 'oauth', 'github'),
	])
	mocks.needs.set('src-digest', [need('llm', 'secret', 'openai')])
	const detail = (credential: CredentialListItem) =>
		loadCredentialDetail({
			env,
			request: {} as RequestContext,
			orgId: 'org-1',
			ownedByViewer: false,
			credential,
			packages: [pkg('triage'), pkg('digest'), pkg('broken', 'broken')],
		})

	expect(
		(await detail(item({ id: 'openai-1', name: 'OPENAI', provider: 'openai' })))
			.usage,
	).toEqual([
		{ packageId: 'digest', kodyId: 'digest', needKey: 'llm', fit: 'auto' },
		{ packageId: 'triage', kodyId: 'triage', needKey: 'openai', fit: 'auto' },
	])
	expect(
		(await detail(item({ id: 'gh-1', name: 'gh-work', kind: 'oauth' }))).usage,
	).toEqual([
		{
			packageId: 'triage',
			kodyId: 'triage',
			needKey: 'github',
			fit: 'candidate',
		},
	])
	// A Key with no provider is a possible match for every Key need.
	expect(
		(await detail(item({ id: 'loose', name: 'TOKEN' }))).usage.map(
			(use) => `${use.kodyId}:${use.needKey}:${use.fit}`,
		),
	).toEqual(['digest:llm:possible', 'triage:openai:possible'])
	expect(
		(await detail(item({ id: 'openai-1', name: 'OPENAI' }))).usageUnreadable,
	).toBe(1)
	// A locked credential only shows packages its locks allow.
	expect(
		(
			await detail(
				item({
					id: 'openai-1',
					name: 'OPENAI',
					provider: 'openai',
					lockedToPackageIds: ['digest'],
				}),
			)
		).usage.map((use) => use.kodyId),
	).toEqual(['digest'])
	// A package key belongs to its package; it fills no declared need.
	expect(
		await detail(item({ id: 'openai-1', name: 'OPENAI', packageId: 'triage' })),
	).toMatchObject({ usage: [], usageTruncated: false, usageUnreadable: 0 })
})

test('usage checks a bounded number of packages and says so', async () => {
	const { env } = setup()
	const packages = Array.from({ length: maxUsagePackages + 2 }, (_, i) =>
		pkg(`p${i}`),
	)
	const detail = await loadCredentialDetail({
		env,
		request: {} as RequestContext,
		orgId: 'org-1',
		ownedByViewer: false,
		credential: item({ id: 'a', name: 'A' }),
		packages,
	})
	expect(detail.usageTruncated).toBe(true)
})

test("the viewer's own credential lists the team orgs it is granted to", async () => {
	const { sqlite, env } = setup()
	sqlite.exec(`
		INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
		VALUES ('org-acme', 'acme', 'Acme', '2026-10-01', '2026-10-01'),
			('org-gone', 'gone', 'Gone', '2026-10-01', '2026-10-01');
		UPDATE orgs SET deleted_at = '2026-10-02' WHERE id = 'org-gone';
		INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at)
		VALUES ('mine', 'ann', 'org-acme', '2026-10-05T00:00:00.000Z'),
			('mine', 'ann', 'org-gone', '2026-10-05T00:00:00.000Z');
	`)
	const load = (ownedByViewer: boolean) =>
		loadCredentialDetail({
			env,
			request: {} as RequestContext,
			orgId: 'ann-org',
			ownedByViewer,
			credential: item({ id: 'mine', name: 'mine' }),
			packages: [],
		})
	expect((await load(true)).grants).toEqual([
		{ orgSlug: 'acme', orgName: 'Acme', grantedAt: '2026-10-05T00:00:00.000Z' },
	])
	expect((await load(false)).grants).toEqual([])
})
