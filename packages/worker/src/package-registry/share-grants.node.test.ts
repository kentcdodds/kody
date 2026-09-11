import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	acceptPackageShare,
	acknowledgePackageShareUpdate,
	assertPackageShareUseAllowed,
	attachPendingPackageShareInvitesForEmail,
	authorizeSharedPackagePermission,
	grantIsAddressedToGuest,
	hydratePackageShareGrantViews,
	invitePackageShare,
	isShareGrantedForeignPackage,
	listAcceptedInboundSharedPackages,
	leavePackageShare,
	listInboundPackageShareGrants,
	listOutboundPackageShareGrants,
	PackageSharePaidRequiredError,
	PackageSharePinAheadError,
	resolvePackageStorageOwnerUserId,
	resolveShareGrantedPackageImport,
	revokePackageShare,
} from './share-grants.ts'
import { packageShareRoleAllows } from './share-rbac.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

const ownerUserId = 'aa'.repeat(32)
const guestUserId = 'bb'.repeat(32)
const freeUserId = 'cc'.repeat(32)

async function insertUser(
	db: D1Database,
	input: {
		username: string
		email: string
		userId: string
		plan: 'free' | 'standard' | 'pro'
		emailVerified?: boolean
	},
) {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', ?, ?, ?)`,
		)
		.bind(
			input.username,
			input.email,
			input.emailVerified === false ? null : new Date().toISOString(),
			input.userId,
			input.plan,
		)
		.run()
}

async function seedPublishedPackage(
	db: D1Database,
	input: {
		userId: string
		name: string
		kodyId: string
		publishedCommit?: string
	},
) {
	const id = crypto.randomUUID()
	const sourceId = `source-${id}`
	const now = new Date().toISOString()
	await insertSavedPackage(db, {
		id,
		user_id: input.userId,
		name: input.name,
		kody_id: input.kodyId,
		description: `${input.name} test package`,
		tags_json: '[]',
		search_text: null,
		source_id: sourceId,
		has_app: 0,
		hidden: 0,
		is_private: 1,
	})
	await insertEntitySource(db, {
		id: sourceId,
		user_id: input.userId,
		entity_kind: 'package',
		entity_id: id,
		repo_id: `repo-${sourceId}`,
		published_commit: input.publishedCommit ?? 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	})
	return { packageId: id, sourceId }
}

async function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await insertUser(db, {
		username: 'alice',
		email: 'alice@example.com',
		userId: ownerUserId,
		plan: 'standard',
	})
	await insertUser(db, {
		username: 'jesse',
		email: 'jesse@example.com',
		userId: guestUserId,
		plan: 'standard',
	})
	await insertUser(db, {
		username: 'freeuser',
		email: 'free@example.com',
		userId: freeUserId,
		plan: 'free',
	})
	const seeded = await seedPublishedPackage(db, {
		userId: ownerUserId,
		name: '@alice/shared-notes',
		kodyId: 'shared-notes',
	})
	return { db, ...seeded }
}

test('use role allows read_source and invoke only', () => {
	expect(packageShareRoleAllows('use', 'read_source')).toBe(true)
	expect(packageShareRoleAllows('use', 'invoke')).toBe(true)
	expect(packageShareRoleAllows('use', 'publish')).toBe(false)
	expect(packageShareRoleAllows('use', 'write_source')).toBe(false)
	expect(packageShareRoleAllows('use', 'create_jobs')).toBe(false)
})

test('invite, accept, revoke, and leave follow paid and accept-required rules', async () => {
	const { db, packageId } = await createHarness()
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const guest = {
		userId: guestUserId,
		email: 'jesse@example.com',
		displayName: 'Jesse',
		username: 'jesse',
	}

	await expect(
		invitePackageShare({
			db,
			owner: { ...owner, userId: freeUserId, email: 'free@example.com' },
			packageId,
			invitee: { username: 'jesse' },
		}),
	).rejects.toBeInstanceOf(PackageSharePaidRequiredError)

	const invited = await invitePackageShare({
		db,
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	expect(invited.status).toBe('pending')
	expect(invited.granteeUserId).toBe(guestUserId)
	expect(invited.inviteeEmail).toBeNull()
	expect(invited.inviteeUsername).toBe('jesse')

	await expect(
		invitePackageShare({
			db,
			owner,
			packageId,
			invitee: { email: 'jesse@example.com' },
		}),
	).rejects.toThrow('already pending')

	await expect(
		resolveShareGrantedPackageImport({
			db,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toBeNull()

	const accepted = await acceptPackageShare({
		db,
		guest,
		grantId: invited.id,
	})
	expect(accepted.status).toBe('accepted')
	expect(accepted.trustLevel).toBe('pin')
	expect(accepted.acceptedPublishedCommit).toBe('commit-1')

	const resolved = await resolveShareGrantedPackageImport({
		db,
		granteeUserId: guestUserId,
		granteeEmail: guest.email,
		packageName: '@alice/shared-notes',
	})
	expect(resolved?.row.id).toBe(packageId)
	expect(resolved?.sourceOwnerUserId).toBe(ownerUserId)

	expect(
		await isShareGrantedForeignPackage({
			db,
			callerUserId: guestUserId,
			packageId,
		}),
	).toBe(true)
	expect(
		await resolvePackageStorageOwnerUserId({
			db,
			callerUserId: guestUserId,
			packageId,
		}),
	).toBe(ownerUserId)

	const sourceRead = await authorizeSharedPackagePermission({
		db,
		packageId,
		granteeUserId: guestUserId,
		granteeEmail: guest.email,
		permission: 'read_source',
	})
	expect(sourceRead?.savedPackage.id).toBe(packageId)
	await expect(
		authorizeSharedPackagePermission({
			db,
			packageId,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			permission: 'publish',
		}),
	).resolves.toBeNull()

	const revoked = await revokePackageShare({
		db,
		ownerUserId,
		grantId: invited.id,
	})
	expect(revoked.status).toBe('revoked')
	await expect(
		resolveShareGrantedPackageImport({
			db,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toBeNull()

	const reinvited = await invitePackageShare({
		db,
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	await acceptPackageShare({ db, guest, grantId: reinvited.id })
	const left = await leavePackageShare({
		db,
		granteeUserId: guestUserId,
		grantId: reinvited.id,
	})
	expect(left.status).toBe('left')
})

test('pin fails closed when the owner publishes ahead; follow does not', async () => {
	const { db, packageId, sourceId } = await createHarness()
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const guest = {
		userId: guestUserId,
		email: 'jesse@example.com',
		displayName: 'Jesse',
		username: 'jesse',
	}
	const invited = await invitePackageShare({
		db,
		owner,
		packageId,
		invitee: { username: 'jesse' },
	})
	await acceptPackageShare({
		db,
		guest,
		grantId: invited.id,
		trustLevel: 'pin',
	})
	await db
		.prepare(`UPDATE entity_sources SET published_commit = ? WHERE id = ?`)
		.bind('commit-2', sourceId)
		.run()

	await expect(
		resolveShareGrantedPackageImport({
			db,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).rejects.toBeInstanceOf(PackageSharePinAheadError)

	const acknowledged = await acknowledgePackageShareUpdate({
		db,
		granteeUserId: guestUserId,
		grantId: invited.id,
	})
	expect(acknowledged.acceptedPublishedCommit).toBe('commit-2')
	await expect(
		resolveShareGrantedPackageImport({
			db,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toMatchObject({ sourceOwnerUserId: ownerUserId })

	await acknowledgePackageShareUpdate({
		db,
		granteeUserId: guestUserId,
		grantId: invited.id,
		switchToFollow: true,
	})
	await db
		.prepare(`UPDATE entity_sources SET published_commit = ? WHERE id = ?`)
		.bind('commit-3', sourceId)
		.run()
	await expect(
		resolveShareGrantedPackageImport({
			db,
			granteeUserId: guestUserId,
			granteeEmail: guest.email,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toMatchObject({ sourceOwnerUserId: ownerUserId })
})

test('invite-before-signup attaches on account create without auto-accept', async () => {
	const { db, packageId } = await createHarness()
	const invited = await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { email: 'newguest@example.com' },
	})
	expect(invited.status).toBe('pending')
	expect(invited.granteeUserId).toBeNull()

	await db
		.prepare(`UPDATE users SET email = ? WHERE stable_user_id = ?`)
		.bind('newguest@example.com', guestUserId)
		.run()
	const attached = await attachPendingPackageShareInvitesForEmail({
		db,
		userId: guestUserId,
		email: 'newguest@example.com',
		username: 'jesse',
	})
	expect(attached.attached).toBe(1)
	const inbound = await listInboundPackageShareGrants(db, {
		userId: guestUserId,
		email: 'newguest@example.com',
	})
	expect(inbound[0]?.status).toBe('pending')
	expect(inbound[0]?.granteeUserId).toBe(guestUserId)
	await expect(
		resolveShareGrantedPackageImport({
			db,
			granteeUserId: guestUserId,
			packageName: '@alice/shared-notes',
		}),
	).resolves.toBeNull()
})

test('both sides must stay paid to use a shared package', async () => {
	const { db, packageId } = await createHarness()
	const invited = await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	const accepted = await acceptPackageShare({
		db,
		guest: {
			userId: guestUserId,
			email: 'jesse@example.com',
			displayName: 'Jesse',
			username: 'jesse',
		},
		grantId: invited.id,
	})
	await db
		.prepare(`UPDATE users SET plan = 'free' WHERE stable_user_id = ?`)
		.bind(guestUserId)
		.run()
	await expect(
		assertPackageShareUseAllowed({
			db,
			grant: accepted,
			savedPackage: {
				id: packageId,
				userId: ownerUserId,
				name: '@alice/shared-notes',
				kodyId: 'shared-notes',
				description: '',
				tags: [],
				searchText: null,
				sourceId: `source-${packageId}`,
				hasApp: false,
				hidden: false,
				isPrivate: true,
				lockedAt: null,
				createdAt: '',
				updatedAt: '',
			},
			guest: { userId: guestUserId, email: 'jesse@example.com' },
		}),
	).rejects.toBeInstanceOf(PackageSharePaidRequiredError)
})

test('outbound and inbound lists separate owner and guest views', async () => {
	const { db, packageId } = await createHarness()
	await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	const outbound = await listOutboundPackageShareGrants(db, ownerUserId)
	expect(outbound).toHaveLength(1)
	expect(outbound[0]?.ownerUserId).toBe(ownerUserId)
	const inbound = await listInboundPackageShareGrants(db, {
		userId: guestUserId,
		email: 'jesse@example.com',
	})
	expect(inbound).toHaveLength(1)
	expect(inbound[0]?.inviteeEmail).toBeNull()
	expect(inbound[0]?.inviteeUsername).toBe('jesse')
})

test('username invites do not expose the invitee email to the owner', async () => {
	const { db, packageId } = await createHarness()
	const invited = await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	expect(invited.inviteeEmail).toBeNull()
	const views = await hydratePackageShareGrantViews(db, [invited])
	expect(views[0]?.inviteeEmail).toBeNull()
	expect(views[0]?.inviteeUsername).toBe('jesse')
})

test('a later owner of an invite email cannot steal a bound grant', async () => {
	const { db, packageId } = await createHarness()
	const invited = await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { email: 'steal@example.com' },
	})
	expect(invited.granteeUserId).toBeNull()
	await db
		.prepare(`UPDATE users SET email = ? WHERE stable_user_id = ?`)
		.bind('steal@example.com', guestUserId)
		.run()
	await attachPendingPackageShareInvitesForEmail({
		db,
		userId: guestUserId,
		email: 'steal@example.com',
		username: 'jesse',
	})
	await db
		.prepare(`UPDATE users SET email = ? WHERE stable_user_id = ?`)
		.bind('jesse-released@example.com', guestUserId)
		.run()
	const attackerUserId = 'dd'.repeat(32)
	await insertUser(db, {
		username: 'attacker',
		email: 'steal@example.com',
		userId: attackerUserId,
		plan: 'standard',
	})
	const inbound = await listInboundPackageShareGrants(db, {
		userId: attackerUserId,
		email: 'steal@example.com',
		emailVerified: true,
	})
	expect(inbound.some((grant) => grant.id === invited.id)).toBe(false)
	await expect(
		acceptPackageShare({
			db,
			guest: {
				userId: attackerUserId,
				email: 'steal@example.com',
				displayName: 'Attacker',
				username: 'attacker',
			},
			grantId: invited.id,
		}),
	).rejects.toThrow('not addressed')
})

test('unverified email does not reveal unbound email invites', async () => {
	const { db, packageId } = await createHarness()
	await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { email: 'unverified@example.com' },
	})
	const inbound = await listInboundPackageShareGrants(db, {
		userId: guestUserId,
		email: 'unverified@example.com',
		emailVerified: false,
	})
	expect(inbound).toHaveLength(0)
})

test('hydrate skips grants whose saved package is gone', async () => {
	const { db, packageId } = await createHarness()
	await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	await db
		.prepare(`DELETE FROM saved_packages WHERE id = ?`)
		.bind(packageId)
		.run()
	const outbound = await listOutboundPackageShareGrants(db, ownerUserId)
	expect(outbound).toHaveLength(1)
	expect(await hydratePackageShareGrantViews(db, outbound)).toEqual([])
})

test('re-inviting an accepted email grant fails with a conflict, not a unique-index 500', async () => {
	const { db, packageId } = await createHarness()
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const invited = await invitePackageShare({
		db,
		owner,
		packageId,
		invitee: { email: 'jesse@example.com' },
	})
	await acceptPackageShare({
		db,
		guest: {
			userId: guestUserId,
			email: 'jesse@example.com',
			displayName: 'Jesse',
			username: 'jesse',
		},
		grantId: invited.id,
	})
	await expect(
		invitePackageShare({
			db,
			owner,
			packageId,
			invitee: { email: 'jesse@example.com' },
		}),
	).rejects.toThrow('already has an accepted share grant')
})

test('unverified email cannot attach or accept an unbound invite', async () => {
	const { db, packageId } = await createHarness()
	const owner = {
		userId: ownerUserId,
		email: 'alice@example.com',
		displayName: 'Alice',
		username: 'alice',
	}
	const invited = await invitePackageShare({
		db,
		owner,
		packageId,
		invitee: { email: 'unverified-claim@example.com' },
	})
	const attackerUserId = 'ee'.repeat(32)
	await insertUser(db, {
		username: 'unverified',
		email: 'unverified-claim@example.com',
		userId: attackerUserId,
		plan: 'standard',
		emailVerified: false,
	})
	const attached = await attachPendingPackageShareInvitesForEmail({
		db,
		userId: attackerUserId,
		email: 'unverified-claim@example.com',
		username: 'unverified',
	})
	expect(attached.attached).toBe(0)
	expect(invited.granteeUserId).toBeNull()
	expect(
		grantIsAddressedToGuest(
			invited,
			attackerUserId,
			'unverified-claim@example.com',
			false,
		),
	).toBe(false)
	await expect(
		acceptPackageShare({
			db,
			guest: {
				userId: attackerUserId,
				email: 'unverified-claim@example.com',
				displayName: 'Unverified',
				username: 'unverified',
			},
			grantId: invited.id,
		}),
	).rejects.toThrow('not addressed')
})

test('search skips pin-ahead shared packages until the guest approves', async () => {
	const { db, packageId, sourceId } = await createHarness()
	const invited = await invitePackageShare({
		db,
		owner: {
			userId: ownerUserId,
			email: 'alice@example.com',
			displayName: 'Alice',
			username: 'alice',
		},
		packageId,
		invitee: { username: 'jesse' },
	})
	await acceptPackageShare({
		db,
		guest: {
			userId: guestUserId,
			email: 'jesse@example.com',
			displayName: 'Jesse',
			username: 'jesse',
		},
		grantId: invited.id,
		trustLevel: 'pin',
	})
	expect(
		await listAcceptedInboundSharedPackages({
			db,
			granteeUserId: guestUserId,
		}),
	).toHaveLength(1)
	await db
		.prepare(`UPDATE entity_sources SET published_commit = ? WHERE id = ?`)
		.bind('commit-ahead', sourceId)
		.run()
	expect(
		await listAcceptedInboundSharedPackages({
			db,
			granteeUserId: guestUserId,
		}),
	).toHaveLength(0)
})
