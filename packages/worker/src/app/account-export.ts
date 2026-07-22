import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	accountExportForeignUserIdColumnsByTable,
	accountExportRedactedColumnsByTable,
	accountExportRedactedForeignUserId,
	accountUserDataTargets,
	buildUserScopedTargetMatch,
	getAccountExportExcludedD1Surfaces,
	isExcludedFromAccountExport,
	getAccountD1UserColumnCoverage,
} from '#app/account-data-targets.ts'
import { getAccountExportExcludedDurableObjects } from '#app/account-user-owned-surfaces.ts'
import { exportJobManagerForUser } from '#worker/jobs/manager-client.ts'
import {
	buildPackageServiceStorageId,
	packageServiceRpc,
} from '#worker/package-runtime/package-service.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
	buildPublishedSourceSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import { buildCommunitySnapshotKvKey } from '#worker/community/snapshot.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { userScopedConnectorSessionKey } from '#worker/remote-connector/connector-session-key.ts'
import { type RemoteConnectorSessionExport } from '#worker/remote-connector/types.ts'
import { resolveUserStableId } from '#worker/user-id.ts'

const accountExportSchemaVersion = 1
const defaultExportPageSize = 100
const maxExportPageSize = 500
// Full exports stream each D1 table in keyset-paged batches of this size so
// memory stays bounded per query even for very large tables (e.g. mailboxes).
const d1ExportPageSize = 500
// Internal alias for the SQLite rowid used as the keyset cursor. Stripped from
// exported rows so the export document schema is unchanged.
const exportRowidColumn = '__account_export_rowid'

export const accountExportSectionNames = [
	'd1_table',
	'storage_runner',
	'oauth_grants',
	'artifact_repos',
	'kv_keys',
	'durable_object_summaries',
] as const

export type AccountExportSectionName =
	(typeof accountExportSectionNames)[number]

type OAuthGrantPage = {
	items: Array<{ id: string; clientId: string }>
	cursor: string | undefined
}

type OAuthHelpersShape = {
	listUserGrants(
		userId: string,
		options: { cursor: string | undefined },
	): Promise<OAuthGrantPage>
}

type AccountExportEnv = Env & {
	OAUTH_PROVIDER?: OAuthHelpersShape
}

type UserSourceSnapshot = {
	sourceId: string
	publishedCommit: string | null
	repoId: string
	entityKind: string
	entityId: string
	manifestPath: string
	sourceRoot: string
}

type UserSavedPackageSnapshot = {
	id: string
	kodyId: string
	sourceId: string
	hasApp: boolean
}

type UserRemoteConnectorSnapshot = {
	instanceId: string
}

type UserPackageServiceSnapshot = {
	packageId: string
	kodyId: string
	sourceId: string
	serviceName: string
}

type UserExportInventory = {
	storageIds: Array<string>
	sourceSnapshots: Array<UserSourceSnapshot>
	savedPackages: Array<UserSavedPackageSnapshot>
	remoteConnectors: Array<UserRemoteConnectorSnapshot>
	packageServices: Array<UserPackageServiceSnapshot>
	communityListingIds: Array<string>
	bundleKvKeys: Array<string>
	artifactRepos: Array<AccountExportArtifactRepo>
}

export type AccountExportManifestSection = {
	count: number
	warnings: Array<string>
	redactedColumns?: Array<string>
}

export type AccountExportManifest = {
	schemaVersion: number
	generatedAt: string
	user: {
		dbUserId: number
		userId: string
	}
	security: {
		secretValuesExported: false
		note: string
	}
	sections: Record<string, AccountExportManifestSection>
	warnings: Array<string>
	chunking: {
		sections: Array<AccountExportSectionName>
		defaultPageSize: number
		maxPageSize: number
	}
	artifacts: {
		canonicalPackageSource: string
	}
	derivedData: {
		vectorize: string
	}
	excludedDurableObjects: Array<{
		name: string
		reason: string
	}>
	excludedD1Surfaces: Array<{
		name: string
		reason: string
	}>
}

export type AccountExportD1Table = {
	table: string
	rows: Array<Record<string, unknown>>
	redactedColumns: Array<string>
	warnings: Array<string>
}

export type AccountExportArtifactRepo = {
	sourceId: string
	entityKind: string
	entityId: string
	repoId: string
	publishedCommit: string | null
	manifestPath: string
	sourceRoot: string
}

type AccountExportDurableObjects = {
	jobManager: unknown | null
	remoteConnectorSessions: Array<{
		instanceId: string
		export: RemoteConnectorSessionExport | null
	}>
	packageServices: Array<{
		packageId: string
		serviceName: string
		status: unknown | null
	}>
	storageRunners: Array<{
		storageId: string
		export: Awaited<
			ReturnType<ReturnType<typeof storageRunnerRpc>['exportStorage']>
		>
	}>
}

export type AccountExportFile = {
	manifest: AccountExportManifest
	d1: Record<string, AccountExportD1Table>
	durableObjects: AccountExportDurableObjects
	oauthGrants: Array<{ id: string; clientId: string }>
	artifactRepos: Array<AccountExportArtifactRepo>
	kvKeys: Array<string>
}

export type AccountExportSectionResult = {
	section: AccountExportSectionName
	items: Array<unknown>
	truncated: boolean
	nextStartAfter: string | null
	pageSize: number
	warnings: Array<string>
}

function normalizePageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: defaultExportPageSize
	return Math.min(Math.max(requested, 1), maxExportPageSize)
}

function paginateItems<T>(input: {
	items: ReadonlyArray<T>
	pageSize: number | undefined
	startAfter: string | undefined
}) {
	const pageSize = normalizePageSize(input.pageSize)
	const startIndex = input.startAfter
		? Number.parseInt(input.startAfter, 10)
		: 0
	const safeStart =
		Number.isFinite(startIndex) && startIndex > 0 ? startIndex : 0
	const page = input.items.slice(safeStart, safeStart + pageSize)
	const nextIndex = safeStart + page.length
	const truncated = nextIndex < input.items.length
	return {
		items: page,
		truncated,
		nextStartAfter: truncated ? String(nextIndex) : null,
		pageSize,
	}
}

function uniqueStrings(values: Iterable<string | null | undefined>) {
	return Array.from(
		new Set(
			Array.from(values)
				.map((value) => value?.trim() ?? '')
				.filter((value) => value.length > 0),
		),
	)
}

function normalizeBoolean(value: unknown) {
	return value === 1 || value === '1' || value === true
}

type D1TableCondition = {
	condition: string
	params: Array<unknown>
}

function buildD1TableConditions(input: {
	mcpUserId: string
	dbUserId: number
}) {
	const conditionsByTable = new Map<string, Array<D1TableCondition>>()
	function add(table: string, condition: D1TableCondition) {
		const existing = conditionsByTable.get(table)
		if (existing) {
			existing.push(condition)
			return
		}
		conditionsByTable.set(table, [condition])
	}
	add('users', { condition: `users.id = ?`, params: [input.dbUserId] })
	for (const target of accountUserDataTargets) {
		if (isExcludedFromAccountExport(target)) {
			continue
		}
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: input.mcpUserId,
			dbUserId: input.dbUserId,
		})
		add(match.table, {
			condition: match.qualifiedWhereSql,
			params: [...match.params],
		})
	}
	return conditionsByTable
}

function sanitizeRow(
	table: string,
	row: Record<string, unknown>,
	mcpUserId: string,
) {
	const redactedColumns = accountExportRedactedColumnsByTable[table] ?? []
	const foreignUserIdColumns =
		accountExportForeignUserIdColumnsByTable[table] ?? []
	const sanitized: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(row)) {
		if (redactedColumns.includes(key)) continue
		if (
			foreignUserIdColumns.includes(key) &&
			typeof value === 'string' &&
			value !== mcpUserId
		) {
			sanitized[key] = accountExportRedactedForeignUserId
			continue
		}
		sanitized[key] = value
	}
	return {
		row: sanitized,
		redactedColumns: redactedColumns.filter((column) => column in row),
	}
}

function rowDedupeKey(row: Record<string, unknown>) {
	if ('id' in row && row.id !== null && row.id !== undefined)
		return String(row.id)
	if ('bucket_id' in row && 'name' in row) {
		return `${String(row.bucket_id)}:${String(row.name)}`
	}
	if ('user_id' in row && 'role_id' in row) {
		return `${String(row.user_id)}:${String(row.role_id)}`
	}
	return JSON.stringify(row)
}

function sortRowsByDedupeKey(rows: Array<Record<string, unknown>>) {
	return rows.sort((left, right) =>
		rowDedupeKey(left).localeCompare(rowDedupeKey(right)),
	)
}

async function selectRows<T extends Record<string, unknown>>(
	env: Env,
	sql: string,
	params: ReadonlyArray<unknown>,
) {
	const result = await env.APP_DB.prepare(sql)
		.bind(...params)
		.all<T>()
	return result.results ?? []
}

// Reads one keyset page of a table: rows are selected by ascending rowid
// strictly after the cursor, with a SQL LIMIT, so a single query never loads
// more than one page regardless of table size. Conditions for every export
// target of the table are OR-combined into one query, which also removes the
// need for cross-target row deduplication.
async function selectD1TablePage(input: {
	env: AccountExportEnv
	table: string
	conditions: ReadonlyArray<D1TableCondition>
	mcpUserId: string
	afterRowid: number
	limit: number
}) {
	const where = input.conditions
		.map((condition) => `(${condition.condition})`)
		.join(' OR ')
	const sql = `SELECT ${input.table}.rowid AS ${exportRowidColumn}, ${input.table}.*
		FROM ${input.table}
		WHERE (${where}) AND ${input.table}.rowid > ?
		ORDER BY ${input.table}.rowid
		LIMIT ?`
	const params = [
		...input.conditions.flatMap((condition) => condition.params),
		input.afterRowid,
		input.limit + 1,
	]
	const rawRows = await selectRows(input.env, sql, params)
	const truncated = rawRows.length > input.limit
	const pageRows = truncated ? rawRows.slice(0, input.limit) : rawRows
	let lastRowid = input.afterRowid
	const rows: Array<ReturnType<typeof sanitizeRow>> = []
	for (const rawRow of pageRows) {
		const { [exportRowidColumn]: rowid, ...columns } = rawRow
		lastRowid = Number(rowid)
		rows.push(sanitizeRow(input.table, columns, input.mcpUserId))
	}
	return { rows, lastRowid, truncated }
}

async function collectD1TableRows(input: {
	env: AccountExportEnv
	table: string
	conditions: ReadonlyArray<D1TableCondition>
	mcpUserId: string
	warnings: Array<string>
}): Promise<AccountExportD1Table> {
	const section: AccountExportD1Table = {
		table: input.table,
		rows: [],
		redactedColumns: [],
		warnings: [],
	}
	const redacted = new Set<string>()
	let afterRowid = 0
	try {
		while (true) {
			const page = await selectD1TablePage({
				env: input.env,
				table: input.table,
				conditions: input.conditions,
				mcpUserId: input.mcpUserId,
				afterRowid,
				limit: d1ExportPageSize,
			})
			for (const entry of page.rows) {
				for (const column of entry.redactedColumns) redacted.add(column)
				section.rows.push(entry.row)
			}
			if (!page.truncated) break
			afterRowid = page.lastRowid
		}
	} catch (error) {
		const warning = `D1 export failed for ${input.table}: ${getErrorMessage(error)}`
		section.warnings.push(warning)
		input.warnings.push(warning)
	}
	section.rows = sortRowsByDedupeKey(section.rows)
	section.redactedColumns = Array.from(redacted).sort()
	return section
}

async function listUserStorageIds(env: Env, userId: string) {
	const [jobRows, archivedRows, runtimeRows, packageRows, serviceRows] =
		await Promise.all([
			selectRows<{ storage_id: string }>(
				env,
				`SELECT storage_id FROM jobs WHERE user_id = ? AND storage_id IS NOT NULL`,
				[userId],
			),
			selectRows<{ storage_id: string }>(
				env,
				`SELECT storage_id FROM archived_job_artifacts WHERE user_id = ? AND storage_id IS NOT NULL`,
				[userId],
			),
			selectRows<{ storage_id: string }>(
				env,
				`SELECT storage_id FROM package_runtime_runs WHERE user_id = ? AND storage_id IS NOT NULL`,
				[userId],
			),
			selectRows<{ id: string }>(
				env,
				`SELECT id FROM saved_packages WHERE user_id = ? AND has_app = 1`,
				[userId],
			),
			selectRows<{ package_id: string; name: string }>(
				env,
				`SELECT DISTINCT package_id, name
				FROM package_runtime_runs
				WHERE user_id = ? AND surface = 'service' AND name IS NOT NULL`,
				[userId],
			),
		])
	return uniqueStrings([
		...jobRows.map((row) => row.storage_id),
		...archivedRows.map((row) => row.storage_id),
		...runtimeRows.map((row) => row.storage_id),
		...packageRows.map((row) => row.id),
		...serviceRows.map((row) =>
			buildPackageServiceStorageId(row.package_id, row.name),
		),
	])
}

async function listUserSourceSnapshots(env: Env, userId: string) {
	const rows = await selectRows<{
		id: string
		published_commit: string | null
		repo_id: string
		entity_kind: string
		entity_id: string
		manifest_path: string
		source_root: string
	}>(
		env,
		`SELECT id, published_commit, repo_id, entity_kind, entity_id, manifest_path, source_root
		FROM entity_sources
		WHERE user_id = ?`,
		[userId],
	)
	return rows.map((row) => ({
		sourceId: row.id,
		publishedCommit: row.published_commit,
		repoId: row.repo_id,
		entityKind: row.entity_kind,
		entityId: row.entity_id,
		manifestPath: row.manifest_path,
		sourceRoot: row.source_root,
	}))
}

async function listUserSavedPackages(env: Env, userId: string) {
	const rows = await selectRows<{
		id: string
		kody_id: string
		source_id: string
		has_app: number | string | boolean
	}>(
		env,
		`SELECT id, kody_id, source_id, has_app
		FROM saved_packages
		WHERE user_id = ?`,
		[userId],
	)
	return rows.map((row) => ({
		id: row.id,
		kodyId: row.kody_id,
		sourceId: row.source_id,
		hasApp: normalizeBoolean(row.has_app),
	}))
}

async function listUserRemoteConnectors(env: Env, userId: string) {
	const rows = await selectRows<{ instance_id: string }>(
		env,
		`SELECT instance_id
		FROM remote_connector_settings
		WHERE user_id = ?`,
		[userId],
	)
	return rows.map((row) => ({
		instanceId: row.instance_id,
	}))
}

async function listUserPackageServices(env: Env, userId: string) {
	const rows = await selectRows<{
		package_id: string
		kody_id: string
		source_id: string | null
		name: string
	}>(
		env,
		`SELECT DISTINCT
			r.package_id,
			COALESCE(p.kody_id, r.package_kody_id) AS kody_id,
			COALESCE(p.source_id, r.source_id) AS source_id,
			r.name
		FROM package_runtime_runs AS r
		LEFT JOIN saved_packages AS p
			ON p.id = r.package_id AND p.user_id = r.user_id
		WHERE r.user_id = ?
			AND r.surface = 'service'
			AND r.name IS NOT NULL`,
		[userId],
	)
	return rows.map((row) => ({
		packageId: row.package_id,
		kodyId: row.kody_id,
		sourceId: row.source_id ?? '',
		serviceName: row.name,
	}))
}

async function listUserCommunityListingIds(env: Env, userId: string) {
	const rows = await selectRows<{ id: string }>(
		env,
		`SELECT id FROM community_listings WHERE owner_user_id = ?`,
		[userId],
	)
	return uniqueStrings(rows.map((row) => row.id))
}

async function listUserBundleKvKeys(input: {
	env: Env
	userId: string
	sourceSnapshots: ReadonlyArray<UserSourceSnapshot>
	communityListingIds: ReadonlyArray<string>
	warnings: Array<string>
}) {
	const published = await selectRows<{ kv_key: string }>(
		input.env,
		`SELECT kv_key FROM published_bundle_artifacts WHERE user_id = ?`,
		[input.userId],
	)
	const keys = new Set(
		uniqueStrings([
			...published.map((row) => row.kv_key),
			...input.sourceSnapshots.flatMap((source) =>
				source.publishedCommit
					? [
							buildPublishedSourceSnapshotKvKey({
								sourceId: source.sourceId,
								publishedCommit: source.publishedCommit,
							}),
							buildPublishedSourceManifestSnapshotKvKey({
								sourceId: source.sourceId,
								publishedCommit: source.publishedCommit,
							}),
						]
					: [],
			),
			...input.communityListingIds.map(buildCommunitySnapshotKvKey),
		]),
	)
	if (!input.env.BUNDLE_ARTIFACTS_KV?.list) return Array.from(keys)
	const prefixes = input.sourceSnapshots.flatMap((source) => [
		`source-snapshot:v1:${source.sourceId}:`,
		`source-manifest-snapshot:v1:${source.sourceId}:`,
	])
	for (const prefix of prefixes) {
		let cursor: string | undefined
		do {
			try {
				const result = await input.env.BUNDLE_ARTIFACTS_KV.list({
					prefix,
					cursor,
				})
				for (const key of result.keys) {
					keys.add(key.name)
				}
				cursor = result.list_complete ? undefined : result.cursor
			} catch (error) {
				input.warnings.push(
					`KV prefix listing failed for ${prefix}: ${getErrorMessage(error)}`,
				)
				cursor = undefined
			}
		} while (cursor)
	}
	return Array.from(keys).sort()
}

async function collectInventory(input: {
	env: AccountExportEnv
	userId: string
	warnings: Array<string>
}): Promise<UserExportInventory> {
	const [
		storageIds,
		sourceSnapshots,
		savedPackages,
		remoteConnectors,
		packageServices,
		communityListingIds,
	] = await Promise.all([
		listUserStorageIds(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate storage ids: ${getErrorMessage(error)}`,
			)
			return [] as Array<string>
		}),
		listUserSourceSnapshots(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate entity sources: ${getErrorMessage(error)}`,
			)
			return [] as Array<UserSourceSnapshot>
		}),
		listUserSavedPackages(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate saved packages: ${getErrorMessage(error)}`,
			)
			return [] as Array<UserSavedPackageSnapshot>
		}),
		listUserRemoteConnectors(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate remote connectors: ${getErrorMessage(error)}`,
			)
			return [] as Array<UserRemoteConnectorSnapshot>
		}),
		listUserPackageServices(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate package services: ${getErrorMessage(error)}`,
			)
			return [] as Array<UserPackageServiceSnapshot>
		}),
		listUserCommunityListingIds(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate community listings: ${getErrorMessage(error)}`,
			)
			return [] as Array<string>
		}),
	])
	const bundleKvKeys = await listUserBundleKvKeys({
		env: input.env,
		userId: input.userId,
		sourceSnapshots,
		communityListingIds,
		warnings: input.warnings,
	}).catch((error) => {
		input.warnings.push(
			`Failed to enumerate bundle KV keys: ${getErrorMessage(error)}`,
		)
		return [] as Array<string>
	})
	const artifactRepos = sourceSnapshots.map((source) => ({
		sourceId: source.sourceId,
		entityKind: source.entityKind,
		entityId: source.entityId,
		repoId: source.repoId,
		publishedCommit: source.publishedCommit,
		manifestPath: source.manifestPath,
		sourceRoot: source.sourceRoot,
	}))
	return {
		storageIds,
		sourceSnapshots,
		savedPackages,
		remoteConnectors,
		packageServices,
		communityListingIds,
		bundleKvKeys,
		artifactRepos,
	}
}

async function collectD1Tables(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	warnings: Array<string>
}) {
	const conditionsByTable = buildD1TableConditions({
		mcpUserId: input.mcpUserId,
		dbUserId: input.dbUserId,
	})
	const tables: Array<[string, AccountExportD1Table]> = []
	for (const [table, conditions] of conditionsByTable) {
		tables.push([
			table,
			await collectD1TableRows({
				env: input.env,
				table,
				conditions,
				mcpUserId: input.mcpUserId,
				warnings: input.warnings,
			}),
		])
	}
	return Object.fromEntries(
		tables.sort(([left], [right]) => left.localeCompare(right)),
	)
}

function parseRowidCursor(startAfter: string | undefined) {
	if (!startAfter) return 0
	const parsed = Number.parseInt(startAfter, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

async function readD1TableSectionPage(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	table: string
	pageSize: number | undefined
	startAfter: string | undefined
	warnings: Array<string>
}) {
	const conditions = buildD1TableConditions({
		mcpUserId: input.mcpUserId,
		dbUserId: input.dbUserId,
	}).get(input.table)
	if (!conditions) return null
	const pageSize = normalizePageSize(input.pageSize)
	try {
		const page = await selectD1TablePage({
			env: input.env,
			table: input.table,
			conditions,
			mcpUserId: input.mcpUserId,
			afterRowid: parseRowidCursor(input.startAfter),
			limit: pageSize,
		})
		return {
			items: page.rows.map((entry) => entry.row),
			truncated: page.truncated,
			nextStartAfter: page.truncated ? String(page.lastRowid) : null,
			pageSize,
		}
	} catch (error) {
		input.warnings.push(
			`D1 export failed for ${input.table}: ${getErrorMessage(error)}`,
		)
		return {
			items: [] as Array<Record<string, unknown>>,
			truncated: false,
			nextStartAfter: null,
			pageSize,
		}
	}
}

async function listOAuthGrants(input: {
	env: AccountExportEnv
	userId: string
	warnings: Array<string>
}) {
	const helpers = input.env.OAUTH_PROVIDER
	if (!helpers) {
		input.warnings.push(
			'OAuth provider binding was unavailable; OAuth grant metadata was not exported.',
		)
		return [] as Array<{ id: string; clientId: string }>
	}
	const grants: Array<{ id: string; clientId: string }> = []
	let cursor: string | undefined
	while (true) {
		let page: OAuthGrantPage
		try {
			page = await helpers.listUserGrants(input.userId, { cursor })
		} catch (error) {
			input.warnings.push(
				`OAuth grant listing failed after ${grants.length} grant(s): ${getErrorMessage(error)}`,
			)
			return grants
		}
		grants.push(...page.items.map((grant) => ({ ...grant })))
		if (!page.cursor) return grants
		cursor = page.cursor
	}
}

async function exportStorageRunners(input: {
	env: AccountExportEnv
	userId: string
	storageIds: ReadonlyArray<string>
	warnings: Array<string>
}) {
	const storageRunners: AccountExportDurableObjects['storageRunners'] = []
	for (const storageId of input.storageIds) {
		try {
			const runnerExport = await storageRunnerRpc({
				env: input.env,
				userId: input.userId,
				storageId,
			}).exportStorage({ pageSize: maxExportPageSize })
			storageRunners.push({ storageId, export: runnerExport })
			if (runnerExport.truncated) {
				input.warnings.push(
					`Storage runner ${storageId} was truncated in the full export; use account_export_section with section "storage_runner" and storage_id "${storageId}" to retrieve additional pages.`,
				)
			}
		} catch (error) {
			input.warnings.push(
				`Storage runner export failed for ${storageId}: ${getErrorMessage(error)}`,
			)
		}
	}
	return storageRunners
}

async function exportRemoteConnectorSessions(input: {
	env: AccountExportEnv
	userId: string
	connectors: ReadonlyArray<UserRemoteConnectorSnapshot>
	warnings: Array<string>
}) {
	const namespace = input.env.REMOTE_CONNECTOR_SESSION
	if (!namespace) {
		if (input.connectors.length > 0) {
			input.warnings.push(
				`REMOTE_CONNECTOR_SESSION binding was unavailable; ${input.connectors.length} connector session export(s) were skipped.`,
			)
		}
		return [] as AccountExportDurableObjects['remoteConnectorSessions']
	}
	const sessions: AccountExportDurableObjects['remoteConnectorSessions'] = []
	for (const connector of input.connectors) {
		const sessionKey = userScopedConnectorSessionKey({
			userId: input.userId,
			instanceId: connector.instanceId,
		})
		try {
			const stub = namespace.get(
				namespace.idFromName(sessionKey),
			) as unknown as {
				rpcExportUserSession: (payload: {
					userId: string
					instanceId: string
				}) => Promise<RemoteConnectorSessionExport>
			}
			sessions.push({
				instanceId: connector.instanceId,
				export: await stub.rpcExportUserSession({
					userId: input.userId,
					instanceId: connector.instanceId,
				}),
			})
		} catch (error) {
			input.warnings.push(
				`Remote connector session export failed for ${connector.instanceId}: ${getErrorMessage(error)}`,
			)
			sessions.push({
				instanceId: connector.instanceId,
				export: null,
			})
		}
	}
	return sessions
}

async function exportPackageServices(input: {
	env: AccountExportEnv
	userId: string
	services: ReadonlyArray<UserPackageServiceSnapshot>
	warnings: Array<string>
}) {
	const statuses: AccountExportDurableObjects['packageServices'] = []
	for (const service of input.services) {
		try {
			statuses.push({
				packageId: service.packageId,
				serviceName: service.serviceName,
				status: await packageServiceRpc({
					env: input.env,
					userId: input.userId,
					packageId: service.packageId,
					kodyId: service.kodyId,
					sourceId: service.sourceId,
					baseUrl: 'https://account-export.invalid',
					serviceName: service.serviceName,
				}).status(),
			})
		} catch (error) {
			input.warnings.push(
				`Package service status export failed for ${service.packageId}/${service.serviceName}: ${getErrorMessage(error)}`,
			)
			statuses.push({
				packageId: service.packageId,
				serviceName: service.serviceName,
				status: null,
			})
		}
	}
	return statuses
}

async function exportDurableObjects(input: {
	env: AccountExportEnv
	userId: string
	inventory: UserExportInventory
	warnings: Array<string>
}): Promise<AccountExportDurableObjects> {
	const [storageRunners, remoteConnectorSessions, packageServices] =
		await Promise.all([
			exportStorageRunners({
				env: input.env,
				userId: input.userId,
				storageIds: input.inventory.storageIds,
				warnings: input.warnings,
			}),
			exportRemoteConnectorSessions({
				env: input.env,
				userId: input.userId,
				connectors: input.inventory.remoteConnectors,
				warnings: input.warnings,
			}),
			exportPackageServices({
				env: input.env,
				userId: input.userId,
				services: input.inventory.packageServices,
				warnings: input.warnings,
			}),
		])
	let jobManager: unknown | null = null
	try {
		jobManager = await exportJobManagerForUser({
			env: input.env,
			userId: input.userId,
		})
	} catch (error) {
		input.warnings.push(`Job manager export failed: ${getErrorMessage(error)}`)
	}
	return {
		jobManager,
		remoteConnectorSessions,
		packageServices,
		storageRunners,
	}
}

function buildManifest(input: {
	generatedAt: string
	dbUserId: number
	mcpUserId: string
	d1: Record<string, AccountExportD1Table>
	durableObjects?: AccountExportDurableObjects | null
	oauthGrants?: ReadonlyArray<{ id: string; clientId: string }>
	inventory: UserExportInventory
	warnings: Array<string>
}) {
	const sections: Record<string, AccountExportManifestSection> = {}
	for (const [table, exportTable] of Object.entries(input.d1)) {
		sections[`d1.${table}`] = {
			count: exportTable.rows.length,
			warnings: exportTable.warnings,
			...(exportTable.redactedColumns.length > 0
				? { redactedColumns: exportTable.redactedColumns }
				: {}),
		}
	}
	sections.storage_runners = {
		count: input.inventory.storageIds.length,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Storage runner '),
		),
	}
	sections.remote_connector_sessions = {
		count: input.inventory.remoteConnectors.length,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Remote connector session '),
		),
	}
	sections.package_services = {
		count: input.inventory.packageServices.length,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Package service '),
		),
	}
	sections.oauth_grants = {
		count: input.oauthGrants?.length ?? 0,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('OAuth grant '),
		),
	}
	sections.artifact_repos = {
		count: input.inventory.artifactRepos.length,
		warnings: [],
	}
	sections.kv_keys = {
		count: input.inventory.bundleKvKeys.length,
		warnings: input.warnings.filter((warning) => warning.startsWith('KV ')),
	}
	return {
		schemaVersion: accountExportSchemaVersion,
		generatedAt: input.generatedAt,
		user: {
			dbUserId: input.dbUserId,
			userId: input.mcpUserId,
		},
		security: {
			secretValuesExported: false as const,
			note: 'Secret values, encrypted secret payloads, password hashes, token hashes, and credential-equivalent hashes are never exported. Secret entries contain metadata only.',
		},
		sections,
		warnings: input.warnings,
		chunking: {
			sections: [...accountExportSectionNames],
			defaultPageSize: defaultExportPageSize,
			maxPageSize: maxExportPageSize,
		},
		artifacts: {
			canonicalPackageSource:
				'Package/job source code is stored in Cloudflare Artifacts repos referenced by entity_sources.repo_id. This export lists repo pointers and published commits; fetch or clone those repos separately with Artifacts access rather than relying on D1 projections.',
		},
		derivedData: {
			vectorize:
				'Vectorize entries for memories, jobs, and packages are derived from exported D1 rows and are intentionally excluded; rebuild them by reindexing after import.',
		},
		excludedDurableObjects: getAccountExportExcludedDurableObjects(),
		excludedD1Surfaces: getAccountExportExcludedD1Surfaces(),
	} satisfies AccountExportManifest
}

export function getAccountExportD1UserColumnCoverage() {
	return getAccountD1UserColumnCoverage()
}

export async function resolveAccountExportDbUserId(input: {
	env: AccountExportEnv
	mcpUserId: string
	email?: string | null
}) {
	const email = input.email?.trim().toLowerCase()
	if (!email) {
		throw new Error('Account export requires an authenticated user email.')
	}
	const row = await input.env.APP_DB.prepare(
		`SELECT id, email, stable_user_id FROM users WHERE email = ?`,
	)
		.bind(email)
		.first<{ id: number; email: string; stable_user_id: string }>()
	if (!row) {
		throw new Error('Authenticated account was not found.')
	}
	if (resolveUserStableId(row) !== input.mcpUserId) {
		throw new Error(
			'Authenticated user identity did not match the account email.',
		)
	}
	return row.id
}

export async function createAccountExportManifest(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	generatedAt?: string
}): Promise<AccountExportManifest> {
	const warnings: Array<string> = []
	const generatedAt = input.generatedAt ?? new Date().toISOString()
	const [d1, inventory, oauthGrants] = await Promise.all([
		collectD1Tables({
			env: input.env,
			dbUserId: input.dbUserId,
			mcpUserId: input.mcpUserId,
			warnings,
		}),
		collectInventory({
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		}),
		listOAuthGrants({
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		}),
	])
	return buildManifest({
		generatedAt,
		dbUserId: input.dbUserId,
		mcpUserId: input.mcpUserId,
		d1,
		inventory,
		oauthGrants,
		warnings,
	})
}

export async function createAccountExport(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	generatedAt?: string
}): Promise<AccountExportFile> {
	const warnings: Array<string> = []
	const generatedAt = input.generatedAt ?? new Date().toISOString()
	const [d1, inventory, oauthGrants] = await Promise.all([
		collectD1Tables({
			env: input.env,
			dbUserId: input.dbUserId,
			mcpUserId: input.mcpUserId,
			warnings,
		}),
		collectInventory({
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		}),
		listOAuthGrants({
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		}),
	])
	const durableObjects = await exportDurableObjects({
		env: input.env,
		userId: input.mcpUserId,
		inventory,
		warnings,
	})
	return {
		manifest: buildManifest({
			generatedAt,
			dbUserId: input.dbUserId,
			mcpUserId: input.mcpUserId,
			d1,
			durableObjects,
			oauthGrants,
			inventory,
			warnings,
		}),
		d1,
		durableObjects,
		oauthGrants,
		artifactRepos: inventory.artifactRepos,
		kvKeys: inventory.bundleKvKeys,
	}
}

export async function readAccountExportSection(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	section: AccountExportSectionName
	table?: string
	storageId?: string
	pageSize?: number
	startAfter?: string
}): Promise<AccountExportSectionResult> {
	const warnings: Array<string> = []
	if (input.section === 'storage_runner') {
		if (!input.storageId) {
			throw new Error('storage_id is required when section is storage_runner.')
		}
		const pageSize = normalizePageSize(input.pageSize)
		const runnerExport = await storageRunnerRpc({
			env: input.env,
			userId: input.mcpUserId,
			storageId: input.storageId,
		}).exportStorage({
			pageSize,
			startAfter: input.startAfter,
		})
		return {
			section: input.section,
			items: runnerExport.entries,
			truncated: runnerExport.truncated,
			nextStartAfter: runnerExport.nextStartAfter,
			pageSize: runnerExport.pageSize,
			warnings,
		}
	}
	let items: Array<unknown>
	switch (input.section) {
		case 'd1_table': {
			if (!input.table) {
				throw new Error('table is required when section is d1_table.')
			}
			const page = await readD1TableSectionPage({
				env: input.env,
				dbUserId: input.dbUserId,
				mcpUserId: input.mcpUserId,
				table: input.table,
				pageSize: input.pageSize,
				startAfter: input.startAfter,
				warnings,
			})
			if (!page) {
				throw new Error(`Table "${input.table}" is not part of account export.`)
			}
			return {
				section: input.section,
				...page,
				warnings,
			}
		}
		case 'oauth_grants': {
			const oauthGrants = await listOAuthGrants({
				env: input.env,
				userId: input.mcpUserId,
				warnings,
			})
			items = [...oauthGrants]
			break
		}
		case 'artifact_repos': {
			const inventory = await collectInventory({
				env: input.env,
				userId: input.mcpUserId,
				warnings,
			})
			items = inventory.artifactRepos
			break
		}
		case 'kv_keys': {
			const inventory = await collectInventory({
				env: input.env,
				userId: input.mcpUserId,
				warnings,
			})
			items = inventory.bundleKvKeys
			break
		}
		case 'durable_object_summaries': {
			const inventory = await collectInventory({
				env: input.env,
				userId: input.mcpUserId,
				warnings,
			})
			items = [
				{ kind: 'storage_runner', ids: inventory.storageIds },
				{ kind: 'remote_connector_session', refs: inventory.remoteConnectors },
				{ kind: 'package_service', refs: inventory.packageServices },
				{ kind: 'job_manager', userId: input.mcpUserId },
			]
			break
		}
		default: {
			const exhaustive: never = input.section
			throw new Error(`Unhandled account export section: ${exhaustive}`)
		}
	}
	const page = paginateItems({
		items,
		pageSize: input.pageSize,
		startAfter: input.startAfter,
	})
	return {
		section: input.section,
		...page,
		warnings,
	}
}
