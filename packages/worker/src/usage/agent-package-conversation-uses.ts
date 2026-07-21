import { toHex } from '@kody-internal/shared/hex.ts'

/**
 * Agent-facing package popularity for MCP server instructions.
 *
 * Tracks distinct (user, package, conversation) uses from MCP `execute`
 * package paths. Ranking uses unique conversation counts among the user's
 * most recent agent conversations — not a fixed calendar window, and not raw
 * invoke spam. Writes are best-effort and never throw into the invoke path
 * (same spirit as `recordUsage`).
 *
 * Stored `conversation_id` values are SHA-256 hex digests of the MCP
 * conversation id (not the raw id), so the table only needs cardinality, not
 * reversible conversation identifiers.
 *
 * See `docs/contributing/architecture/usage-metering.md`.
 */

/** How many recent distinct agent conversations to consider for ranking. */
export const agentPackagePopularityConversationLimit = 40
/** Hard outer bound so abandoned packages do not linger forever. */
export const agentPackagePopularityMaxAgeDays = 180
export const agentPackagePopularityTopLimit = 8

export type AgentPackageConversationUseEnv = {
	APP_DB?: D1Database
}

export type PopularAgentPackageSummary = {
	packageId: string
	kodyId: string
	description: string
	conversationCount: number
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
 * deps). Dedupes package ids; never throws.
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
	const seen = new Set<string>()
	for (const packageId of input.packageIds) {
		const trimmed = packageId.trim()
		if (!trimmed || seen.has(trimmed)) continue
		seen.add(trimmed)
		await recordAgentPackageConversationUse(env, {
			userId: input.userId,
			packageId: trimmed,
			conversationId: input.conversationId,
			usedAt: input.usedAt,
		})
	}
}

/**
 * Rank packages by how many of the user's last N agent conversations used
 * them. Skips packages the user no longer has. Conversations older than the
 * max-age bound are ignored even if they would otherwise fall in the last N.
 */
export async function listPopularAgentPackagesForUser(
	db: D1Database,
	input: {
		userId: string
		limit?: number
		conversationLimit?: number
		maxAgeDays?: number
		now?: Date
	},
): Promise<Array<PopularAgentPackageSummary>> {
	try {
		const userId = input.userId.trim()
		if (!userId) return []
		const limit = input.limit ?? agentPackagePopularityTopLimit
		const conversationLimit =
			input.conversationLimit ?? agentPackagePopularityConversationLimit
		const maxAgeDays = input.maxAgeDays ?? agentPackagePopularityMaxAgeDays
		const now = input.now ?? new Date()
		const since = new Date(
			now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000,
		).toISOString()

		const rows = await db
			.prepare(
				`
WITH recent_conversations AS (
	SELECT
		conversation_id,
		MAX(last_used_at) AS conversation_last_used_at
	FROM agent_package_conversation_uses
	WHERE user_id = ?1
		AND last_used_at >= ?2
	GROUP BY conversation_id
	ORDER BY conversation_last_used_at DESC
	LIMIT ?3
)
SELECT
	u.package_id AS package_id,
	p.kody_id AS kody_id,
	p.description AS description,
	COUNT(*) AS conversation_count
FROM agent_package_conversation_uses u
INNER JOIN recent_conversations rc
	ON rc.conversation_id = u.conversation_id
INNER JOIN saved_packages p
	ON p.id = u.package_id AND p.user_id = u.user_id
WHERE u.user_id = ?1
GROUP BY u.package_id, p.kody_id, p.description
ORDER BY conversation_count DESC, p.kody_id ASC
LIMIT ?4
				`.trim(),
			)
			.bind(userId, since, conversationLimit, limit)
			.all<{
				package_id: string
				kody_id: string
				description: string
				conversation_count: number
			}>()

		return (rows.results ?? []).map((row) => ({
			packageId: row.package_id,
			kodyId: row.kody_id,
			description: row.description ?? '',
			conversationCount: Number(row.conversation_count) || 0,
		}))
	} catch (error) {
		// MCP init must stay up during migration rollout / transient D1 errors.
		console.warn('agent-package-conversation-use-list-failed', error)
		return []
	}
}
