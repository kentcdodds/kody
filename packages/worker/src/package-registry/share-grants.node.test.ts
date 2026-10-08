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
	collectShareStorageOwners,
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
	retainAuthorizedPackageStorageGrantIds,
	resolveShareGrantedPackageImport,
	revokePackageShare,
} from './share-grants.ts'
import {
	disablePackageShareGrantsForTests,
	enablePackageShareGrantsForTests,
} from './share-flag.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

const ownerUserId = 'aa'.repeat(32)
const guestUserId = 'bb'.repeat(32)
const freeUserId = 'cc'.repeat(32)
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
const notEnabled = 'Package sharing is not enabled for this account.'

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

/** Inserts a user whose username is the email local part. */
function insertUserByEmail(
	db: D1Database,
	userId: string,
	email: string,
	emailVerified = true,
) {
	return insertUser(db, {
		username: email.split('@')[0]!,
		email,
		userId,
		plan: 'standard',
		emailVerified,
	})
}

async function seedPublishedPackage(
	db: D1Database,
	input: { userId: string; name: string; kodyId: string },
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
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})
	await insertEntitySource(db, {
		id: sourceId,
		user_id: input.userId,
		entity_kind: 'package',
		entity_id: id,
		repo_id: `repo-${sourceId}`,
		published_commit: 'commit-1',
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

async function createHarness({ shareGrantsEnabled = true } = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	if (shareGrantsEnabled) await enablePackageShareGrantsForTests(db)
	await insertUser(db, { ...owner, plan: 'standard' })
	await insertUser(db, { ...guest, plan: 'standard' })
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
	const run = (sql: string, ...values: Array<unknown>) =>
		db
			.prepare(sql)
			.bind(...values)
			.run()
	return {
		db,
		...seeded,
		invite: (
			invitee: { username: string } | { email: string },
			inviter = owner,
		) =>
			invitePackageShare({
				db,
				owner: inviter,
				packageId: seeded.packageId,
				invitee,
			}),
		accept: (
			grantId: string,
			trustLevel?: 'pin' | 'follow',
			as: typeof guest = guest,
		) => acceptPackageShare({ db, guest: as, grantId, trustLevel }),
		resolveImport: (granteeEmail: string | null = guest.email) =>
			resolveShareGrantedPackageImport({
				db,
				granteeUserId: guestUserId,
				granteeEmail: granteeEmail ?? undefined,
				packageName: '@alice/shared-notes',
			}),
		authorize: (permission: 'invoke' | 'read_source' | 'publish') =>
			authorizeSharedPackagePermission({
				db,
				packageId: seeded.packageId,
				granteeUserId: guestUserId,
				granteeEmail: guest.email,
				permission,
			}),
		setUserEmail: (userId: string, email: string) =>
			run(`UPDATE users SET email = ? WHERE stable_user_id = ?`, email, userId),
		publishCommit: (commit: string) =>
			run(
				`UPDATE entity_sources SET published_commit = ? WHERE id = ?`,
				commit,
				seeded.sourceId,
			),
		run,
	}
}

function countingDb(db: D1Database) {
	const statements: Array<string> = []
	const reads = { inFlight: 0, maxInFlight: 0 }
	const counted = new Proxy(db, {
		get(target, property, receiver) {
			if (property === 'prepare') {
				return (query: string) => {
					statements.push(query.replace(/\s+/g, ' ').trim())
					const statement = target.prepare(query)
					return {
						bind: (...values: Array<unknown>) => {
							const bound = statement.bind(...values)
							return {
								async first<T>() {
									reads.inFlight += 1
									reads.maxInFlight = Math.max(
										reads.maxInFlight,
										reads.inFlight,
									)
									await new Promise((resolve) => setTimeout(resolve, 5))
									reads.inFlight -= 1
									return bound.first<T>()
								},
							}
						},
					}
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})
	return { db: counted, statements, reads }
}

test('execute storage grant checks skip empty sets and verify ownership concurrently', async () => {
	const { db, packageId } = await createHarness()
	const second = await seedPublishedPackage(db, {
		userId: ownerUserId,
		name: '@alice/second',
		kodyId: 'second',
	})
	const counting = countingDb(db)

	await expect(
		collectShareStorageOwners({
			db: counting.db,
			callerUserId: ownerUserId,
			packageIds: [],
		}),
	).resolves.toEqual(new Map())
	expect(counting.statements).toEqual([])

	const retained = await retainAuthorizedPackageStorageGrantIds({
		db: counting.db,
		callerUserId: ownerUserId,
		packageIds: [packageId, second.packageId, 'not-mine'],
		storageOwnerByPackageId: new Map(),
	})
	expect(retained).toEqual(new Set([packageId, second.packageId]))
	expect(counting.reads.maxInFlight).toBe(3)
})

test('invite fails closed when package-share-grants is off', async () => {
	const { invite } = await createHarness({ shareGrantsEnabled: false })
	await expect(invite({ username: 'jesse' })).rejects.toThrow(notEnabled)
})

test('turning package-share-grants off cuts accepted runtime access', async () => {
	const { db, packageId, invite, accept, resolveImport, authorize } =
		await createHarness()
	await accept((await invite({ username: 'jesse' })).id)
	await disablePackageShareGrantsForTests(db)

	await expect(resolveImport()).resolves.toBeNull()
	await expect(authorize('invoke')).resolves.toBeNull()
	await expect(
		listAcceptedInboundSharedPackages({ db, granteeUserId: guestUserId }),
	).resolves.toEqual([])
	await expect(
		collectShareStorageOwners({
			db,
			callerUserId: guestUserId,
			packageIds: [packageId],
		}),
	).resolves.toEqual(new Map())
	await expect(
		listInboundPackageShareGrants(db, {
			userId: guestUserId,
			email: guest.email,
			emailVerified: true,
		}),
	).resolves.toEqual([])
	await expect(
		listOutboundPackageShareGrants(db, ownerUserId),
	).resolves.toEqual([])
	await expect(invite({ username: 'freeuser' })).rejects.toThrow(notEnabled)
})

test('invite, accept, revoke, and leave follow paid and accept-required rules', async () => {
	const { db, packageId, invite, accept, resolveImport, authorize } =
		await createHarness()

	await expect(
		invite(
			{ username: 'jesse' },
			{ ...owner, userId: freeUserId, email: 'free@example.com' },
		),
	).rejects.toBeInstanceOf(PackageSharePaidRequiredError)

	const invited = await invite({ username: 'jesse' })
	expect(invited).toMatchObject({
		status: 'pending',
		granteeUserId: guestUserId,
		inviteeEmail: null,
		inviteeUsername: 'jesse',
	})
	await expect(invite({ email: 'jesse@example.com' })).rejects.toThrow(
		'already pending',
	)
	await expect(resolveImport()).resolves.toBeNull()

	const accepted = await accept(invited.id)
	expect(accepted).toMatchObject({
		status: 'accepted',
		trustLevel: 'pin',
		acceptedPublishedCommit: 'commit-1',
	})

	const resolved = await resolveImport()
	expect(resolved?.row.id).toBe(packageId)
	expect(resolved?.sourceOwnerUserId).toBe(ownerUserId)
	const guestCall = { db, callerUserId: guestUserId, packageId }
	expect(await isShareGrantedForeignPackage(guestCall)).toBe(true)
	expect(await resolvePackageStorageOwnerUserId(guestCall)).toBe(ownerUserId)
	const shareOwners = await collectShareStorageOwners({
		db,
		callerUserId: guestUserId,
		packageIds: [packageId],
	})
	expect(shareOwners.get(packageId)).toBe(ownerUserId)
	const retain = (storageOwnerByPackageId: Map<string, string>) =>
		retainAuthorizedPackageStorageGrantIds({
			db,
			callerUserId: guestUserId,
			packageIds: [packageId],
			storageOwnerByPackageId,
		})
	expect(await retain(shareOwners)).toEqual(new Set([packageId]))
	expect(await retain(new Map())).toEqual(new Set())

	expect((await authorize('read_source'))?.savedPackage.id).toBe(packageId)
	await expect(authorize('publish')).resolves.toBeNull()

	const revoked = await revokePackageShare({
		db,
		ownerUserId,
		grantId: invited.id,
	})
	expect(revoked.status).toBe('revoked')
	await expect(resolveImport()).resolves.toBeNull()

	const reinvited = await invite({ username: 'jesse' })
	await accept(reinvited.id)
	const left = await leavePackageShare({
		db,
		granteeUserId: guestUserId,
		grantId: reinvited.id,
	})
	expect(left.status).toBe('left')
})

test('pin fails closed (and hides from search) when the owner publishes ahead; follow does not', async () => {
	const { db, invite, accept, resolveImport, publishCommit } =
		await createHarness()
	const invited = await invite({ username: 'jesse' })
	await accept(invited.id, 'pin')
	const listAccepted = () =>
		listAcceptedInboundSharedPackages({ db, granteeUserId: guestUserId })
	expect(await listAccepted()).toHaveLength(1)

	await publishCommit('commit-2')
	await expect(resolveImport()).rejects.toBeInstanceOf(
		PackageSharePinAheadError,
	)
	expect(await listAccepted()).toHaveLength(0)

	const acknowledge = (input: {
		expectedPublishedCommit?: string
		switchToFollow?: boolean
	}) =>
		acknowledgePackageShareUpdate({
			db,
			granteeUserId: guestUserId,
			grantId: invited.id,
			...input,
		})
	await expect(acknowledge({})).rejects.toMatchObject({
		message: 'Pin approval must name the published commit that was reviewed.',
	})
	await expect(
		acknowledge({ expectedPublishedCommit: 'commit-stale' }),
	).rejects.toMatchObject({
		message:
			'The published package changed since this review. Reload and approve the current commit.',
	})
	const acknowledged = await acknowledge({
		expectedPublishedCommit: 'commit-2',
	})
	expect(acknowledged.acceptedPublishedCommit).toBe('commit-2')
	await expect(resolveImport()).resolves.toMatchObject({
		sourceOwnerUserId: ownerUserId,
	})

	await acknowledge({ switchToFollow: true })
	await publishCommit('commit-3')
	await expect(resolveImport()).resolves.toMatchObject({
		sourceOwnerUserId: ownerUserId,
	})
})

test('invite-before-signup attaches on account create without auto-accept', async () => {
	const { db, invite, resolveImport, setUserEmail } = await createHarness()
	const invited = await invite({ email: 'newguest@example.com' })
	expect(invited.status).toBe('pending')
	expect(invited.granteeUserId).toBeNull()

	await setUserEmail(guestUserId, 'newguest@example.com')
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
	await expect(resolveImport(null)).resolves.toBeNull()
})

test('both sides must stay paid to use a shared package', async () => {
	const { db, packageId, invite, accept, run } = await createHarness()
	const accepted = await accept((await invite({ username: 'jesse' })).id)
	await run(
		`UPDATE users SET plan = 'free' WHERE stable_user_id = ?`,
		guestUserId,
	)
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
				hasSkills: false,
				hidden: false,
				isPrivate: true,
				lockedAt: null,
				createdAt: '',
				updatedAt: '',
			},
			guest: { userId: guestUserId, email: guest.email },
		}),
	).rejects.toBeInstanceOf(PackageSharePaidRequiredError)
})

test('outbound and inbound lists separate owner and guest views without exposing username-invite emails', async () => {
	const { db, invite } = await createHarness()
	const invited = await invite({ username: 'jesse' })
	expect(invited.inviteeEmail).toBeNull()

	const outbound = await listOutboundPackageShareGrants(db, ownerUserId)
	expect(outbound).toHaveLength(1)
	expect(outbound[0]?.ownerUserId).toBe(ownerUserId)
	const inbound = await listInboundPackageShareGrants(db, {
		userId: guestUserId,
		email: guest.email,
	})
	expect(inbound).toHaveLength(1)
	expect(inbound[0]).toMatchObject({
		inviteeEmail: null,
		inviteeUsername: 'jesse',
	})
	const views = await hydratePackageShareGrantViews(db, [invited])
	expect(views[0]).toMatchObject({
		inviteeEmail: null,
		inviteeUsername: 'jesse',
	})
})

test('a later owner of an invite email cannot steal a bound grant', async () => {
	const { db, invite, accept, setUserEmail } = await createHarness()
	const invited = await invite({ email: 'steal@example.com' })
	expect(invited.granteeUserId).toBeNull()
	await setUserEmail(guestUserId, 'steal@example.com')
	await attachPendingPackageShareInvitesForEmail({
		db,
		userId: guestUserId,
		email: 'steal@example.com',
		username: 'jesse',
	})
	await setUserEmail(guestUserId, 'jesse-released@example.com')
	const attackerUserId = 'dd'.repeat(32)
	await insertUserByEmail(db, attackerUserId, 'steal@example.com')

	const inbound = await listInboundPackageShareGrants(db, {
		userId: attackerUserId,
		email: 'steal@example.com',
		emailVerified: true,
	})
	expect(inbound.some((grant) => grant.id === invited.id)).toBe(false)
	await expect(
		accept(invited.id, undefined, {
			userId: attackerUserId,
			email: 'steal@example.com',
			displayName: 'Attacker',
			username: 'steal',
		}),
	).rejects.toThrow('not addressed')
})

test('hydrate skips grants whose saved package is gone', async () => {
	const { db, packageId, invite, run } = await createHarness()
	await invite({ username: 'jesse' })
	await run(`DELETE FROM saved_packages WHERE id = ?`, packageId)
	const outbound = await listOutboundPackageShareGrants(db, ownerUserId)
	expect(outbound).toHaveLength(1)
	expect(await hydratePackageShareGrantViews(db, outbound)).toEqual([])
})

test('re-inviting an accepted email grant fails with a conflict, not a unique-index 500', async () => {
	const { invite, accept } = await createHarness()
	await accept((await invite({ email: guest.email })).id)
	await expect(invite({ email: guest.email })).rejects.toThrow(
		'already has an accepted share grant',
	)
})

test('unverified accounts cannot see, attach, or accept unbound email invites', async () => {
	const { db, invite, accept } = await createHarness()
	const unverifiedGuest = (userId: string, email: string) => ({
		userId,
		email,
		displayName: 'Unverified',
		username: email.split('@')[0]!,
	})

	// Invite sent before the unverified account signs up.
	const claimEmail = 'unverified-claim@example.com'
	const claimInvite = await invite({ email: claimEmail })
	const attackerUserId = 'ee'.repeat(32)
	await insertUserByEmail(db, attackerUserId, claimEmail, false)
	expect(
		await listInboundPackageShareGrants(db, {
			userId: attackerUserId,
			email: claimEmail,
			emailVerified: false,
		}),
	).toHaveLength(0)
	const attached = await attachPendingPackageShareInvitesForEmail({
		db,
		userId: attackerUserId,
		email: claimEmail,
		username: 'unverified-claim',
	})
	expect(attached.attached).toBe(0)
	expect(claimInvite.granteeUserId).toBeNull()
	expect(
		grantIsAddressedToGuest(claimInvite, attackerUserId, claimEmail, false),
	).toBe(false)
	await expect(
		accept(
			claimInvite.id,
			undefined,
			unverifiedGuest(attackerUserId, claimEmail),
		),
	).rejects.toThrow('not addressed')

	// Invite sent to an already-existing unverified account stays unbound.
	const existingEmail = 'unverified-existing@example.com'
	const existingUserId = 'ff'.repeat(32)
	await insertUserByEmail(db, existingUserId, existingEmail, false)
	const existingInvite = await invite({ email: existingEmail })
	expect(existingInvite.granteeUserId).toBeNull()
	expect(
		await listInboundPackageShareGrants(db, {
			userId: existingUserId,
			email: existingEmail,
			emailVerified: false,
		}),
	).toHaveLength(0)
	await expect(
		accept(
			existingInvite.id,
			undefined,
			unverifiedGuest(existingUserId, existingEmail),
		),
	).rejects.toThrow('not addressed')
})

test('username and email invites for the same person conflict in either order', async () => {
	const { db, invite } = await createHarness()

	// Username invite first, then the (unverified) email of that account.
	const namedUserId = '22'.repeat(32)
	await insertUserByEmail(
		db,
		namedUserId,
		'unverified-named@example.com',
		false,
	)
	const invited = await invite({ username: 'unverified-named' })
	expect(invited.granteeUserId).toBe(namedUserId)
	await expect(
		invite({ email: 'unverified-named@example.com' }),
	).rejects.toThrow('already pending')

	// Unbound email invite first, then that person signs up and is invited by
	// username.
	await invite({ email: 'later-jesse@example.com' })
	await insertUserByEmail(db, '11'.repeat(32), 'later-jesse@example.com')
	await expect(invite({ username: 'later-jesse' })).rejects.toThrow(
		'already pending',
	)
})
