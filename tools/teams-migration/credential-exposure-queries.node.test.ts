import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { assertReadOnlySql } from './production-queries.ts'
import {
	credentialAuditCandidateSql,
	liveOwnerMembershipsSql,
	multiMemberOrgsSql,
	orgsWithOutsideGrantsSql,
	outsideGrantsSql,
} from './credential-exposure-queries.ts'

test('credential exposure SQL is read-only and matches multi-member / outside-grant shapes', () => {
	for (const sql of [
		multiMemberOrgsSql,
		outsideGrantsSql,
		orgsWithOutsideGrantsSql,
		credentialAuditCandidateSql,
		liveOwnerMembershipsSql,
	]) {
		expect(() => assertReadOnlySql(sql)).not.toThrow()
	}
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../packages/worker/migrations/', import.meta.url),
	)
	const now = '2026-10-10T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO users (id, username, email, password_hash, created_at, updated_at, stable_user_id)
			 VALUES (1, 'owner', 'o@example.com', 'h', ?, ?, 'owner-id'),
			        (2, 'member', 'm@example.com', 'h', ?, ?, 'member-id'),
			        (3, 'collab', 'c@example.com', 'h', ?, ?, 'collab-id')`,
		)
		.run(now, now, now, now, now, now)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at, access_epoch)
			 VALUES ('owner-id', 'owner', 'Owner', ?, ?, 0)`,
		)
		.run(now, now)
	sqlite
		.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES ('owner-id', 'owner-id', 'owner', ?),
			        ('owner-id', 'member-id', 'member', ?)`,
		)
		.run(now, now)
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at
			) VALUES (
				'g1', 'owner-id', 'package', 'pkg-1', 'user', 'collab-id',
				'use', 'owner-id', ?, ?
			)`,
		)
		.run(now, now)

	const multi = sqlite.prepare(multiMemberOrgsSql).all() as Array<{
		org_id: string
		member_count: number
	}>
	expect(multi).toEqual([
		expect.objectContaining({ org_id: 'owner-id', member_count: 2 }),
	])
	const outside = sqlite.prepare(outsideGrantsSql).all() as Array<{
		subject_id: string
	}>
	expect(outside).toEqual([
		expect.objectContaining({ subject_id: 'collab-id' }),
	])
	const orgs = sqlite.prepare(orgsWithOutsideGrantsSql).all()
	expect(orgs).toHaveLength(1)
})
