import {
	getSavedPackageById,
	getSavedPackageByKodyId,
	listSavedPackagesByUserId,
} from './repo.ts'
import { type SavedPackageRecord } from './types.ts'

type PlatformAccountRef = {
	username: string
	stableUserId: string
}

/**
 * Platform (built-in) packages: packages owned by platform accounts
 * (`users.account_type = 'platform'`), which resolve live in `kody:@scope/…`
 * imports for every caller (decision record 0014). These helpers surface them
 * for discovery; hidden and private packages stay owner-only.
 */
async function listPlatformAccounts(
	db: D1Database,
): Promise<Array<PlatformAccountRef>> {
	const result = await db
		.prepare(
			`SELECT username, stable_user_id FROM users WHERE account_type = 'platform' ORDER BY username ASC`,
		)
		.all<{ username: string; stable_user_id: string }>()
	return (result.results ?? []).map((row) => ({
		username: row.username,
		stableUserId: row.stable_user_id,
	}))
}

export type PlatformPackageForSearch = {
	record: SavedPackageRecord
	platformScope: string
}

export async function listPlatformPackagesForSearch(
	db: D1Database,
): Promise<Array<PlatformPackageForSearch>> {
	const accounts = await listPlatformAccounts(db)
	const perAccount = await Promise.all(
		accounts.map(async (account) => {
			const records = await listSavedPackagesByUserId(db, {
				userId: account.stableUserId,
			})
			return records
				.filter((record) => !record.hidden && !record.isPrivate)
				.map((record) => ({
					record,
					platformScope: account.username,
				}))
		}),
	)
	return perAccount.flat()
}

export type PlatformPackageByRef = {
	record: SavedPackageRecord
	platformScope: string
	ownerUserId: string
}

/**
 * Resolve an entity ref (saved-package UUID or kody id) against platform
 * accounts, for search detail of platform packages the caller does not own.
 */
export async function findPlatformPackageByRef(
	db: D1Database,
	input: { idOrKodyId: string },
): Promise<PlatformPackageByRef | null> {
	const accounts = await listPlatformAccounts(db)
	for (const account of accounts) {
		const record =
			(await getSavedPackageById(db, {
				userId: account.stableUserId,
				packageId: input.idOrKodyId,
			})) ??
			(await getSavedPackageByKodyId(db, {
				userId: account.stableUserId,
				kodyId: input.idOrKodyId,
			}))
		if (record && !record.hidden && !record.isPrivate) {
			return {
				record,
				platformScope: account.username,
				ownerUserId: account.stableUserId,
			}
		}
	}
	return null
}
