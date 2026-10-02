import { toHex } from '@kody-internal/shared/hex.ts'

/**
 * Agent-facing package conversation uses from MCP `execute` package paths.
 *
 * Tracks distinct (user, package, conversation) uses. Writes are best-effort
 * and never throw into the invoke path (same spirit as `recordUsage`).
 *
 * Stored `conversation_id` values are SHA-256 hex digests of the MCP
 * conversation id (not the raw id), so the table only needs cardinality, not
 * reversible conversation identifiers.
 *
 * See `docs/contributing/architecture/usage-metering.md`.
 */

/** Hard outer bound so abandoned package-use rows do not linger forever. */
export const agentPackagePopularityMaxAgeDays = 180

export type AgentPackageConversationUseEnv = {
	APP_DB?: D1Database
}

const upsertStatement = `
INSERT INTO agent_package_conversation_uses (
	user_id, package_id, conversation_id, first_used_at, last_used_at
) VALUES (?1, ?2, ?3, ?4, ?4)
ON CONFLICT (user_id, package_id, conversation_id) DO UPDATE SET
	last_used_at = excluded.last_used_at
`.trim()

async function hashConversationId(conversationId: string): Promise<string> {
	const data = new TextEncoder().encode(conversationId)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(digest))
}

/**
 * Upsert one conversation-scoped agent package use. Idempotent for the same
 * (userId, packageId, conversationId). Never throws.
 */
export async function recordAgentPackageConversationUse(
	env: AgentPackageConversationUseEnv,
	input: {
		userId: string
		packageId: string
		conversationId: string
		usedAt?: string
	},
): Promise<void> {
	try {
		const userId = input.userId.trim()
		const packageId = input.packageId.trim()
		const conversationId = input.conversationId.trim()
		if (!userId || !packageId || !conversationId) {
			return
		}
		const db = env.APP_DB
		if (!db) {
			console.debug('agent-package-conversation-use-skipped', 'missing APP_DB')
			return
		}
		const usedAt = input.usedAt ?? new Date().toISOString()
		const conversationKey = await hashConversationId(conversationId)
		await db
			.prepare(upsertStatement)
			.bind(userId, packageId, conversationKey, usedAt)
			.run()
	} catch (error) {
		console.warn('agent-package-conversation-use-record-failed', error)
	}
}

/**
 * Record conversation uses for many packages (e.g. static/dynamic execute
 * deps). Dedupes package ids; never throws. Issues one D1 batch of upserts.
 */
export async function recordAgentPackageConversationUses(
	env: AgentPackageConversationUseEnv,
	input: {
		userId: string
		packageIds: ReadonlyArray<string>
		conversationId: string
		usedAt?: string
	},
): Promise<void> {
	try {
		const userId = input.userId.trim()
		const conversationId = input.conversationId.trim()
		if (!userId || !conversationId) return
		const db = env.APP_DB
		if (!db) {
			console.debug('agent-package-conversation-use-skipped', 'missing APP_DB')
			return
		}
		const seen = new Set<string>()
		const packageIds: Array<string> = []
		for (const packageId of input.packageIds) {
			const trimmed = packageId.trim()
			if (!trimmed || seen.has(trimmed)) continue
			seen.add(trimmed)
			packageIds.push(trimmed)
		}
		if (packageIds.length === 0) return
		const usedAt = input.usedAt ?? new Date().toISOString()
		const conversationKey = await hashConversationId(conversationId)
		await db.batch(
			packageIds.map((packageId) =>
				db
					.prepare(upsertStatement)
					.bind(userId, packageId, conversationKey, usedAt),
			),
		)
	} catch (error) {
		console.warn('agent-package-conversation-use-record-failed', error)
	}
}
