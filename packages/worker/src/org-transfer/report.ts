import { type OrgTransferPlan, transferredPackageName } from './plan.ts'
import { type OrgTransferRow } from './snapshot.ts'

const text = (row: OrgTransferRow, column: string) => String(row[column] ?? '')

/**
 * What a transfer moves, as counts and names. Built from plan rows by naming
 * columns explicitly, so ciphertext and other row values never reach output.
 */
export type OrgTransferSummary = {
	from: { id: string; slug: string }
	to: { id: string; slug: string }
	counts: Record<string, number>
	packages: Array<{ id: string; from_name: string; to_name: string }>
	repos: Array<string>
	secrets: Array<{ scope: string; binding: string; name: string }>
	values: Array<{ scope: string; binding: string; name: string }>
	integrations: Array<string>
	oauth_apps: Array<string>
	mcp_servers: Array<string>
	webhooks: Array<{ package: string; name: string }>
	jobs: Array<string>
	storages: Array<{ storage_id: string; kind: string }>
	orphans: Array<{ table: string; key: string; reason: string }>
	clashes: Array<string>
	blockers: Array<string>
	warnings: Array<string>
}

export function summarizeOrgTransferPlan(
	plan: OrgTransferPlan,
): OrgTransferSummary {
	const packageKodyIds = new Map(
		plan.moves.saved_packages.map((row) => [
			text(row, 'id'),
			text(row, 'kody_id'),
		]),
	)
	const bindingLabel = (scope: string, bindingKey: string) =>
		scope === 'user' ? '' : (packageKodyIds.get(bindingKey) ?? bindingKey)
	const entryNames = (entryTable: 'secret_entries' | 'value_entries') =>
		plan.moves[entryTable].map((row) => {
			const bucket = plan.bucketBindings.get(text(row, 'bucket_id'))
			const scope = bucket?.scope ?? ''
			return {
				scope,
				binding: bucket ? bindingLabel(scope, bucket.bindingKey) : '',
				name: text(row, 'name'),
			}
		})
	return {
		from: plan.from,
		to: plan.to,
		counts: Object.fromEntries(
			Object.entries(plan.moves)
				.map(([table, rows]) => [table, rows.length] as const)
				.filter(([, count]) => count > 0),
		),
		packages: plan.moves.saved_packages.map((row) => ({
			id: text(row, 'id'),
			from_name: text(row, 'name'),
			to_name: transferredPackageName(row, plan.to.slug),
		})),
		repos: plan.moves.user_repos.map((row) => text(row, 'name')),
		secrets: entryNames('secret_entries'),
		values: entryNames('value_entries'),
		integrations: plan.moves.user_integrations.map((row) => text(row, 'name')),
		oauth_apps: plan.moves.user_oauth_apps.map((row) => text(row, 'slug')),
		mcp_servers: plan.moves.mcp_server_settings.map((row) => text(row, 'name')),
		webhooks: plan.moves.webhook_endpoints.map((row) => ({
			package: packageKodyIds.get(text(row, 'package_id')) ?? '',
			name: text(row, 'webhook_name'),
		})),
		jobs: plan.jobs.map((job) => job.record.name),
		storages: plan.storageCopies.map((copy) => ({
			storage_id: copy.storageId,
			kind: copy.kind,
		})),
		orphans: plan.orphans.map((orphan) => ({
			table: orphan.table,
			key: orphan.key,
			reason: orphan.reason,
		})),
		clashes: plan.clashes,
		blockers: plan.blockers,
		warnings: plan.warnings,
	}
}
