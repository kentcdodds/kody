import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	disableEnablement,
	getEnablementOrgMigration,
	insertEnablement,
	listEnablementsForInstance,
	listEnablementsForOrg,
	markEnablementOrgNotified,
	pauseEnablement,
	resumeEnablement,
} from './repo.ts'

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

test('an enablement moves on, paused, on, off, and off is final', async () => {
	const db = setup()
	const created = await insertEnablement({
		db,
		enablement: {
			orgId: 'org-1',
			packageId: 'pkg-1',
			triggerKind: 'subscription',
			triggerName: 'email.message.received',
			instanceId: 'pkg-1',
			enablerUserId: 'user-1',
			origin: 'enabled',
		},
	})
	expect(created).toMatchObject({
		state: 'on',
		pause: null,
		origin: 'enabled',
	})

	const pause = {
		reason: 'credential_access' as const,
		permission: 'secret:use',
		resourceType: 'secret',
		resourceId: 'orgToken',
	}
	expect(
		await pauseEnablement({ db, orgId: 'org-1', id: created.id, pause }),
	).toBe(true)
	expect(
		await pauseEnablement({ db, orgId: 'org-1', id: created.id, pause }),
	).toBe(false)
	const [paused] = await listEnablementsForInstance({
		db,
		orgId: 'org-1',
		triggerKind: 'subscription',
		instanceId: 'pkg-1',
		triggerName: 'email.message.received',
	})
	expect(paused).toMatchObject({
		state: 'paused',
		pause: {
			reason: 'credential_access',
			permission: 'secret:use',
			resourceType: 'secret',
			resourceId: 'orgToken',
		},
	})
	expect(
		await listEnablementsForInstance({
			db,
			orgId: 'org-1',
			triggerKind: 'subscription',
			instanceId: 'pkg-1',
			triggerName: 'package.published',
		}),
	).toEqual([])

	expect(await resumeEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		true,
	)
	expect(await resumeEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		false,
	)
	// Another org cannot touch it.
	expect(await disableEnablement({ db, orgId: 'org-2', id: created.id })).toBe(
		false,
	)
	expect(await disableEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		true,
	)
	expect(
		await pauseEnablement({ db, orgId: 'org-1', id: created.id, pause }),
	).toBe(false)
	expect(await resumeEnablement({ db, orgId: 'org-1', id: created.id })).toBe(
		false,
	)
	expect(await listEnablementsForOrg({ db, orgId: 'org-1' })).toEqual([])
	expect(
		await listEnablementsForOrg({ db, orgId: 'org-1', includeOff: true }),
	).toMatchObject([{ id: created.id, state: 'off' }])
})

test('an org with no migration row reads as legacy and can be notified once', async () => {
	const db = setup()
	expect(await getEnablementOrgMigration({ db, orgId: 'org-1' })).toEqual({
		orgId: 'org-1',
		state: 'legacy',
		noticeSentAt: null,
		migratedAt: null,
	})
	expect(
		await markEnablementOrgNotified({ db, orgId: 'org-1', now: 'first' }),
	).toBe(true)
	expect(
		await markEnablementOrgNotified({ db, orgId: 'org-1', now: 'second' }),
	).toBe(false)
	expect(await getEnablementOrgMigration({ db, orgId: 'org-1' })).toMatchObject(
		{ state: 'notified', noticeSentAt: 'first' },
	)
})
