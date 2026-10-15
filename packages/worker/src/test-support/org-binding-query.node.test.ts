import { expect, test } from 'vitest'
import {
	isOrgBindingMembershipQuery,
	personalOrgAccessD1,
} from './org-binding-query.ts'

test('isOrgBindingMembershipQuery recognizes membership joins', () => {
	expect(
		isOrgBindingMembershipQuery(
			'select o.id as org_id from org_memberships m inner join orgs o on o.id = m.org_id',
		),
	).toBe(true)
	expect(
		isOrgBindingMembershipQuery(
			'select o.id from users u join org_memberships m on m.user_id = u.stable_user_id join orgs o on o.id = m.org_id',
		),
	).toBe(true)
	expect(isOrgBindingMembershipQuery('select 1 from users where id = ?')).toBe(
		false,
	)
})

test('personalOrgAccessD1 prefers orgId bind for org membership queries', async () => {
	const db = personalOrgAccessD1()
	const personId =
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const orgId =
		'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const row = await db
		.prepare(
			`SELECT o.id AS org_id, o.slug AS org_slug, m.role AS role
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ? AND m.org_id = ?`,
		)
		.bind(personId, orgId)
		.first<{ org_id: string; role: string }>()
	expect(row).toEqual({ org_id: orgId, org_slug: null, role: 'owner' })

	const personOnly = await db
		.prepare(
			`SELECT o.id AS org_id, o.slug AS org_slug, m.role AS role
			 FROM users u
			 JOIN org_memberships m ON m.user_id = u.stable_user_id
			 JOIN orgs o ON o.id = m.org_id
			 WHERE u.stable_user_id = ?`,
		)
		.bind(personId)
		.first<{ org_id: string; role: string }>()
	expect(personOnly).toEqual({
		org_id: personId,
		org_slug: null,
		role: 'owner',
	})
})
