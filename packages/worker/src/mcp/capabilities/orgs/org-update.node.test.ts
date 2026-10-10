import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { orgCreateCapability } from '#mcp/capabilities/access/org-members.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { orgUpdateCapability } from './org-update.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'

async function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	const db = createD1FromSqlite(sqlite)
	await ensureOrgsTestSchema(db)
	return db
}

function context(input: {
	db: D1Database
	userId: string
	org: { id: string; slug: string; role: 'owner' | 'member' | 'billing' }
}) {
	return {
		env: { APP_DB: input.db, AUDIT_DB: createAuditTestDb() } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(input.userId),
				email: 'ada@example.com',
				displayName: 'Ada',
				username: 'ada',
			},
			orgBinding: {
				org: {
					id: ownerIdFromStored(input.org.id),
					slug: input.org.slug,
				},
				role: input.org.role,
			},
		}),
	}
}

test('orgUpdate changes a team org display name, keeps the handle permanent, and refuses a personal org', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada@example.com')
	await provisionPersonalOrg(db, {
		stableUserId: ada,
		username: 'ada',
	})
	const created = await orgCreateCapability.handler(
		{ slug: 'zeta-co', display_name: 'Zeta Co' },
		{
			env: { APP_DB: db, AUDIT_DB: createAuditTestDb() } as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored(ada),
					email: 'ada@example.com',
					displayName: 'Ada',
					username: 'ada',
				},
			}),
		},
	)
	const updated = await orgUpdateCapability.handler(
		{ display_name: 'Zeta Company' },
		context({
			db,
			userId: ada,
			org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
		}),
	)
	expect(updated.org).toEqual({
		id: created.org.id,
		slug: 'zeta-co',
		display_name: 'Zeta Company',
	})

	await expect(
		orgUpdateCapability.handler(
			{ slug: 'zeta-company' },
			context({
				db,
				userId: ada,
				org: { id: created.org.id, slug: created.org.slug, role: 'owner' },
			}),
		),
	).rejects.toThrow(/permanent/)
	expect(
		await db
			.prepare(`SELECT slug FROM orgs WHERE id = ?`)
			.bind(created.org.id)
			.first(),
	).toEqual({ slug: 'zeta-co' })

	await expect(
		orgUpdateCapability.handler(
			{ display_name: 'Ada Org' },
			context({
				db,
				userId: ada,
				org: { id: ada, slug: 'ada', role: 'owner' },
			}),
		),
	).rejects.toBeInstanceOf(McpCallerError)
})

test('orgUpdate requires an input field', async () => {
	const db = await createDb()
	const ada = testStableUserIdFromEmail('ada2@example.com')
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: ada,
			slug: 'zeta',
			displayName: 'Zeta',
			audit: createTestOrgAuditWriter(),
		},
	)
	if (!created.ok) throw new Error(created.error)
	const org = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'zeta'`)
		.first<{ id: string }>()
	await expect(
		orgUpdateCapability.handler(
			{},
			context({
				db,
				userId: ada,
				org: { id: org!.id, slug: 'zeta', role: 'owner' },
			}),
		),
	).rejects.toBeInstanceOf(McpCallerError)
})
