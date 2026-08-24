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
		pagesScanned: number
		complete: boolean
	}
}

export async function loadPackageInvokePrefixlessEvidenceAggregate(
	env: Pick<Env, 'APP_DB' | 'USER_METER'>,
): Promise<PackageInvokePrefixlessEvidenceAggregate> {
	const expectedRow = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count
		 FROM users
		 WHERE deleting_at IS NULL
		   AND stable_user_id IS NOT NULL
		   AND stable_user_id != ''`,
	).first<{ count: number }>()
	const usersExpected = Math.max(0, Number(expectedRow?.count) || 0)
	const totals = emptyPackageInvokePrefixlessEvidenceCounts()
	let usersEnumerated = 0
	let usersAttempted = 0
	let usersLoaded = 0
	let usersMissingEpoch = 0
	let usersUnreachable = 0
	let pagesScanned = 0
	let startAfterId: string | null = null

	while (true) {
		const statement = startAfterId
			? env.APP_DB.prepare(
					`SELECT id, stable_user_id
					 FROM users
					 WHERE deleting_at IS NULL
					   AND stable_user_id IS NOT NULL
					   AND stable_user_id != ''
					   AND id > ?
					 ORDER BY id ASC
					 LIMIT ?`,
				).bind(startAfterId, packageInvokeEvidenceAdminPageSize)
			: env.APP_DB.prepare(
					`SELECT id, stable_user_id
					 FROM users
					 WHERE deleting_at IS NULL
					   AND stable_user_id IS NOT NULL
					   AND stable_user_id != ''
					 ORDER BY id ASC
					 LIMIT ?`,
				).bind(packageInvokeEvidenceAdminPageSize)
		const page = await statement.all<EvidenceUserRow>()
		const users = page.results ?? []
		if (users.length === 0) break
		pagesScanned += 1
		usersEnumerated += users.length
		usersAttempted += users.length

		const reads = await Promise.allSettled(
			users.map((user) =>
				userMeterRpc({
					env,
					userId: user.stable_user_id,
				}).readPackageInvokePrefixless({
					epoch: packageInvokePrefixlessEvidenceEpoch,
				}),
			),
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

	const complete =
		usersEnumerated === usersExpected &&
		usersAttempted === usersExpected &&
		usersLoaded === usersExpected &&
		usersMissingEpoch === 0 &&
		usersUnreachable === 0
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
			pagesScanned,
			complete,
		},
	}
}
