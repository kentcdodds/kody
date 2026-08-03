import { systemEmailOwnerId } from './email-owner.ts'
import {
	assertSystemEmailGraphAuthority,
	systemEmailAuthorityGuardStatement,
} from './system-email-authority.ts'
import {
	systemEmailGraphColumnContracts,
	type SystemEmailGraphColumnContract,
	type SystemEmailGraphTableKey,
} from './system-email-graph-columns.ts'
import {
	buildLegacySystemEmailGraphDeleteDriftSql,
	buildLegacySystemEmailGraphUpsertSql,
	systemEmailGraphLegacyCte,
	systemEmailGraphLegacyCtes,
	systemEmailGraphSourceCte,
} from './system-email-graph-sql.ts'
import { systemEmailDedicatedReferenceGuardStatement } from './system-email-graph-transaction.ts'
import {
	loadOutboundProviderIndexParityReport,
	type OutboundProviderIndexParityReport,
} from './outbound-provider-index.ts'

export type SystemEmailGraphTableParity = {
	legacyCount: number
	dedicatedCount: number
	missingFromDedicatedCount: number
	missingFromLegacyCount: number
	ownershipMismatchCount: number
	referencedOwnerMismatchCount: number
	relationshipMismatchCount: number
	keyFieldMismatchCount: number
	parity: boolean
}

export type SystemEmailOutboundProviderParity = {
	legacyProviderLinkedMessageCount: number
	dedicatedProviderLinkedMessageCount: number
	legacyAuthorityIndexCount: number
	missingFromLegacyAuthorityIndexCount: number
	missingFromLegacyMessagesCount: number
	mismatchedLegacyAuthorityIndexCount: number
	classification:
		| 'no-system-provider-links'
		| 'unsupported-system-provider-links'
	authorityDisposition: 'dedicated-inbound-only'
	parity: boolean
}

export type SystemEmailGraphParityReport = {
	threads: SystemEmailGraphTableParity
	messages: SystemEmailGraphTableParity
	attachments: SystemEmailGraphTableParity
	deliveryEvents: SystemEmailGraphTableParity
	outboundProviderIndex: SystemEmailOutboundProviderParity
	parity: boolean
}

export type SystemEmailGraphMutationCounts = {
	threads: number
	messages: number
	attachments: number
	deliveryEvents: number
}

export type SystemEmailGraphReconcileMetrics = {
	upserted: SystemEmailGraphMutationCounts
	deleted: SystemEmailGraphMutationCounts
	referencedOwnerMismatchCount: number
}

export type SystemEmailGraphReconcileResult = {
	metrics: SystemEmailGraphReconcileMetrics
	postReport: SystemEmailGraphParityReport
}

type TablePrefix = 'thread' | 'message' | 'attachment' | 'event'
type ParityRow = Record<string, number | null>

const prefixByKey: Readonly<Record<SystemEmailGraphTableKey, TablePrefix>> = {
	threads: 'thread',
	messages: 'message',
	attachments: 'attachment',
	deliveryEvents: 'event',
}

function comparedColumns(
	contract: SystemEmailGraphColumnContract,
	relationship: boolean,
): ReadonlyArray<string> {
	const relationships = new Set(contract.relationshipColumns)
	return contract.columns.filter(
		(column) => column !== 'id' && relationships.has(column) === relationship,
	)
}

function mismatchExpression(
	contract: SystemEmailGraphColumnContract,
	relationship: boolean,
): string {
	const comparisons = comparedColumns(contract, relationship).map(
		(column) => `legacy.${column} IS NOT dedicated.${column}`,
	)
	return comparisons.length === 0 ? '0' : comparisons.join('\n\t\t\t\tOR ')
}

function ownershipJoin(contract: SystemEmailGraphColumnContract): {
	sql: string
	expression: string
} {
	if (contract.key === 'attachments') {
		return {
			sql: `LEFT JOIN email_attachments foreign_row
				ON foreign_row.id = dedicated.id
			LEFT JOIN email_messages foreign_owner
				ON foreign_owner.id = foreign_row.message_id
				AND foreign_owner.user_id != ?1`,
			expression: 'foreign_owner.id IS NOT NULL',
		}
	}
	return {
		sql: `LEFT JOIN ${contract.legacyTable} foreign_owner
			ON foreign_owner.id = dedicated.id
			AND foreign_owner.user_id != ?1`,
		expression: 'foreign_owner.id IS NOT NULL',
	}
}

function tableParityCtes(contract: SystemEmailGraphColumnContract): string {
	const prefix = prefixByKey[contract.key]
	const legacyCte = systemEmailGraphLegacyCte(contract.key)
	const validCte = systemEmailGraphSourceCte(contract.key)
	const owner = ownershipJoin(contract)
	return `
${prefix}_ids AS (
	SELECT id FROM ${legacyCte}
	UNION
	SELECT id FROM ${contract.dedicatedTable}
),
${prefix}_compare AS (
	SELECT
		ids.id,
		legacy.id IS NOT NULL AS has_legacy,
		dedicated.id IS NOT NULL AS has_dedicated,
		${owner.expression} AS ownership_mismatch,
		legacy.id IS NOT NULL AND valid.id IS NULL AS referenced_owner_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (${mismatchExpression(contract, true)})
			AS relationship_mismatch,
		legacy.id IS NOT NULL
			AND dedicated.id IS NOT NULL
			AND (${mismatchExpression(contract, false)})
			AS key_mismatch
	FROM ${prefix}_ids ids
	LEFT JOIN ${legacyCte} legacy ON legacy.id = ids.id
	LEFT JOIN ${validCte} valid ON valid.id = ids.id
	LEFT JOIN ${contract.dedicatedTable} dedicated ON dedicated.id = ids.id
	${owner.sql}
),
${prefix}_stats AS (
	SELECT
		(SELECT COUNT(*) FROM ${legacyCte}) AS legacy_count,
		(SELECT COUNT(*) FROM ${contract.dedicatedTable}) AS dedicated_count,
		COALESCE(SUM(has_legacy AND NOT has_dedicated), 0) AS missing_dedicated,
		COALESCE(SUM(has_dedicated AND NOT has_legacy), 0) AS missing_legacy,
		COALESCE(SUM(ownership_mismatch), 0) AS ownership_mismatch,
		COALESCE(SUM(referenced_owner_mismatch), 0)
			AS referenced_owner_mismatch,
		COALESCE(SUM(relationship_mismatch), 0) AS relationship_mismatch,
		COALESCE(SUM(key_mismatch), 0) AS key_mismatch
	FROM ${prefix}_compare
)`
}

function tableParitySelect(contract: SystemEmailGraphColumnContract): string {
	const prefix = prefixByKey[contract.key]
	return `${prefix}_stats.legacy_count AS ${prefix}LegacyCount,
	${prefix}_stats.dedicated_count AS ${prefix}DedicatedCount,
	${prefix}_stats.missing_dedicated AS ${prefix}MissingDedicated,
	${prefix}_stats.missing_legacy AS ${prefix}MissingLegacy,
	${prefix}_stats.ownership_mismatch AS ${prefix}OwnershipMismatch,
	${prefix}_stats.referenced_owner_mismatch AS ${prefix}ReferencedOwnerMismatch,
	${prefix}_stats.relationship_mismatch AS ${prefix}RelationshipMismatch,
	${prefix}_stats.key_mismatch AS ${prefix}KeyMismatch`
}

const graphParitySql = `WITH
${systemEmailGraphLegacyCtes},
${systemEmailGraphColumnContracts.map(tableParityCtes).join(',\n')}
SELECT
	${systemEmailGraphColumnContracts.map(tableParitySelect).join(',\n\t')},
	(
		SELECT COUNT(*)
		FROM system_email_messages
		WHERE direction = 'outbound' AND provider_message_id IS NOT NULL
	) AS providerDedicatedCount
FROM thread_stats, message_stats, attachment_stats, event_stats`

function count(row: ParityRow, name: string): number {
	return Number(row[name] ?? 0) || 0
}

function tableParity(
	row: ParityRow,
	prefix: TablePrefix,
): SystemEmailGraphTableParity {
	const result = {
		legacyCount: count(row, `${prefix}LegacyCount`),
		dedicatedCount: count(row, `${prefix}DedicatedCount`),
		missingFromDedicatedCount: count(row, `${prefix}MissingDedicated`),
		missingFromLegacyCount: count(row, `${prefix}MissingLegacy`),
		ownershipMismatchCount: count(row, `${prefix}OwnershipMismatch`),
		referencedOwnerMismatchCount: count(
			row,
			`${prefix}ReferencedOwnerMismatch`,
		),
		relationshipMismatchCount: count(row, `${prefix}RelationshipMismatch`),
		keyFieldMismatchCount: count(row, `${prefix}KeyMismatch`),
	}
	return {
		...result,
		parity:
			result.legacyCount === result.dedicatedCount &&
			result.missingFromDedicatedCount === 0 &&
			result.missingFromLegacyCount === 0 &&
			result.ownershipMismatchCount === 0 &&
			result.referencedOwnerMismatchCount === 0 &&
			result.relationshipMismatchCount === 0 &&
			result.keyFieldMismatchCount === 0,
	}
}

function systemProviderParity(
	report: OutboundProviderIndexParityReport,
	dedicatedProviderLinkedMessageCount: number,
): SystemEmailOutboundProviderParity {
	const providerParity =
		report.linkedMessageCount === 0 &&
		report.indexCount === 0 &&
		dedicatedProviderLinkedMessageCount === 0 &&
		report.parity
	const classification = providerParity
		? ('no-system-provider-links' as const)
		: ('unsupported-system-provider-links' as const)
	return {
		legacyProviderLinkedMessageCount: report.linkedMessageCount,
		dedicatedProviderLinkedMessageCount,
		legacyAuthorityIndexCount: report.indexCount,
		missingFromLegacyAuthorityIndexCount: report.missingFromIndexCount,
		missingFromLegacyMessagesCount: report.missingFromMessagesCount,
		mismatchedLegacyAuthorityIndexCount: report.mismatchedCount,
		classification,
		authorityDisposition: 'dedicated-inbound-only',
		parity: providerParity,
	}
}

/**
 * Aggregate-only 4a copy-parity report. The SQL compares every column in the
 * exported graph contract but returns counts only: no ids or email content.
 * This full comparator runs only when an explicit admin maintenance action
 * requests status (including the post-status of reconcile/retention actions).
 */
export async function loadSystemEmailGraphParityReport(input: {
	db: D1Database
	authorityAlreadyAsserted?: boolean
}): Promise<SystemEmailGraphParityReport> {
	if (!input.authorityAlreadyAsserted) {
		await assertSystemEmailGraphAuthority(input.db)
	}
	const [row, providerReport] = await Promise.all([
		input.db
			.prepare(graphParitySql)
			.bind(systemEmailOwnerId)
			.first<ParityRow>(),
		loadOutboundProviderIndexParityReport({
			db: input.db,
			userId: systemEmailOwnerId,
		}),
	])
	const counts = row ?? {}
	const threads = tableParity(counts, 'thread')
	const messages = tableParity(counts, 'message')
	const attachments = tableParity(counts, 'attachment')
	const deliveryEvents = tableParity(counts, 'event')
	const outboundProviderIndex = systemProviderParity(
		providerReport,
		count(counts, 'providerDedicatedCount'),
	)
	return {
		threads,
		messages,
		attachments,
		deliveryEvents,
		outboundProviderIndex,
		parity:
			threads.parity &&
			messages.parity &&
			attachments.parity &&
			deliveryEvents.parity &&
			outboundProviderIndex.parity,
	}
}

function mutationCounts(
	results: ReadonlyArray<D1Result<unknown>>,
	offset: number,
): SystemEmailGraphMutationCounts {
	return {
		threads: Number(results[offset]?.meta.changes ?? 0),
		messages: Number(results[offset + 1]?.meta.changes ?? 0),
		attachments: Number(results[offset + 2]?.meta.changes ?? 0),
		deliveryEvents: Number(results[offset + 3]?.meta.changes ?? 0),
	}
}

function deletedMutationCounts(
	results: ReadonlyArray<D1Result<unknown>>,
	offset = 0,
): SystemEmailGraphMutationCounts {
	return {
		threads: Number(results[offset + 3]?.meta.changes ?? 0),
		messages: Number(results[offset + 2]?.meta.changes ?? 0),
		attachments: Number(results[offset + 1]?.meta.changes ?? 0),
		deliveryEvents: Number(results[offset]?.meta.changes ?? 0),
	}
}

function referencedOwnerMismatchCount(
	report: SystemEmailGraphParityReport,
): number {
	return (
		report.threads.referencedOwnerMismatchCount +
		report.messages.referencedOwnerMismatchCount +
		report.attachments.referencedOwnerMismatchCount +
		report.deliveryEvents.referencedOwnerMismatchCount
	)
}

/**
 * Rollback repair only. Atomically restores the legacy compatibility mirror
 * from the dedicated authority. The literal direction and force fields make it
 * impossible for an old 4a caller to overwrite dedicated rows from stale
 * legacy state after cutover.
 */
export async function reconcileLegacySystemEmailGraphFromDedicated(input: {
	db: D1Database
	direction: 'dedicated_to_legacy'
	force: true
}): Promise<SystemEmailGraphReconcileResult> {
	await assertSystemEmailGraphAuthority(input.db)
	const childFirst = [...systemEmailGraphColumnContracts].reverse()
	const statements = [
		systemEmailDedicatedReferenceGuardStatement(input.db),
		...childFirst.map((contract) =>
			input.db
				.prepare(buildLegacySystemEmailGraphDeleteDriftSql(contract))
				.bind(systemEmailOwnerId),
		),
		...systemEmailGraphColumnContracts.map((contract) =>
			input.db
				.prepare(buildLegacySystemEmailGraphUpsertSql(contract))
				.bind(systemEmailOwnerId),
		),
		systemEmailAuthorityGuardStatement(input.db),
	]
	const results = await input.db.batch<unknown>(statements)
	const postReport = await loadSystemEmailGraphParityReport({
		db: input.db,
		authorityAlreadyAsserted: true,
	})
	return {
		metrics: {
			deleted: deletedMutationCounts(results, 1),
			upserted: mutationCounts(results, 5),
			referencedOwnerMismatchCount: referencedOwnerMismatchCount(postReport),
		},
		postReport,
	}
}
