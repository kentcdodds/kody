import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import {
	deletePackageKodyIdRedirects,
	releasePackageKodyIdRedirect,
	resolveCommunityPackageUrl,
	retirePackageKodyId,
	retireUsername,
} from './package-url.ts'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

function uniqueSuffix() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

async function insertUser(username: string) {
	await ensureCommunityFlowSchema(env.APP_DB)
	const email = `${username}-${uniqueSuffix()}@example.com`
	const userId = await createStableUserIdFromEmail(email)
	await runSql(
		`INSERT INTO users (
			username, email, stable_user_id, profile_visibility, password_hash, plan
		) VALUES (?, ?, ?, 'public', 'test-password-hash', 'max')`,
		username,
		email,
		userId,
	)
	return { userId, username }
}

async function renameUser(input: { userId: string; username: string }) {
	await runSql(
		`UPDATE users SET username = ? WHERE stable_user_id = ?`,
		input.username,
		input.userId,
	)
}

async function insertPackage(input: {
	id: string
	userId: string
	kodyId: string
}) {
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, is_private
		) VALUES (?, ?, ?, ?, ?, ?, 0)`,
		input.id,
		input.userId,
		`@owner/${input.kodyId}`,
		input.kodyId,
		`${input.kodyId} description`,
		`source-${input.id}`,
	)
}

async function insertListing(input: {
	id: string
	ownerUserId: string
	packageId: string
	kodyId: string
	status?: 'active' | 'delisted'
}) {
	await runSql(
		`INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			license, pinned_commit, status
		) VALUES (?, ?, ?, ?, ?, ?, ?, 'MIT', 'commit-1', ?)`,
		input.id,
		input.ownerUserId,
		input.packageId,
		`source-${input.packageId}`,
		input.kodyId,
		`@owner/${input.kodyId}`,
		`${input.kodyId} description`,
		input.status ?? 'active',
	)
}

/**
 * One owner with one published package, addressed as `/@username/kodyId`.
 */
async function createPublishedPackage(kodyId = 'devin') {
	const suffix = uniqueSuffix()
	const user = await insertUser(`owner${suffix}`)
	const packageId = `pkg-${suffix}`
	const listingId = `listing-${suffix}`
	await insertPackage({ id: packageId, userId: user.userId, kodyId })
	await insertListing({
		id: listingId,
		ownerUserId: user.userId,
		packageId,
		kodyId,
	})
	return { ...user, packageId, listingId, kodyId }
}

test('canonical pairs resolve, miss, delist, and case-correct to the listing', async () => {
	const pkg = await createPublishedPackage()

	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: pkg.username,
			kodyId: pkg.kodyId,
		}),
	).resolves.toEqual({
		kind: 'listing',
		listingId: pkg.listingId,
		username: pkg.username,
		kodyId: pkg.kodyId,
	})

	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: `nobody${uniqueSuffix()}`,
			kodyId: pkg.kodyId,
		}),
	).resolves.toBeNull()
	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: pkg.username,
			kodyId: 'not-published',
		}),
	).resolves.toBeNull()
	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: pkg.username,
			kodyId: 'Not A Kody Id',
		}),
	).resolves.toBeNull()

	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: pkg.username.toUpperCase(),
			kodyId: pkg.kodyId.toUpperCase(),
		}),
	).resolves.toEqual({
		kind: 'redirect',
		listingId: pkg.listingId,
		username: pkg.username,
		kodyId: pkg.kodyId,
	})

	const suffix = uniqueSuffix()
	const delistedOwner = await insertUser(`owner${suffix}`)
	await insertPackage({
		id: `pkg-${suffix}`,
		userId: delistedOwner.userId,
		kodyId: 'devin',
	})
	await insertListing({
		id: `listing-${suffix}`,
		ownerUserId: delistedOwner.userId,
		packageId: `pkg-${suffix}`,
		kodyId: 'devin',
		status: 'delisted',
	})
	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: delistedOwner.username,
			kodyId: 'devin',
		}),
	).resolves.toBeNull()
})

test('retired usernames redirect through rename chains until a reclaim wins', async () => {
	const pkg = await createPublishedPackage()
	const middle = `middle${uniqueSuffix()}`
	const latest = `latest${uniqueSuffix()}`

	await renameUser({ userId: pkg.userId, username: middle })
	await retireUsername({
		db: env.APP_DB,
		oldUsername: pkg.username,
		newUsername: middle,
		userId: pkg.userId,
	})
	await renameUser({ userId: pkg.userId, username: latest })
	await retireUsername({
		db: env.APP_DB,
		oldUsername: middle,
		newUsername: latest,
		userId: pkg.userId,
	})

	for (const oldUsername of [pkg.username, middle]) {
		await expect(
			resolveCommunityPackageUrl({
				db: env.APP_DB,
				username: oldUsername,
				kodyId: pkg.kodyId,
			}),
		).resolves.toEqual({
			kind: 'redirect',
			listingId: pkg.listingId,
			username: latest,
			kodyId: pkg.kodyId,
		})
	}

	// Someone else takes the released username and publishes under it.
	const suffix = uniqueSuffix()
	const claimer = await insertUser(pkg.username)
	await insertPackage({
		id: `pkg-${suffix}`,
		userId: claimer.userId,
		kodyId: pkg.kodyId,
	})
	await insertListing({
		id: `listing-${suffix}`,
		ownerUserId: claimer.userId,
		packageId: `pkg-${suffix}`,
		kodyId: pkg.kodyId,
	})

	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: pkg.username,
			kodyId: pkg.kodyId,
		}),
	).resolves.toEqual({
		kind: 'listing',
		listingId: `listing-${suffix}`,
		username: pkg.username,
		kodyId: pkg.kodyId,
	})
})

test('retired kody ids follow the package, die when unpublished, and clear on claim or delete', async () => {
	const pkg = await createPublishedPackage()
	await runSql(
		`UPDATE saved_packages SET kody_id = 'devin-two' WHERE id = ?`,
		pkg.packageId,
	)
	await runSql(
		`UPDATE community_listings SET kody_id = 'devin-two' WHERE id = ?`,
		pkg.listingId,
	)
	await retirePackageKodyId({
		db: env.APP_DB,
		userId: pkg.userId,
		packageId: pkg.packageId,
		oldKodyId: pkg.kodyId,
		newKodyId: 'devin-two',
	})

	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: pkg.username,
			kodyId: pkg.kodyId,
		}),
	).resolves.toEqual({
		kind: 'redirect',
		listingId: pkg.listingId,
		username: pkg.username,
		kodyId: 'devin-two',
	})

	const deadEnd = await createPublishedPackage('dead-end')
	await runSql(
		`UPDATE saved_packages SET kody_id = 'dead-end-two' WHERE id = ?`,
		deadEnd.packageId,
	)
	await runSql(`DELETE FROM community_listings WHERE id = ?`, deadEnd.listingId)
	await retirePackageKodyId({
		db: env.APP_DB,
		userId: deadEnd.userId,
		packageId: deadEnd.packageId,
		oldKodyId: deadEnd.kodyId,
		newKodyId: 'dead-end-two',
	})
	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: deadEnd.username,
			kodyId: deadEnd.kodyId,
		}),
	).resolves.toBeNull()

	const released = await createPublishedPackage('release-me')
	await retirePackageKodyId({
		db: env.APP_DB,
		userId: released.userId,
		packageId: released.packageId,
		oldKodyId: 'release-old',
		newKodyId: released.kodyId,
	})
	await deletePackageKodyIdRedirects({
		db: env.APP_DB,
		userId: released.userId,
		packageId: released.packageId,
	})
	const remaining = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM package_kody_id_redirects WHERE package_id = ?`,
	)
		.bind(released.packageId)
		.first<{ count: number }>()
	expect(remaining?.count).toBe(0)

	const claim = await createPublishedPackage('claim-me')
	// An earlier package of the same owner moved off `claim-old`, then a new
	// package takes the freed id: the old forwarding row has to go, or the new
	// package's own URL would send visitors to its predecessor.
	await retirePackageKodyId({
		db: env.APP_DB,
		userId: claim.userId,
		packageId: `pkg-other-${uniqueSuffix()}`,
		oldKodyId: 'claim-old',
		newKodyId: 'claim-new',
	})
	await releasePackageKodyIdRedirect({
		db: env.APP_DB,
		userId: claim.userId,
		kodyId: 'claim-old',
	})
	await expect(
		resolveCommunityPackageUrl({
			db: env.APP_DB,
			username: claim.username,
			kodyId: 'claim-old',
		}),
	).resolves.toBeNull()
})

test('one owner cannot have two active listings on one kody id', async () => {
	const pkg = await createPublishedPackage()
	const suffix = uniqueSuffix()
	await insertPackage({
		id: `pkg-${suffix}`,
		userId: pkg.userId,
		kodyId: `other-${suffix}`,
	})

	await expect(
		insertListing({
			id: `listing-${suffix}`,
			ownerUserId: pkg.userId,
			packageId: `pkg-${suffix}`,
			kodyId: pkg.kodyId,
		}),
	).rejects.toThrow(/UNIQUE/i)
})
