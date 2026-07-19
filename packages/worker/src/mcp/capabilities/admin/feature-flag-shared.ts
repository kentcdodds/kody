import { z } from 'zod'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	featureFlagKeys,
	isFeatureFlagKey,
	type FeatureFlagKey,
} from '#worker/feature-flags/registry.ts'
import { findUserRowByStableUserId } from '#worker/user-id.ts'

export const adminFeatureFlagOverrideSchema = z.object({
	userId: z.number().int().positive(),
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
			updatedBy: z.number().int().positive().nullable(),
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
	const row = await findUserRowByStableUserId<{
		id: number
		email: string
		stable_user_id: string | null
	}>({
		db: ctx.env.APP_DB,
		stableUserId: user.userId,
		select: 'SELECT id, email, stable_user_id FROM users',
	})
	if (!row) {
		throw new Error('Authenticated admin account was not found.')
	}
	return row.id
}

export async function resolveTargetUserId(
	db: D1Database,
	input: { userId?: number; username?: string },
): Promise<number> {
	if (input.userId !== undefined && input.username !== undefined) {
		throw new Error('Provide either userId or username, not both.')
	}
	if (input.userId !== undefined) {
		const row = await db
			.prepare(`SELECT id FROM users WHERE id = ?`)
			.bind(input.userId)
			.first<{ id: number }>()
		if (!row) {
			throw new Error(`User not found for userId ${input.userId}.`)
		}
		return row.id
	}
	if (input.username !== undefined) {
		const username = input.username.trim()
		if (!username) {
			throw new Error('username must not be empty.')
		}
		const row = await db
			.prepare(`SELECT id FROM users WHERE username = ?`)
			.bind(username)
			.first<{ id: number }>()
		if (!row) {
			throw new Error(`User not found for username "${username}".`)
		}
		return row.id
	}
	throw new Error('Provide either userId or username.')
}
