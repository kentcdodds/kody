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
} from '#worker/account/data-targets.ts'
import { getAccountExportExcludedDurableObjects } from '#worker/account/user-owned-surfaces.ts'
import {
	countAccountR2ObjectRefs,
	readAccountR2ExportPage,
} from '#worker/account/r2-export.ts'
import { exportJobManagerForUser } from '#worker/jobs/manager-client.ts'
import { listPackageServices } from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
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
import {
	exportRunRecords,
	listRunRecordStorageIds,
	summarizeRunRecords,
} from '#worker/run-records/service.ts'
import { resolveUserStableId } from '#worker/user-id.ts'
import {
	listAccountUserPackageServices,
	listAccountUserStorageIds,
} from '#worker/account/user-inventory.ts'

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
	'job_manager',
	'run_records',
	'remote_connector_session',
	'package_service',
	'oauth_grants',
	'artifact_repos',
	'kv_keys',
	'r2_object',
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
	r2ObjectCount: number
	artifactRepos: Array<AccountExportArtifactRepo>
}

type ManifestInventoryCounts = {
	storageRunners: number
	runRecords: number
	remoteConnectorSessions: number
	packageServices: number
	artifactRepos: number
	kvKeys: number
	r2Objects: number
}

export type AccountExportManifestSection = {
	count: number
	warnings: Array<string>
	redactedColumns?: Array<string>
	discovery?: {
		section: AccountExportSectionName
		kind?: string
	}
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
		r2: string
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
	runRecords: Awaited<ReturnType<typeof exportRunRecords>> | null
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

async function listUserStorageIds(
	env: Env,
	userId: string,
	warnings?: Array<string>,
	packageServices?: ReadonlyArray<UserPackageServiceSnapshot>,
) {
	return await listAccountUserStorageIds({
		env,
		userId,
		baseUrl: 'https://account-export.invalid',
		warnings,
		packageServices,
	})
}

/** D1 entity/registry storage ids used by discovery paging (no manifests). */
const exportStorageIdBaseSql = `SELECT id FROM (
	SELECT storage_id AS id FROM jobs
		WHERE user_id = ? AND storage_id IS NOT NULL
	UNION SELECT storage_id FROM archived_job_artifacts
		WHERE user_id = ? AND storage_id IS NOT NULL
	UNION SELECT storage_id FROM user_storage_buckets
		WHERE user_id = ?
)`

function exportStorageIdBaseParams(userId: string) {
	return [userId, userId, userId] as const
}

function tryDecodeURIComponent(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return null
	}
}

function parseServiceStorageId(storageId: string) {
	if (!storageId.startsWith('service:')) return null
	const [packagePart, servicePart] = storageId
		.slice('service:'.length)
		.split(':')
	if (!packagePart || !servicePart) return null
	const packageId = tryDecodeURIComponent(packagePart)
	const serviceName = tryDecodeURIComponent(servicePart)
	if (packageId == null || serviceName == null) return null
	if (!packageId || !serviceName) return null
	return { packageId, serviceName }
}

async function listExportD1DiscoverableStorageIds(env: Env, userId: string) {
	const [baseRows, serviceRows] = await Promise.all([
		env.APP_DB.prepare(exportStorageIdBaseSql)
			.bind(...exportStorageIdBaseParams(userId))
			.all<{ id: string }>(),
		env.APP_DB.prepare(
			`SELECT package_id, service_name AS name
			FROM package_service_states
			WHERE user_id = ?`,
		)
			.bind(userId)
			.all<{ package_id: string; name: string }>(),
	])
	const ids = new Set((baseRows.results ?? []).map((row) => row.id))
	for (const row of serviceRows.results ?? []) {
		ids.add(buildPackageServiceStorageId(row.package_id, row.name))
	}
	return ids
}

async function isExportDiscoverableStorageId(
	env: Env,
	userId: string,
	storageId: string,
) {
	const inBase = await env.APP_DB.prepare(
		`SELECT 1 AS owned FROM (${exportStorageIdBaseSql}) WHERE id = ?`,
	)
		.bind(...exportStorageIdBaseParams(userId), storageId)
		.first<{ owned: number }>()
	if (inBase?.owned === 1) return true
	const parsed = parseServiceStorageId(storageId)
	if (parsed) {
		const row = await env.APP_DB.prepare(
			`SELECT 1 AS owned
			FROM package_service_states
			WHERE user_id = ? AND package_id = ? AND service_name = ?`,
		)
			.bind(userId, parsed.packageId, parsed.serviceName)
			.first<{ owned: number }>()
		if (row?.owned === 1) return true
	}
	const runRecordStorageIds = await listRunRecordStorageIds({ env, userId })
	return runRecordStorageIds.includes(storageId)
}

async function resolveExportPackageService(input: {
	env: Env
	userId: string
	packageId: string
	serviceName: string
	warnings: Array<string>
}) {
	const stateRow = await input.env.APP_DB.prepare(
		`SELECT
			s.package_id AS package_id,
			p.kody_id AS kody_id,
			p.source_id AS source_id,
			s.service_name AS name
		FROM package_service_states AS s
		LEFT JOIN saved_packages AS p
			ON p.id = s.package_id AND p.user_id = s.user_id
		WHERE s.user_id = ?
			AND s.package_id = ?
			AND s.service_name = ?`,
	)
		.bind(input.userId, input.packageId, input.serviceName)
		.first<{
			package_id: string
			kody_id: string | null
			source_id: string | null
			name: string
		}>()
	if (stateRow) {
		return {
			packageId: stateRow.package_id,
			kodyId: stateRow.kody_id ?? '',
			sourceId: stateRow.source_id ?? '',
			serviceName: stateRow.name,
		}
	}

	const savedPackage = await input.env.APP_DB.prepare(
		`SELECT id, kody_id, source_id
		FROM saved_packages
		WHERE user_id = ? AND id = ?`,
	)
		.bind(input.userId, input.packageId)
		.first<{ id: string; kody_id: string; source_id: string }>()
	if (!savedPackage) return null
	try {
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: 'https://account-export.invalid',
			userId: input.userId,
			sourceId: savedPackage.source_id,
		})
		const declared = listPackageServices(loaded.manifest).some(
			(service) => service.name === input.serviceName,
		)
		if (!declared) return null
		return {
			packageId: savedPackage.id,
			kodyId: savedPackage.kody_id,
			sourceId: savedPackage.source_id,
			serviceName: input.serviceName,
		}
	} catch (error) {
		input.warnings.push(
			`Failed to load package manifest for service export (${input.packageId}/${input.serviceName}): ${getErrorMessage(error)}`,
		)
		return null
	}
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

async function listUserPackageServices(
	env: Env,
	userId: string,
	warnings?: Array<string>,
) {
	return await listAccountUserPackageServices({
		env,
		userId,
		baseUrl: 'https://account-export.invalid',
		warnings,
	})
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

async function listUserCommunityListingIds(env: Env, userId: string) {
	const rows = await selectRows<{ id: string }>(
		env,
		`SELECT id FROM community_listings WHERE owner_user_id = ?`,
		[userId],
	)
	return uniqueStrings(rows.map((row) => row.id))
}

async function collectInventory(input: {
	env: AccountExportEnv
	userId: string
	dbUserId: number
	warnings: Array<string>
}): Promise<UserExportInventory> {
	// Enumerate services first so storage-id listing can reuse the result and
	// avoid a second package-manifest pass in the same request.
	const packageServices = await listUserPackageServices(
		input.env,
		input.userId,
		input.warnings,
	).catch((error) => {
		input.warnings.push(
			`Failed to enumerate package services: ${getErrorMessage(error)}`,
		)
		return [] as Array<UserPackageServiceSnapshot>
	})
	const [
		storageIds,
		sourceSnapshots,
		savedPackages,
		remoteConnectors,
		communityListingIds,
		r2ObjectCount,
	] = await Promise.all([
		listUserStorageIds(
			input.env,
			input.userId,
			input.warnings,
			packageServices,
		).catch((error) => {
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
		listUserCommunityListingIds(input.env, input.userId).catch((error) => {
			input.warnings.push(
				`Failed to enumerate community listings: ${getErrorMessage(error)}`,
			)
			return [] as Array<string>
		}),
		countAccountR2ObjectRefs({
			env: input.env,
			userId: input.userId,
			dbUserId: input.dbUserId,
		}).catch((error) => {
			input.warnings.push(
				`Failed to count R2 objects: ${getErrorMessage(error)}`,
			)
			return 0
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
		r2ObjectCount,
		artifactRepos,
	}
}

async function countScalar(
	env: Env,
	sql: string,
	params: ReadonlyArray<unknown>,
) {
	const row = await env.APP_DB.prepare(sql)
		.bind(...params)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

async function countUserStorageIds(env: Env, userId: string) {
	// Match durable_object_summaries discovery: D1 base + package_service_states
	// + RunLog storage ids (one RunLog RPC, not per-package manifests).
	const [d1Ids, runRecordStorageIds] = await Promise.all([
		listExportD1DiscoverableStorageIds(env, userId),
		listRunRecordStorageIds({ env, userId }),
	])
	const ids = new Set(d1Ids)
	for (const storageId of runRecordStorageIds) {
		ids.add(storageId)
	}
	return ids.size
}

async function countUserBundleKvKeys(input: {
	env: AccountExportEnv
	userId: string
	warnings: Array<string>
}) {
	const deterministic = await countScalar(
		input.env,
		`SELECT COUNT(*) AS count FROM (
			SELECT kv_key AS key FROM published_bundle_artifacts WHERE user_id = ?
			UNION
			SELECT 'source-snapshot:v1:' || id || ':' || published_commit
				FROM entity_sources
				WHERE user_id = ? AND published_commit IS NOT NULL
			UNION
			SELECT 'source-manifest-snapshot:v1:' || id || ':' || published_commit
				FROM entity_sources
				WHERE user_id = ? AND published_commit IS NOT NULL
			UNION
			SELECT 'community-snapshot:v1:' || id
				FROM community_listings WHERE owner_user_id = ?
		)`,
		[input.userId, input.userId, input.userId, input.userId],
	)
	if (!input.env.BUNDLE_ARTIFACTS_KV?.list) return deterministic
	let additional = 0
	let afterId = ''
	for (;;) {
		const page = await input.env.APP_DB.prepare(
			`SELECT id, published_commit
			FROM entity_sources
			WHERE user_id = ? AND id > ?
			ORDER BY id
			LIMIT 100`,
		)
			.bind(input.userId, afterId)
			.all<{ id: string; published_commit: string | null }>()
		const rows = page.results ?? []
		if (rows.length === 0) break
		for (const source of rows) {
			for (const prefix of [
				`source-snapshot:v1:${source.id}:`,
				`source-manifest-snapshot:v1:${source.id}:`,
			]) {
				const canonical = source.published_commit
					? `${prefix}${source.published_commit}`
					: null
				let cursor: string | undefined
				do {
					try {
						const listed = await input.env.BUNDLE_ARTIFACTS_KV.list({
							prefix,
							cursor,
						})
						additional += listed.keys.filter(
							(key) => key.name !== canonical,
						).length
						cursor = listed.list_complete ? undefined : listed.cursor
					} catch (error) {
						input.warnings.push(
							`KV prefix listing failed for ${prefix}: ${getErrorMessage(error)}`,
						)
						cursor = undefined
					}
				} while (cursor)
			}
		}
		afterId = rows.at(-1)!.id
		if (rows.length < 100) break
	}
	return deterministic + additional
}

async function collectManifestInventoryCounts(input: {
	env: AccountExportEnv
	userId: string
	dbUserId: number
	warnings: Array<string>
}): Promise<ManifestInventoryCounts> {
	const safeCount = async (label: string, run: () => Promise<number>) => {
		try {
			return await run()
		} catch (error) {
			input.warnings.push(`Failed to count ${label}: ${getErrorMessage(error)}`)
			return 0
		}
	}
	const [
		storageRunners,
		runRecords,
		remoteConnectorSessions,
		packageServices,
		artifactRepos,
		kvKeys,
		r2Objects,
	] = await Promise.all([
		safeCount('storage ids', async () =>
			countUserStorageIds(input.env, input.userId),
		),
		safeCount('run records', async () => {
			const summary = await summarizeRunRecords({
				env: input.env,
				userId: input.userId,
			})
			return summary.total
		}),
		safeCount('remote connectors', async () =>
			countScalar(
				input.env,
				`SELECT COUNT(*) AS count FROM remote_connector_settings WHERE user_id = ?`,
				[input.userId],
			),
		),
		safeCount('package services', async () =>
			countScalar(
				input.env,
				`SELECT COUNT(*) AS count FROM (
					SELECT DISTINCT package_id, service_name
					FROM package_service_states
					WHERE user_id = ?
				)`,
				[input.userId],
			),
		),
		safeCount('artifact repos', async () =>
			countScalar(
				input.env,
				`SELECT COUNT(*) AS count FROM entity_sources WHERE user_id = ?`,
				[input.userId],
			),
		),
		safeCount('bundle KV keys', async () => countUserBundleKvKeys(input)),
		safeCount('R2 objects', async () =>
			countAccountR2ObjectRefs({
				env: input.env,
				userId: input.userId,
				dbUserId: input.dbUserId,
			}),
		),
	])
	return {
		storageRunners,
		runRecords,
		remoteConnectorSessions,
		packageServices,
		artifactRepos,
		kvKeys,
		r2Objects,
	}
}

async function countOAuthGrants(input: {
	env: AccountExportEnv
	userId: string
	warnings: Array<string>
}) {
	const helpers = input.env.OAUTH_PROVIDER
	if (!helpers) {
		input.warnings.push(
			'OAuth provider binding was unavailable; OAuth grant metadata was not exported.',
		)
		return 0
	}
	let count = 0
	let cursor: string | undefined
	for (;;) {
		try {
			const page = await helpers.listUserGrants(input.userId, { cursor })
			count += page.items.length
			if (!page.cursor) return count
			cursor = page.cursor
		} catch (error) {
			input.warnings.push(
				`OAuth grant listing failed after ${count} grant(s): ${getErrorMessage(error)}`,
			)
			return count
		}
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

async function collectD1TableCounts(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	warnings: Array<string>
}) {
	const conditionsByTable = buildD1TableConditions({
		mcpUserId: input.mcpUserId,
		dbUserId: input.dbUserId,
	})
	const sections: Array<[string, AccountExportManifestSection]> = []
	for (const [table, conditions] of conditionsByTable) {
		const where = conditions
			.map((condition) => `(${condition.condition})`)
			.join(' OR ')
		try {
			const row = await input.env.APP_DB.prepare(
				`SELECT COUNT(*) AS count FROM ${table} WHERE (${where})`,
			)
				.bind(...conditions.flatMap((condition) => condition.params))
				.first<{ count: number }>()
			const count = Number(row?.count ?? 0)
			const redactedColumns = [
				...(accountExportRedactedColumnsByTable[table] ?? []),
			].sort()
			sections.push([
				`d1.${table}`,
				{
					count,
					warnings: [],
					...(count > 0 && redactedColumns.length > 0
						? { redactedColumns }
						: {}),
				},
			])
		} catch (error) {
			const warning = `D1 export failed for ${table}: ${getErrorMessage(error)}`
			input.warnings.push(warning)
			sections.push([`d1.${table}`, { count: 0, warnings: [warning] }])
		}
	}
	return Object.fromEntries(
		sections.sort(([left], [right]) => left.localeCompare(right)),
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

async function exportUserRunRecords(input: {
	env: AccountExportEnv
	userId: string
	warnings: Array<string>
}) {
	try {
		const runRecords = await exportRunRecords({
			env: input.env,
			userId: input.userId,
			pageSize: maxExportPageSize,
		})
		if (runRecords.truncated) {
			input.warnings.push(
				`Run records were truncated in the full export; use account_export_section with section "run_records" to retrieve additional pages.`,
			)
		}
		return runRecords
	} catch (error) {
		input.warnings.push(`Run records export failed: ${getErrorMessage(error)}`)
		return null
	}
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
	const [storageRunners, remoteConnectorSessions, packageServices, runRecords] =
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
			exportUserRunRecords({
				env: input.env,
				userId: input.userId,
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
		runRecords,
		remoteConnectorSessions,
		packageServices,
		storageRunners,
	}
}

function buildManifest(input: {
	generatedAt: string
	dbUserId: number
	mcpUserId: string
	d1?: Record<string, AccountExportD1Table>
	d1Sections?: Record<string, AccountExportManifestSection>
	durableObjects?: AccountExportDurableObjects | null
	oauthGrants?: ReadonlyArray<{ id: string; clientId: string }>
	oauthGrantCount?: number
	inventory?: UserExportInventory
	inventoryCounts?: ManifestInventoryCounts
	warnings: Array<string>
}) {
	const sections: Record<string, AccountExportManifestSection> = {
		...input.d1Sections,
	}
	for (const [table, exportTable] of Object.entries(input.d1 ?? {})) {
		sections[`d1.${table}`] = {
			count: exportTable.rows.length,
			warnings: exportTable.warnings,
			...(exportTable.redactedColumns.length > 0
				? { redactedColumns: exportTable.redactedColumns }
				: {}),
		}
	}
	sections.storage_runners = {
		count:
			input.inventoryCounts?.storageRunners ??
			input.inventory?.storageIds.length ??
			0,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Storage runner '),
		),
		discovery: {
			section: 'durable_object_summaries',
			kind: 'storage_runner',
		},
	}
	sections.job_manager = {
		count: 1,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Job manager '),
		),
		discovery: { section: 'job_manager' },
	}
	sections.run_records = {
		// The section carries runs plus the RunLog DO's package-invocation
		// idempotency ledger rows, so count both when the export payload is
		// present. The inventory fallback comes from `summarize` (runs only).
		count:
			input.durableObjects?.runRecords == null
				? (input.inventoryCounts?.runRecords ?? 0)
				: input.durableObjects.runRecords.runs.length +
					input.durableObjects.runRecords.packageInvocations.length,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Run records '),
		),
		discovery: { section: 'run_records' },
	}
	sections.remote_connector_sessions = {
		count:
			input.inventoryCounts?.remoteConnectorSessions ??
			input.inventory?.remoteConnectors.length ??
			0,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Remote connector session '),
		),
		discovery: {
			section: 'durable_object_summaries',
			kind: 'remote_connector_session',
		},
	}
	sections.package_services = {
		count:
			input.inventoryCounts?.packageServices ??
			input.inventory?.packageServices.length ??
			0,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('Package service '),
		),
		discovery: {
			section: 'durable_object_summaries',
			kind: 'package_service',
		},
	}
	sections.oauth_grants = {
		count: input.oauthGrantCount ?? input.oauthGrants?.length ?? 0,
		warnings: input.warnings.filter((warning) =>
			warning.startsWith('OAuth grant '),
		),
	}
	sections.artifact_repos = {
		count:
			input.inventoryCounts?.artifactRepos ??
			input.inventory?.artifactRepos.length ??
			0,
		warnings: [],
	}
	sections.kv_keys = {
		count:
			input.inventoryCounts?.kvKeys ??
			input.inventory?.bundleKvKeys.length ??
			0,
		warnings: input.warnings.filter((warning) => warning.startsWith('KV ')),
	}
	sections.r2_object = {
		count:
			input.inventoryCounts?.r2Objects ?? input.inventory?.r2ObjectCount ?? 0,
		warnings: input.warnings.filter((warning) => warning.includes('R2 object')),
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
			r2: 'R2 raw MIME, attachment, avatar, and icon bytes are exported through the r2_object section in bounded 256 KiB base64 chunks. Missing objects are returned explicitly instead of being silently omitted.',
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
	const [d1Sections, inventoryCounts, oauthGrantCount] = await Promise.all([
		collectD1TableCounts({
			env: input.env,
			dbUserId: input.dbUserId,
			mcpUserId: input.mcpUserId,
			warnings,
		}),
		collectManifestInventoryCounts({
			env: input.env,
			userId: input.mcpUserId,
			dbUserId: input.dbUserId,
			warnings,
		}),
		countOAuthGrants({
			env: input.env,
			userId: input.mcpUserId,
			warnings,
		}),
	])
	return buildManifest({
		generatedAt,
		dbUserId: input.dbUserId,
		mcpUserId: input.mcpUserId,
		d1Sections,
		inventoryCounts,
		oauthGrantCount,
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
			dbUserId: input.dbUserId,
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

async function readR2ObjectSection(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	startAfter: string | undefined
	warnings: Array<string>
}): Promise<AccountExportSectionResult> {
	const page = await readAccountR2ExportPage({
		env: input.env,
		userId: input.mcpUserId,
		dbUserId: input.dbUserId,
		startAfter: input.startAfter,
		warnings: input.warnings,
	})
	return {
		section: 'r2_object',
		...page,
		pageSize: 1,
		warnings: input.warnings,
	}
}

export async function readAccountExportSection(input: {
	env: AccountExportEnv
	dbUserId: number
	mcpUserId: string
	section: AccountExportSectionName
	table?: string
	storageId?: string
	instanceId?: string
	packageId?: string
	serviceName?: string
	kind?:
		| 'storage_runner'
		| 'remote_connector_session'
		| 'package_service'
		| 'job_manager'
	pageSize?: number
	startAfter?: string
}): Promise<AccountExportSectionResult> {
	const warnings: Array<string> = []
	if (input.section === 'r2_object') {
		return await readR2ObjectSection({
			env: input.env,
			dbUserId: input.dbUserId,
			mcpUserId: input.mcpUserId,
			startAfter: input.startAfter,
			warnings,
		})
	}
	if (input.section === 'storage_runner') {
		if (!input.storageId) {
			throw new Error('storage_id is required when section is storage_runner.')
		}
		const storageOwned = await isExportDiscoverableStorageId(
			input.env,
			input.mcpUserId,
			input.storageId,
		)
		if (!storageOwned) {
			throw new Error('Storage runner was not found for account export.')
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
	if (input.section === 'job_manager') {
		return {
			section: input.section,
			items: [
				await exportJobManagerForUser({
					env: input.env,
					userId: input.mcpUserId,
				}),
			],
			truncated: false,
			nextStartAfter: null,
			pageSize: 1,
			warnings,
		}
	}
	if (input.section === 'run_records') {
		const pageSize = normalizePageSize(input.pageSize)
		const page = await exportRunRecords({
			env: input.env,
			userId: input.mcpUserId,
			pageSize,
			startAfter: input.startAfter,
		})
		return {
			section: input.section,
			// Runs page first; once runs are exhausted the same cursor continues
			// through the keyed package-invocation idempotency ledger rows that
			// live in the same per-user RunLog Durable Object.
			items: [
				...page.runs.map((run) => ({
					run,
					logs: page.logs.filter((log) => log.runId === run.id),
				})),
				...page.packageInvocations.map((packageInvocation) => ({
					packageInvocation,
				})),
			],
			truncated: page.truncated,
			nextStartAfter: page.nextStartAfter,
			pageSize,
			warnings,
		}
	}
	if (input.section === 'remote_connector_session') {
		if (!input.instanceId) {
			throw new Error(
				'instance_id is required when section is remote_connector_session.',
			)
		}
		const owned = await input.env.APP_DB.prepare(
			`SELECT 1 AS owned FROM remote_connector_settings
			WHERE user_id = ? AND instance_id = ?`,
		)
			.bind(input.mcpUserId, input.instanceId)
			.first<{ owned: number }>()
		if (owned?.owned !== 1) {
			throw new Error('Remote connector session was not found for export.')
		}
		const namespace = input.env.REMOTE_CONNECTOR_SESSION
		if (!namespace) {
			throw new Error('REMOTE_CONNECTOR_SESSION binding was unavailable.')
		}
		const sessionKey = userScopedConnectorSessionKey({
			userId: input.mcpUserId,
			instanceId: input.instanceId,
		})
		const stub = namespace.get(namespace.idFromName(sessionKey)) as unknown as {
			rpcExportUserSessionPage: (payload: {
				userId: string
				instanceId: string
				pageSize: number
				startAfter?: string
			}) => Promise<{
				persisted: unknown
				tools: Array<unknown>
				connected: boolean
				truncated: boolean
				nextStartAfter: string | null
				pageSize: number
			}>
		}
		const exported = await stub.rpcExportUserSessionPage({
			userId: input.mcpUserId,
			instanceId: input.instanceId,
			pageSize: normalizePageSize(input.pageSize),
			startAfter: input.startAfter,
		})
		return {
			section: input.section,
			items: [
				{
					instanceId: input.instanceId,
					persisted: exported.persisted,
					tools: exported.tools,
					connected: exported.connected,
				},
			],
			truncated: exported.truncated,
			nextStartAfter: exported.nextStartAfter,
			pageSize: exported.pageSize,
			warnings,
		}
	}
	if (input.section === 'package_service') {
		if (!input.packageId || !input.serviceName) {
			throw new Error(
				'package_id and service_name are required when section is package_service.',
			)
		}
		const service = await resolveExportPackageService({
			env: input.env,
			userId: input.mcpUserId,
			packageId: input.packageId,
			serviceName: input.serviceName,
			warnings,
		})
		if (!service) throw new Error('Package service was not found for export.')
		const [exported] = await exportPackageServices({
			env: input.env,
			userId: input.mcpUserId,
			services: [service],
			warnings,
		})
		return {
			section: input.section,
			items: exported ? [exported] : [],
			truncated: false,
			nextStartAfter: null,
			pageSize: 1,
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
				dbUserId: input.dbUserId,
				warnings,
			})
			items = inventory.artifactRepos
			break
		}
		case 'kv_keys': {
			const inventory = await collectInventory({
				env: input.env,
				userId: input.mcpUserId,
				dbUserId: input.dbUserId,
				warnings,
			})
			items = inventory.bundleKvKeys
			break
		}
		case 'durable_object_summaries': {
			if (!input.kind) {
				throw new Error(
					'kind is required when section is durable_object_summaries.',
				)
			}
			const pageSize = normalizePageSize(input.pageSize)
			const cursor = input.startAfter
				? (JSON.parse(input.startAfter) as Record<string, unknown>)
				: {}
			if (input.kind === 'job_manager') {
				return {
					section: input.section,
					items: cursor['done']
						? []
						: [{ kind: 'job_manager', userId: input.mcpUserId }],
					truncated: false,
					nextStartAfter: null,
					pageSize: 1,
					warnings,
				}
			}
			if (input.kind === 'remote_connector_session') {
				const afterRowid = Number(cursor['afterRowid'] ?? 0)
				const rows = await input.env.APP_DB.prepare(
					`SELECT rowid AS cursor, instance_id
					FROM remote_connector_settings
					WHERE user_id = ? AND rowid > ?
					ORDER BY rowid LIMIT ?`,
				)
					.bind(input.mcpUserId, afterRowid, pageSize + 1)
					.all<{ cursor: number; instance_id: string }>()
				const pageRows = rows.results ?? []
				const truncated = pageRows.length > pageSize
				const selected = truncated ? pageRows.slice(0, pageSize) : pageRows
				return {
					section: input.section,
					items: selected.map((row) => ({
						kind: input.kind,
						instanceId: row.instance_id,
					})),
					truncated,
					nextStartAfter: truncated
						? JSON.stringify({ afterRowid: selected.at(-1)!.cursor })
						: null,
					pageSize,
					warnings,
				}
			}
			if (input.kind === 'package_service') {
				// Discovery pages are D1-only keyset SQL so each page stays cheap
				// and bounded. Manifest-declared services (never projected into
				// package_service_states) are included by the one-shot
				// listAccountUserPackageServices path used for full export
				// inventory and account deletion — not here.
				const afterPackageId = String(cursor['packageId'] ?? '')
				const afterName = String(cursor['name'] ?? '')
				const rows = await input.env.APP_DB.prepare(
					`SELECT package_id, service_name AS name
					FROM package_service_states
					WHERE user_id = ?
						AND (package_id > ? OR (package_id = ? AND service_name > ?))
					ORDER BY package_id, service_name
					LIMIT ?`,
				)
					.bind(
						input.mcpUserId,
						afterPackageId,
						afterPackageId,
						afterName,
						pageSize + 1,
					)
					.all<{ package_id: string; name: string }>()
				const pageRows = rows.results ?? []
				const truncated = pageRows.length > pageSize
				const selected = truncated ? pageRows.slice(0, pageSize) : pageRows
				return {
					section: input.section,
					items: selected.map((row) => ({
						kind: input.kind,
						packageId: row.package_id,
						serviceName: row.name,
					})),
					truncated,
					nextStartAfter: truncated
						? JSON.stringify({
								packageId: selected.at(-1)!.package_id,
								name: selected.at(-1)!.name,
							})
						: null,
					pageSize,
					warnings,
				}
			}
			// Discovery pages: D1 keyset SQL (user_storage_buckets + entity
			// tables + package_service_states) then RunLog-only ids. Do not call
			// listAccountUserStorageIds / listAccountUserPackageServices here —
			// those helpers fetch package manifests and are for one-shot full
			// export inventory and account deletion completeness. RunLog is one
			// Durable Object RPC per request, not per package.
			const stage = String(cursor['stage'] ?? 'base')
			if (stage === 'base') {
				const afterId = String(cursor['afterId'] ?? '')
				const rows = await input.env.APP_DB.prepare(
					`${exportStorageIdBaseSql} WHERE id > ? ORDER BY id LIMIT ?`,
				)
					.bind(
						input.mcpUserId,
						input.mcpUserId,
						input.mcpUserId,
						afterId,
						pageSize + 1,
					)
					.all<{ id: string }>()
				const pageRows = rows.results ?? []
				const truncated = pageRows.length > pageSize
				const selected = truncated ? pageRows.slice(0, pageSize) : pageRows
				return {
					section: input.section,
					items: selected.map((row) => ({
						kind: input.kind,
						storageId: row.id,
					})),
					truncated: true,
					nextStartAfter: JSON.stringify(
						truncated
							? { stage: 'base', afterId: selected.at(-1)!.id }
							: { stage: 'service', packageId: '', name: '' },
					),
					pageSize,
					warnings,
				}
			}
			if (stage === 'service') {
				const afterPackageId = String(cursor['packageId'] ?? '')
				const afterName = String(cursor['name'] ?? '')
				const rows = await input.env.APP_DB.prepare(
					`SELECT package_id, service_name AS name
					FROM package_service_states
					WHERE user_id = ?
						AND (package_id > ? OR (package_id = ? AND service_name > ?))
					ORDER BY package_id, service_name
					LIMIT ?`,
				)
					.bind(
						input.mcpUserId,
						afterPackageId,
						afterPackageId,
						afterName,
						pageSize + 1,
					)
					.all<{ package_id: string; name: string }>()
				const pageRows = rows.results ?? []
				const selected = pageRows.slice(0, pageSize)
				const resultItems: Array<{ kind: string; storageId: string }> = []
				const candidateIds = selected.map((row) =>
					buildPackageServiceStorageId(row.package_id, row.name),
				)
				const alreadyInBase = new Set<string>()
				if (candidateIds.length > 0) {
					const placeholders = candidateIds.map(() => '?').join(', ')
					const existing = await input.env.APP_DB.prepare(
						`SELECT id FROM (${exportStorageIdBaseSql}) WHERE id IN (${placeholders})`,
					)
						.bind(
							...exportStorageIdBaseParams(input.mcpUserId),
							...candidateIds,
						)
						.all<{ id: string }>()
					for (const row of existing.results ?? []) {
						alreadyInBase.add(row.id)
					}
				}
				for (const storageId of candidateIds) {
					if (!alreadyInBase.has(storageId)) {
						resultItems.push({ kind: input.kind, storageId })
					}
				}
				const truncated = pageRows.length > pageSize
				return {
					section: input.section,
					items: resultItems,
					truncated: true,
					nextStartAfter: JSON.stringify(
						truncated
							? {
									stage: 'service',
									packageId: selected.at(-1)!.package_id,
									name: selected.at(-1)!.name,
								}
							: { stage: 'runlog', afterId: '' },
					),
					pageSize,
					warnings,
				}
			}
			if (stage === 'runlog') {
				const afterId = String(cursor['afterId'] ?? '')
				const [d1Ids, runRecordStorageIds] = await Promise.all([
					listExportD1DiscoverableStorageIds(input.env, input.mcpUserId),
					listRunRecordStorageIds({
						env: input.env,
						userId: input.mcpUserId,
					}),
				])
				const exclusive = runRecordStorageIds
					.filter((storageId) => !d1Ids.has(storageId))
					.sort((left, right) => left.localeCompare(right))
				const pageRows = exclusive.filter((storageId) => storageId > afterId)
				const truncated = pageRows.length > pageSize
				const selected = truncated ? pageRows.slice(0, pageSize) : pageRows
				return {
					section: input.section,
					items: selected.map((storageId) => ({
						kind: input.kind,
						storageId,
					})),
					truncated,
					nextStartAfter: truncated
						? JSON.stringify({
								stage: 'runlog',
								afterId: selected.at(-1)!,
							})
						: null,
					pageSize,
					warnings,
				}
			}
			throw new Error(
				`Unknown durable_object_summaries storage_runner stage: ${stage}`,
			)
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
