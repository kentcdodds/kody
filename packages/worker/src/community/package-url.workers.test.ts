import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import {
	deletePackageKodyIdRedirects,
	releasePackageKodyIdRedirect,
	resolveCommunityPackageUrl,
	resolvePackagePageUrl,
	retirePackageKodyId,
	retireUsername,
} from './package-url.ts'

type Owner = { userId: string; username: string }

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

function uniqueSuffix() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 10)
}

async function insertUser(username: string): Promise<Owner> {
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

async function insertPackage(owner: Owner, kodyId: string) {
	const packageId = `pkg-${uniqueSuffix()}`
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, is_private
		) VALUES (?, ?, ?, ?, ?, ?, 0)`,
		packageId,
		owner.userId,
		`@owner/${kodyId}`,
		kodyId,
		`${kodyId} description`,
		`source-${packageId}`,
	)
	return packageId
}

async function insertListing(
	owner: Owner,
	packageId: string,
	kodyId: string,
	status: 'active' | 'delisted' = 'active',
) {
	const listingId = `listing-${uniqueSuffix()}`
	await runSql(
		`INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			license, pinned_commit, status
		) VALUES (?, ?, ?, ?, ?, ?, ?, 'MIT', 'commit-1', ?)`,
		listingId,
		owner.userId,
		packageId,
		`source-${packageId}`,
		kodyId,
		`@owner/${kodyId}`,
		`${kodyId} description`,
		status,
	)
	return listingId
}

/**
 * One owner with one published package, addressed as `/@username/kodyId`.
 */
async function createPublishedPackage(
	kodyId = 'devin',
	input: { owner?: Owner; status?: 'active' | 'delisted' } = {},
) {
	const owner = input.owner ?? (await insertUser(`owner${uniqueSuffix()}`))
	const packageId = await insertPackage(owner, kodyId)
	const listingId = await insertListing(owner, packageId, kodyId, input.status)
	return { ...owner, packageId, listingId, kodyId }
}

function resolve(username: string, kodyId: string) {
	return resolveCommunityPackageUrl({ db: env.APP_DB, username, kodyId })
}

function resolvePage(username: string, kodyId: string) {
	return resolvePackagePageUrl({ db: env.APP_DB, username, kodyId })
}

function retireKodyId(
	owner: Owner,
	packageId: string,
	oldKodyId: string,
	newKodyId: string,
) {
	return retirePackageKodyId({
		db: env.APP_DB,
		userId: owner.userId,
		packageId,
		oldKodyId,
		newKodyId,
	})
}

test('canonical pairs resolve, miss, delist, and case-correct to the listing', async () => {
	const pkg = await createPublishedPackage()
	const delisted = await createPublishedPackage('devin', {
		status: 'delisted',
	})
	const target = {
		listingId: pkg.listingId,
		username: pkg.username,
		kodyId: pkg.kodyId,
	}

	await expect(resolve(pkg.username, pkg.kodyId)).resolves.toEqual({
		kind: 'listing',
		...target,
	})
	await expect(
		resolve(pkg.username.toUpperCase(), pkg.kodyId.toUpperCase()),
	).resolves.toEqual({ kind: 'redirect', ...target })

	const misses: Array<[username: string, kodyId: string]> = [
		[`nobody${uniqueSuffix()}`, pkg.kodyId],
		[pkg.username, 'not-published'],
		[pkg.username, 'Not A Kody Id'],
		[delisted.username, delisted.kodyId],
	]
	for (const [username, kodyId] of misses) {
		expect({
			username,
			kodyId,
			resolved: await resolve(username, kodyId),
		}).toEqual({ username, kodyId, resolved: null })
	}
})

test('retired usernames redirect through rename chains until a reclaim wins', async () => {
	const pkg = await createPublishedPackage()
	const middle = `middle${uniqueSuffix()}`
	const latest = `latest${uniqueSuffix()}`

	for (const [oldUsername, newUsername] of [
		[pkg.username, middle],
		[middle, latest],
	] as const) {
		await runSql(
			`UPDATE users SET username = ? WHERE stable_user_id = ?`,
			newUsername,
			pkg.userId,
		)
		await retireUsername({
			db: env.APP_DB,
			oldUsername,
			newUsername,
			userId: pkg.userId,
		})
	}

	for (const oldUsername of [pkg.username, middle]) {
		await expect(resolve(oldUsername, pkg.kodyId)).resolves.toEqual({
			kind: 'redirect',
			listingId: pkg.listingId,
			username: latest,
			kodyId: pkg.kodyId,
		})
	}

	// Someone else takes the released username and publishes under it.
	const claimed = await createPublishedPackage(pkg.kodyId, {
		owner: await insertUser(pkg.username),
	})
	await expect(resolve(pkg.username, pkg.kodyId)).resolves.toEqual({
		kind: 'listing',
		listingId: claimed.listingId,
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
	await retireKodyId(pkg, pkg.packageId, pkg.kodyId, 'devin-two')
	await expect(resolve(pkg.username, pkg.kodyId)).resolves.toEqual({
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
	await retireKodyId(deadEnd, deadEnd.packageId, deadEnd.kodyId, 'dead-end-two')
	await expect(resolve(deadEnd.username, deadEnd.kodyId)).resolves.toBeNull()

	const released = await createPublishedPackage('release-me')
	await retireKodyId(
		released,
		released.packageId,
		'release-old',
		released.kodyId,
	)
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
	await retireKodyId(
		claim,
		`pkg-other-${uniqueSuffix()}`,
		'claim-old',
		'claim-new',
	)
	await releasePackageKodyIdRedirect({
		db: env.APP_DB,
		userId: claim.userId,
		kodyId: 'claim-old',
	})
	await expect(resolve(claim.username, 'claim-old')).resolves.toBeNull()
})

test('one owner cannot have two active listings on one kody id', async () => {
	const pkg = await createPublishedPackage()
	const otherPackageId = await insertPackage(pkg, `other-${uniqueSuffix()}`)
	await expect(insertListing(pkg, otherPackageId, pkg.kodyId)).rejects.toThrow(
		/UNIQUE/i,
	)
})

test('package page URL resolves unpublished saved packages and listed ones', async () => {
	const listed = await createPublishedPackage('listed-notes')
	await expect(
		resolvePage(listed.username, listed.kodyId),
	).resolves.toMatchObject({
		kind: 'package',
		username: listed.username,
		kodyId: listed.kodyId,
		userId: listed.userId,
		listingId: listed.listingId,
		savedPackage: { id: listed.packageId, kodyId: listed.kodyId },
	})

	const owner = await insertUser(`unlisted${uniqueSuffix()}`)
	const packageId = await insertPackage(owner, 'private-notes')
	await expect(
		resolvePage(owner.username, 'private-notes'),
	).resolves.toMatchObject({
		kind: 'package',
		username: owner.username,
		kodyId: 'private-notes',
		userId: owner.userId,
		listingId: null,
		savedPackage: { id: packageId, kodyId: 'private-notes' },
	})
	await expect(resolve(owner.username, 'private-notes')).resolves.toBeNull()
})

test('package page URL attaches the saved package when listing kody id lags a rename', async () => {
	const pkg = await createPublishedPackage('listing-lag')
	await runSql(
		`UPDATE saved_packages SET kody_id = 'listing-lag-two' WHERE id = ?`,
		pkg.packageId,
	)
	await retireKodyId(pkg, pkg.packageId, pkg.kodyId, 'listing-lag-two')

	const listingFields = {
		username: pkg.username,
		userId: pkg.userId,
		listingId: pkg.listingId,
		listingKodyId: pkg.kodyId,
	}
	for (const kodyId of [pkg.kodyId, 'listing-lag-two']) {
		await expect(resolvePage(pkg.username, kodyId)).resolves.toMatchObject({
			kind: 'package',
			kodyId,
			...listingFields,
			savedPackage: { id: pkg.packageId, kodyId: 'listing-lag-two' },
		})
	}
	await expect(
		resolvePage(pkg.username.toUpperCase(), pkg.kodyId.toUpperCase()),
	).resolves.toMatchObject({
		kind: 'redirect',
		username: pkg.username,
		kodyId: pkg.kodyId,
		listingId: pkg.listingId,
		listingKodyId: pkg.kodyId,
	})
})
