import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	featureFlagKeys,
	isFeatureFlagKey,
	type FeatureFlagKey,
} from '#worker/feature-flags/registry.ts'
import { isStableUserId, normalizeStableUserId } from '#worker/user-id.ts'
import { stableUserIdSchema } from './admin-shared.ts'

export const adminFeatureFlagOverrideSchema = z.object({
	stableUserId: stableUserIdSchema,
	username: z.string(),
	enabled: z.boolean(),
	updatedAt: z.string(),
})

export const adminFeatureFlagSchema = z.object({
	key: z.string(),
	description: z.string().nullable(),
	defaultEnabled: z.boolean().nullable(),
	stale: z.boolean(),
	global: z
		.object({
			enabled: z.boolean(),
			rolloutPercent: z.number().int().min(0).max(100).nullable(),
			note: z.string(),
			updatedByStableUserId: stableUserIdSchema.nullable(),
			updatedAt: z.string(),
		})
		.nullable(),
	overrides: z.array(adminFeatureFlagOverrideSchema),
})

export function assertFeatureFlagKey(key: string): FeatureFlagKey {
	if (!isFeatureFlagKey(key)) {
		throw new Error(
			`Unknown feature flag key "${key}". Valid keys: ${featureFlagKeys.join(', ')}.`,
		)
	}
	return key
}

export async function resolveActingAdminUserId(
	ctx: CapabilityContext,
): Promise<number> {
	const user = requireMcpUser(ctx.callerContext)
	const stableUserId = normalizeStableUserId(user.userId)
	if (!stableUserId) {
		throw new Error('Authenticated admin account was not found.')
	}
	const row = await ctx.env.APP_DB.prepare(
		`SELECT id FROM users WHERE stable_user_id = ?`,
	)
		.bind(stableUserId)
		.first<{ id: number }>()
	if (!row) {
		throw new Error('Authenticated admin account was not found.')
	}
	return row.id
}

export async function resolveTargetUser(
	db: D1Database,
	input: { stableUserId?: string; username?: string },
): Promise<{ dbUserId: number; stableUserId: string }> {
	if (input.stableUserId !== undefined && input.username !== undefined) {
		throw new Error('Provide either stableUserId or username, not both.')
	}
	if (input.stableUserId !== undefined) {
		const stableUserId = normalizeStableUserId(input.stableUserId)
		if (!isStableUserId(stableUserId)) {
			throw new Error('stableUserId must be a valid stable user id.')
		}
		const row = await db
			.prepare(`SELECT id, stable_user_id FROM users WHERE stable_user_id = ?`)
			.bind(stableUserId)
			.first<{ id: number; stable_user_id: string }>()
		if (!row) {
			throw new Error(`User not found for stableUserId ${stableUserId}.`)
		}
		return { dbUserId: row.id, stableUserId: row.stable_user_id }
	}
	if (input.username !== undefined) {
		const username = input.username.trim().toLowerCase()
		if (!username) {
			throw new Error('username must not be empty.')
		}
		const row = await db
			.prepare(`SELECT id, stable_user_id FROM users WHERE username = ?`)
			.bind(username)
			.first<{ id: number; stable_user_id: string }>()
		if (!row) {
			throw new Error(`User not found for username "${username}".`)
		}
		return { dbUserId: row.id, stableUserId: row.stable_user_id }
	}
	throw new Error('Provide either stableUserId or username.')
}
