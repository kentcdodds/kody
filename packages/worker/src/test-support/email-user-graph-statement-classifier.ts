import { assertUserEmailGraphOwner } from '#worker/email/email-user-graph-authority.ts'

const sharedEmailGraphTables = [
	'email_threads',
	'email_messages',
	'email_attachments',
	'email_delivery_events',
] as const

const dedicatedSystemEmailGraphTables = [
	'system_email_threads',
	'system_email_messages',
	'system_email_attachments',
	'system_email_delivery_events',
] as const

export type EmailGraphD1StatementClassification = {
	sharedGraphWrites: Array<(typeof sharedEmailGraphTables)[number]>
	dedicatedSystemGraphWrites: Array<
		(typeof dedicatedSystemEmailGraphTables)[number]
	>
}

const mutationTargetPattern =
	/\b(?:insert(?:\s+or\s+\w+)?\s+into|replace(?:\s+or\s+\w+)?\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["`[]?([a-z_][a-z0-9_]*)/giu

function withoutSqlComments(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/--[^\r\n]*/gu, ' ')
}

/**
 * Test-only classifier for SQL captured from exercised live code paths.
 *
 * It identifies mutation targets, including a mutation after a WITH clause.
 * Reads and the global email_outbound_provider_index are intentionally not
 * graph writes. This helper has no production call site and is not a runtime
 * cutover guard.
 */
export function classifyEmailGraphD1Statement(
	sql: string,
): EmailGraphD1StatementClassification {
	const targets = new Set<string>()
	for (const match of withoutSqlComments(sql).matchAll(mutationTargetPattern)) {
		const target = match[1]?.toLowerCase()
		if (target != null) targets.add(target)
	}
	return {
		sharedGraphWrites: sharedEmailGraphTables.filter((table) =>
			targets.has(table),
		),
		dedicatedSystemGraphWrites: dedicatedSystemEmailGraphTables.filter(
			(table) => targets.has(table),
		),
	}
}

/**
 * Apply this to every D1 statement captured while exercising a USER live path
 * after cutover. It fails on either legacy shared-graph writes or accidental
 * writes into the dedicated system graph; non-graph D1 writes remain allowed.
 */
export function assertUserEmailGraphD1StatementsAllowedAfterCutover(input: {
	ownerId: string
	statements: ReadonlyArray<string>
}): void {
	assertUserEmailGraphOwner(input.ownerId)
	for (const sql of input.statements) {
		const classified = classifyEmailGraphD1Statement(sql)
		const forbidden = [
			...classified.sharedGraphWrites,
			...classified.dedicatedSystemGraphWrites,
		]
		if (forbidden.length > 0) {
			throw new Error(
				`Post-cutover USER email path attempted a D1 graph write to ${forbidden.join(', ')}.`,
			)
		}
	}
}
