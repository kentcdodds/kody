import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import {
	emptyPackageInvokePrefixlessEvidenceCounts,
	packageInvokePrefixlessEvidenceEpoch,
	type PackageInvokePrefixlessEvidenceCounts,
} from '#universal/package-invoke-prefixless-evidence.ts'

export const packageInvokeEvidenceAdminPageSize = 50

type EvidenceUserRow = {
	id: string
	stable_user_id: string
	deleting_at: string | null
}

export type PackageInvokePrefixlessEvidenceAggregate = {
	epoch: string
	totals: PackageInvokePrefixlessEvidenceCounts
	population: {
		usersExpected: number
		usersEnumerated: number
		usersAttempted: number
		usersLoaded: number
		usersMissingEpoch: number
		usersUnreachable: number
		usersDeleting: number
		pagesScanned: number
		populationVersion: string
		complete: boolean
	}
}

async function hashEvidencePopulation(
	stableUserIds: ReadonlyArray<string>,
): Promise<string> {
	const encoded = new TextEncoder().encode(
		stableUserIds.map((userId) => `${userId.length}:${userId}`).join('|'),
	)
	const digest = await crypto.subtle.digest('SHA-256', encoded)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

async function listEvidenceUsersPage(input: {
	db: D1Database
	startAfterId: string | null
}): Promise<Array<EvidenceUserRow>> {
	let statement: D1PreparedStatement
	if (input.startAfterId) {
		statement = input.db
			.prepare(
				`SELECT id, stable_user_id, deleting_at
				 FROM users
				 WHERE stable_user_id IS NOT NULL
				   AND stable_user_id != ''
				   AND id > ?
				 ORDER BY id ASC
				 LIMIT ?`,
			)
			.bind(input.startAfterId, packageInvokeEvidenceAdminPageSize)
	} else {
		statement = input.db
			.prepare(
				`SELECT id, stable_user_id, deleting_at
				 FROM users
				 WHERE stable_user_id IS NOT NULL
				   AND stable_user_id != ''
				 ORDER BY id ASC
				 LIMIT ?`,
			)
			.bind(packageInvokeEvidenceAdminPageSize)
	}
	const result: D1Result<EvidenceUserRow> =
		await statement.all<EvidenceUserRow>()
	return result.results ?? []
}

export async function loadPackageInvokePrefixlessEvidenceAggregate(
	env: Pick<Env, 'APP_DB' | 'USER_METER'>,
): Promise<PackageInvokePrefixlessEvidenceAggregate> {
	const expectedRow = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM users
		 WHERE stable_user_id IS NOT NULL
		   AND stable_user_id != ''`,
	).first<{ count: number }>()
	const usersExpected = Math.max(0, Number(expectedRow?.count) || 0)
	const totals = emptyPackageInvokePrefixlessEvidenceCounts()
	let usersEnumerated = 0
	let usersAttempted = 0
	let usersLoaded = 0
	let usersMissingEpoch = 0
	let usersUnreachable = 0
	let usersDeleting = 0
	let pagesScanned = 0
	let startAfterId: string | null = null
	const populationUserIds: Array<string> = []

	while (true) {
		const users = await listEvidenceUsersPage({
			db: env.APP_DB,
			startAfterId,
		})
		if (users.length === 0) break
		pagesScanned += 1
		usersEnumerated += users.length
		usersAttempted += users.length
		usersDeleting += users.filter((user) => user.deleting_at != null).length
		populationUserIds.push(...users.map((user) => user.stable_user_id))

		const reads = await Promise.allSettled(
			users.map(async (user) => {
				return await userMeterRpc({
					env,
					userId: user.stable_user_id,
				}).readPackageInvokePrefixless({
					epoch: packageInvokePrefixlessEvidenceEpoch,
				})
			}),
		)
		for (const read of reads) {
			if (read.status === 'rejected') {
				usersUnreachable += 1
				continue
			}
			if (read.value.outcome === 'epoch_missing') {
				usersMissingEpoch += 1
				continue
			}
			usersLoaded += 1
			totals.execute += read.value.counts.execute
			totals.package += read.value.counts.package
			totals.job += read.value.counts.job
			totals.app += read.value.counts.app
		}

		const last = users.at(-1)
		if (!last || users.length < packageInvokeEvidenceAdminPageSize) break
		startAfterId = last.id
	}

	const populationVersion = await hashEvidencePopulation(populationUserIds)
	const complete =
		usersEnumerated === usersExpected &&
		usersAttempted === usersExpected &&
		usersLoaded === usersExpected &&
		usersMissingEpoch === 0 &&
		usersUnreachable === 0 &&
		usersDeleting === 0
	return {
		epoch: packageInvokePrefixlessEvidenceEpoch,
		totals,
		population: {
			usersExpected,
			usersEnumerated,
			usersAttempted,
			usersLoaded,
			usersMissingEpoch,
			usersUnreachable,
			usersDeleting,
			pagesScanned,
			populationVersion,
			complete,
		},
	}
}
