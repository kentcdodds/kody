import {
	approvalItemKey,
	parseApprovalItemKey,
	type ApprovalItemRef,
} from '#universal/approval-bundles.ts'

export type ApprovalBundleRecord = {
	id: string
	orgId: string
	personUserId: string
	agentCredentialKind: string | null
	agentCredentialId: string | null
	note: string | null
	items: Array<ApprovalItemRef>
	createdAt: string
}

export type ApprovalBundleDecisionRecord = {
	itemKey: string
	decision: 'approved' | 'denied'
	decidedByUserId: string
	decidedAt: string
}

function readItems(value: unknown): Array<ApprovalItemRef> {
	if (typeof value !== 'string') return []
	try {
		const parsed: unknown = JSON.parse(value)
		if (!Array.isArray(parsed)) return []
		return parsed.flatMap((entry) => {
			const ref = typeof entry === 'string' ? parseApprovalItemKey(entry) : null
			return ref ? [ref] : []
		})
	} catch {
		return []
	}
}

function mapBundleRow(row: Record<string, unknown>): ApprovalBundleRecord {
	const text = (key: string) => (row[key] == null ? null : String(row[key]))
	return {
		id: String(row['id']),
		orgId: String(row['org_id']),
		personUserId: String(row['person_user_id']),
		agentCredentialKind: text('agent_credential_kind'),
		agentCredentialId: text('agent_credential_id'),
		note: text('note'),
		items: readItems(row['items_json']),
		createdAt: String(row['created_at']),
	}
}

export async function insertApprovalBundle(
	db: D1Database,
	input: Omit<ApprovalBundleRecord, 'id' | 'createdAt'> & {
		id?: string
		createdAt?: string
	},
): Promise<ApprovalBundleRecord> {
	const record: ApprovalBundleRecord = {
		...input,
		id: input.id ?? crypto.randomUUID(),
		createdAt: input.createdAt ?? new Date().toISOString(),
	}
	await db
		.prepare(
			`INSERT INTO approval_bundles (
				id, org_id, person_user_id, agent_credential_kind,
				agent_credential_id, note, items_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			record.id,
			record.orgId,
			record.personUserId,
			record.agentCredentialKind,
			record.agentCredentialId,
			record.note,
			JSON.stringify(record.items.map(approvalItemKey)),
			record.createdAt,
		)
		.run()
	return record
}

/** The bundle when it belongs to this person in this org; null otherwise. */
export async function getApprovalBundleForPerson(
	db: D1Database,
	input: { id: string; orgId: string; personUserId: string },
): Promise<ApprovalBundleRecord | null> {
	const row = await db
		.prepare(
			`SELECT id, org_id, person_user_id, agent_credential_kind,
				agent_credential_id, note, items_json, created_at
			FROM approval_bundles
			WHERE id = ? AND org_id = ? AND person_user_id = ?
			LIMIT 1`,
		)
		.bind(input.id, input.orgId, input.personUserId)
		.first<Record<string, unknown>>()
	return row ? mapBundleRow(row) : null
}

export async function listApprovalBundleDecisions(
	db: D1Database,
	bundleId: string,
): Promise<Map<string, ApprovalBundleDecisionRecord>> {
	const { results } = await db
		.prepare(
			`SELECT item_key, decision, decided_by_user_id, decided_at
			FROM approval_bundle_decisions WHERE bundle_id = ?`,
		)
		.bind(bundleId)
		.all<Record<string, unknown>>()
	return new Map(
		(results ?? []).map((row) => [
			String(row['item_key']),
			{
				itemKey: String(row['item_key']),
				decision: row['decision'] === 'denied' ? 'denied' : 'approved',
				decidedByUserId: String(row['decided_by_user_id']),
				decidedAt: String(row['decided_at']),
			},
		]),
	)
}

/** Records one decision; the first decision for an item stands. */
export function approvalBundleDecisionStatement(
	db: D1Database,
	input: {
		bundleId: string
		itemKey: string
		decision: 'approved' | 'denied'
		decidedByUserId: string
		decidedAt?: string
	},
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO approval_bundle_decisions (
				bundle_id, item_key, decision, decided_by_user_id, decided_at
			) VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(
			input.bundleId,
			input.itemKey,
			input.decision,
			input.decidedByUserId,
			input.decidedAt ?? new Date().toISOString(),
		)
}

/** A member leaving an org takes the bundles made for them there. */
export async function deleteApprovalBundlesForMember(input: {
	db: D1Database
	orgId: string
	personId: string
}) {
	const result = await input.db
		.prepare(
			`DELETE FROM approval_bundles WHERE org_id = ? AND person_user_id = ?`,
		)
		.bind(input.orgId, input.personId)
		.run()
	return result.meta?.changes ?? 0
}
