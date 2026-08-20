/**
 * Best-effort Kody Discord guild-role sync.
 *
 * Social login stores the Discord snowflake on `oauth_connections` and then
 * discards the user token. During that same callback the ephemeral token
 * (scope `guilds.join`) is used once to add the member, then thrown away.
 * Guild role writes use an operator bot token, so they stay off the login
 * token path and skip entirely when bot config is unset (local, preview,
 * tests).
 *
 * The member role is assigned whenever Discord is connected. Standard and Pro
 * roles follow `users.stripe_plan` (the paid subscription), not the effective
 * manual+Stripe plan. Max is manual-only and has no Discord role.
 */

import { parseStripePlanName, type PlanName } from '#universal/plans.ts'

export const DISCORD_MEMBER_ROLE_REQUEST_TIMEOUT_MS = 8_000

export const discordPlanRoles = ['standard', 'pro'] as const

export type DiscordPlanRole = (typeof discordPlanRoles)[number]

export type DiscordGuildRoleEnv = {
	DISCORD_BOT_TOKEN?: string | undefined
	DISCORD_GUILD_ID?: string | undefined
	DISCORD_MEMBER_ROLE_ID?: string | undefined
	DISCORD_STANDARD_ROLE_ID?: string | undefined
	DISCORD_PRO_ROLE_ID?: string | undefined
}

export type DiscordMemberRoleEnv = DiscordGuildRoleEnv

export type DiscordMemberRoleSkipReason = 'not-configured' | 'invalid-user-id'

export type DiscordGuildJoinSkipReason =
	| 'not-configured'
	| 'invalid-user-id'
	| 'missing-access-token'

export type DiscordGuildJoinResult =
	| { status: 'skipped'; reason: DiscordGuildJoinSkipReason }
	| { status: 'joined' }
	| { status: 'already-member' }
	| { status: 'forbidden' }
	| { status: 'error'; message: string }

export type DiscordMemberRoleSyncResult =
	| { status: 'skipped'; reason: DiscordMemberRoleSkipReason }
	| { status: 'assigned' }
	| { status: 'removed' }
	| { status: 'not-in-guild' }
	| { status: 'forbidden' }
	| { status: 'error'; message: string }

export type DiscordGuildRoleSyncSummary = {
	member: DiscordMemberRoleSyncResult
	plan: DiscordMemberRoleSyncResult
}

const discordApiBaseUrl = 'https://discord.com/api/v10'
const discordSnowflakePattern = /^\d{5,20}$/

function readTrimmedEnv(
	env: DiscordGuildRoleEnv,
	key: keyof DiscordGuildRoleEnv,
) {
	const trimmed = env[key]?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

function readRoleId(env: DiscordGuildRoleEnv, key: keyof DiscordGuildRoleEnv) {
	const value = readTrimmedEnv(env, key)
	if (!value || !isDiscordSnowflake(value)) return null
	return value
}

export function isDiscordSnowflake(value: string) {
	return discordSnowflakePattern.test(value)
}

export function getDiscordGuildBotConfig(env: DiscordGuildRoleEnv) {
	const botToken = readTrimmedEnv(env, 'DISCORD_BOT_TOKEN')
	const guildId = readTrimmedEnv(env, 'DISCORD_GUILD_ID')
	if (!botToken || !guildId || !isDiscordSnowflake(guildId)) return null
	return {
		botToken,
		guildId,
		memberRoleId: readRoleId(env, 'DISCORD_MEMBER_ROLE_ID'),
		standardRoleId: readRoleId(env, 'DISCORD_STANDARD_ROLE_ID'),
		proRoleId: readRoleId(env, 'DISCORD_PRO_ROLE_ID'),
	}
}

export function getDiscordMemberRoleConfig(env: DiscordMemberRoleEnv) {
	const config = getDiscordGuildBotConfig(env)
	if (!config?.memberRoleId) return null
	return {
		botToken: config.botToken,
		guildId: config.guildId,
		roleId: config.memberRoleId,
	}
}

export function isDiscordMemberRoleSyncConfigured(env: DiscordMemberRoleEnv) {
	return getDiscordMemberRoleConfig(env) !== null
}

export function isDiscordPlanRoleSyncConfigured(env: DiscordGuildRoleEnv) {
	const config = getDiscordGuildBotConfig(env)
	return config?.standardRoleId != null || config?.proRoleId != null
}

export function isDiscordGuildRoleSyncConfigured(env: DiscordGuildRoleEnv) {
	return (
		isDiscordMemberRoleSyncConfigured(env) ||
		isDiscordPlanRoleSyncConfigured(env)
	)
}

function planRoleId(
	config: NonNullable<ReturnType<typeof getDiscordGuildBotConfig>>,
	plan: DiscordPlanRole,
) {
	switch (plan) {
		case 'standard':
			return config.standardRoleId
		case 'pro':
			return config.proRoleId
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown Discord plan role: ${String(exhaustive)}`)
		}
	}
}

function desiredDiscordPlanRole(
	stripePlan: PlanName | null | undefined,
): DiscordPlanRole | null {
	return stripePlan === 'standard' || stripePlan === 'pro' ? stripePlan : null
}

function memberRoleUrl(guildId: string, discordUserId: string, roleId: string) {
	return `${discordApiBaseUrl}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`
}

function guildMemberUrl(guildId: string, discordUserId: string) {
	return `${discordApiBaseUrl}/guilds/${guildId}/members/${discordUserId}`
}

/**
 * Add the Discord user to the official guild with the operator bot plus the
 * ephemeral `guilds.join` access token from social login. The token is never
 * stored. Failures are logged and never thrown.
 */
export async function maybeJoinOfficialDiscordGuild(input: {
	env: DiscordGuildRoleEnv
	discordUserId: string
	accessToken: string | null | undefined
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordGuildJoinResult> {
	const accessToken = input.accessToken?.trim()
	if (!accessToken) {
		return { status: 'skipped', reason: 'missing-access-token' }
	}
	if (!isDiscordSnowflake(input.discordUserId)) {
		return { status: 'skipped', reason: 'invalid-user-id' }
	}
	const config = getDiscordGuildBotConfig(input.env)
	if (!config) {
		return { status: 'skipped', reason: 'not-configured' }
	}

	const fetchImpl = input.fetchImpl ?? fetch
	const timeoutMs = input.timeoutMs ?? DISCORD_MEMBER_ROLE_REQUEST_TIMEOUT_MS
	try {
		const response = await fetchImpl(
			guildMemberUrl(config.guildId, input.discordUserId),
			{
				method: 'PUT',
				headers: {
					Authorization: `Bot ${config.botToken}`,
					'Content-Type': 'application/json',
					'User-Agent': 'kody',
				},
				body: JSON.stringify({ access_token: accessToken }),
				signal: AbortSignal.timeout(timeoutMs),
			},
		)
		if (response.status === 201) {
			return { status: 'joined' }
		}
		if (response.ok || response.status === 204) {
			return { status: 'already-member' }
		}
		if (response.status === 403) {
			console.warn(
				'Failed to join official Kody Discord: bot is forbidden (needs Create Instant Invite).',
			)
			return { status: 'forbidden' }
		}
		const message = `Discord guild join failed (${response.status}).`
		console.warn(message)
		return { status: 'error', message }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.warn('Failed to join official Kody Discord:', message)
		return { status: 'error', message }
	}
}

function rollupDiscordRoleResults(
	results: Array<DiscordMemberRoleSyncResult>,
): DiscordMemberRoleSyncResult {
	if (results.length === 0) {
		return { status: 'skipped', reason: 'not-configured' }
	}
	const error = results.find((result) => result.status === 'error')
	if (error) return error
	if (results.some((result) => result.status === 'forbidden')) {
		return { status: 'forbidden' }
	}
	if (
		results.some(
			(result) => result.status === 'assigned' || result.status === 'removed',
		)
	) {
		return { status: 'assigned' }
	}
	if (results.some((result) => result.status === 'not-in-guild')) {
		return { status: 'not-in-guild' }
	}
	const skipped = results.find((result) => result.status === 'skipped')
	return skipped ?? { status: 'skipped', reason: 'not-configured' }
}

async function callDiscordMemberRoleApi(input: {
	env: DiscordGuildRoleEnv
	discordUserId: string
	roleId: string
	method: 'PUT' | 'DELETE'
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordMemberRoleSyncResult> {
	if (!isDiscordSnowflake(input.discordUserId)) {
		return { status: 'skipped', reason: 'invalid-user-id' }
	}
	const config = getDiscordGuildBotConfig(input.env)
	if (!config || !isDiscordSnowflake(input.roleId)) {
		return { status: 'skipped', reason: 'not-configured' }
	}

	const fetchImpl = input.fetchImpl ?? fetch
	const timeoutMs = input.timeoutMs ?? DISCORD_MEMBER_ROLE_REQUEST_TIMEOUT_MS
	try {
		const response = await fetchImpl(
			memberRoleUrl(config.guildId, input.discordUserId, input.roleId),
			{
				method: input.method,
				headers: {
					Authorization: `Bot ${config.botToken}`,
					'User-Agent': 'kody',
				},
				signal: AbortSignal.timeout(timeoutMs),
			},
		)
		if (response.ok || response.status === 204) {
			return {
				status: input.method === 'PUT' ? 'assigned' : 'removed',
			}
		}
		if (response.status === 404) {
			return { status: 'not-in-guild' }
		}
		if (response.status === 403) {
			return { status: 'forbidden' }
		}
		return {
			status: 'error',
			message: `Discord member-role ${input.method} failed (${response.status}).`,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { status: 'error', message }
	}
}

export async function assignDiscordMemberRole(input: {
	env: DiscordMemberRoleEnv
	discordUserId: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordMemberRoleSyncResult> {
	const config = getDiscordMemberRoleConfig(input.env)
	if (!config) {
		return { status: 'skipped', reason: 'not-configured' }
	}
	return callDiscordMemberRoleApi({
		...input,
		roleId: config.roleId,
		method: 'PUT',
	})
}

export async function removeDiscordMemberRole(input: {
	env: DiscordMemberRoleEnv
	discordUserId: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordMemberRoleSyncResult> {
	const config = getDiscordMemberRoleConfig(input.env)
	if (!config) {
		return { status: 'skipped', reason: 'not-configured' }
	}
	return callDiscordMemberRoleApi({
		...input,
		roleId: config.roleId,
		method: 'DELETE',
	})
}

export async function syncDiscordPlanRoles(input: {
	env: DiscordGuildRoleEnv
	discordUserId: string
	stripePlan: PlanName | null | undefined
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordMemberRoleSyncResult> {
	const config = getDiscordGuildBotConfig(input.env)
	if (!config || !isDiscordPlanRoleSyncConfigured(input.env)) {
		return { status: 'skipped', reason: 'not-configured' }
	}
	const desired = desiredDiscordPlanRole(input.stripePlan)
	const results = await Promise.all(
		discordPlanRoles.map((plan) => {
			const roleId = planRoleId(config, plan)
			if (!roleId) {
				return Promise.resolve({
					status: 'skipped' as const,
					reason: 'not-configured' as const,
				})
			}
			return callDiscordMemberRoleApi({
				env: input.env,
				discordUserId: input.discordUserId,
				roleId,
				method: desired === plan ? 'PUT' : 'DELETE',
				fetchImpl: input.fetchImpl,
				timeoutMs: input.timeoutMs,
			})
		}),
	)
	return rollupDiscordRoleResults(results)
}

function warnDiscordRoleFailure(
	action: 'assign' | 'remove' | 'sync',
	label: string,
	result: DiscordMemberRoleSyncResult,
) {
	if (result.status === 'error') {
		console.warn(`Failed to ${action} ${label}:`, result.message)
	} else if (result.status === 'forbidden') {
		console.warn(
			`Failed to ${action} ${label}: bot lacks permission or role hierarchy.`,
		)
	}
}

/**
 * Assign the Kody Discord member role after a Discord identity is linked or
 * used to sign in. Failures are logged and never thrown.
 */
export async function maybeAssignDiscordMemberRole(input: {
	env: DiscordMemberRoleEnv
	discordUserId: string
	fetchImpl?: typeof fetch
}): Promise<DiscordMemberRoleSyncResult> {
	const result = await assignDiscordMemberRole(input)
	warnDiscordRoleFailure('assign', 'Kody Discord member role', result)
	return result
}

/**
 * Remove the Kody Discord member role after Discord is disconnected or the
 * account is deleted. Failures are logged and never thrown.
 */
export async function maybeRemoveDiscordMemberRole(input: {
	env: DiscordMemberRoleEnv
	discordUserId: string
	fetchImpl?: typeof fetch
}): Promise<DiscordMemberRoleSyncResult> {
	const result = await removeDiscordMemberRole(input)
	warnDiscordRoleFailure('remove', 'Kody Discord member role', result)
	return result
}

export async function maybeSyncDiscordPlanRoles(input: {
	env: DiscordGuildRoleEnv
	discordUserId: string
	stripePlan: PlanName | null | undefined
	fetchImpl?: typeof fetch
}): Promise<DiscordMemberRoleSyncResult> {
	const result = await syncDiscordPlanRoles(input)
	warnDiscordRoleFailure('sync', 'Kody Discord plan roles', result)
	return result
}

export async function maybeSyncDiscordGuildRoles(input: {
	env: DiscordGuildRoleEnv
	discordUserId: string
	stripePlan: PlanName | null | undefined
	fetchImpl?: typeof fetch
}): Promise<DiscordGuildRoleSyncSummary> {
	const [member, plan] = await Promise.all([
		maybeAssignDiscordMemberRole(input),
		maybeSyncDiscordPlanRoles(input),
	])
	return { member, plan }
}

export async function maybeRemoveDiscordGuildRoles(input: {
	env: DiscordGuildRoleEnv
	discordUserId: string
	fetchImpl?: typeof fetch
}): Promise<DiscordGuildRoleSyncSummary> {
	const [member, plan] = await Promise.all([
		maybeRemoveDiscordMemberRole(input),
		maybeSyncDiscordPlanRoles({
			...input,
			stripePlan: null,
		}),
	])
	return { member, plan }
}

export function summarizeDiscordGuildRoleSync(
	summary: DiscordGuildRoleSyncSummary,
): DiscordMemberRoleSyncResult {
	return rollupDiscordRoleResults([summary.member, summary.plan])
}

async function readDiscordConnectionUserId(
	db: D1Database,
	userId: number,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT provider_id FROM oauth_connections
			 WHERE user_id = ? AND provider_name = 'discord'`,
		)
		.bind(userId)
		.first<{ provider_id: string }>()
	const providerId = row?.provider_id?.trim()
	return providerId && providerId.length > 0 ? providerId : null
}

async function readUserStripePlan(
	db: D1Database,
	userId: number,
): Promise<PlanName | null> {
	const row = await db
		.prepare(`SELECT stripe_plan FROM users WHERE id = ?`)
		.bind(userId)
		.first<{ stripe_plan: string | null }>()
	return parseStripePlanName(row?.stripe_plan)
}

/**
 * Look up the user's Discord snowflake (and Stripe plan, when omitted) and
 * sync member + Standard/Pro roles. Failures are logged and never thrown.
 */
export async function maybeSyncDiscordGuildRolesForUser(input: {
	env: DiscordGuildRoleEnv & { APP_DB: D1Database }
	userId: number
	discordUserId?: string
	stripePlan?: PlanName | null
	fetchImpl?: typeof fetch
}): Promise<
	| DiscordGuildRoleSyncSummary
	| { status: 'skipped'; reason: 'not-configured' | 'no-discord-connection' }
> {
	if (!isDiscordGuildRoleSyncConfigured(input.env)) {
		return { status: 'skipped', reason: 'not-configured' }
	}
	try {
		const discordUserId =
			input.discordUserId ??
			(await readDiscordConnectionUserId(input.env.APP_DB, input.userId))
		if (!discordUserId) {
			return { status: 'skipped', reason: 'no-discord-connection' }
		}
		const stripePlan =
			input.stripePlan !== undefined
				? input.stripePlan
				: await readUserStripePlan(input.env.APP_DB, input.userId)
		return await maybeSyncDiscordGuildRoles({
			env: input.env,
			discordUserId,
			stripePlan,
			fetchImpl: input.fetchImpl,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.warn('Failed to sync Kody Discord guild roles:', message)
		const result = { status: 'error' as const, message }
		return { member: result, plan: result }
	}
}
