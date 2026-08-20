/**
 * Best-effort Kody Discord member-role sync.
 *
 * Social login stores the Discord snowflake on `oauth_connections` and then
 * discards the user token. Guild role writes use an operator bot token, so
 * they stay off the login token path and skip entirely when bot config is
 * unset (local, preview, tests).
 */

export const DISCORD_MEMBER_ROLE_REQUEST_TIMEOUT_MS = 8_000

export type DiscordMemberRoleEnv = {
	DISCORD_BOT_TOKEN?: string | undefined
	DISCORD_GUILD_ID?: string | undefined
	DISCORD_MEMBER_ROLE_ID?: string | undefined
}

export type DiscordMemberRoleSkipReason = 'not-configured' | 'invalid-user-id'

export type DiscordMemberRoleSyncResult =
	| { status: 'skipped'; reason: DiscordMemberRoleSkipReason }
	| { status: 'assigned' }
	| { status: 'removed' }
	| { status: 'not-in-guild' }
	| { status: 'forbidden' }
	| { status: 'error'; message: string }

const discordApiBaseUrl = 'https://discord.com/api/v10'
const discordSnowflakePattern = /^\d{5,20}$/

function readTrimmedEnv(
	env: DiscordMemberRoleEnv,
	key: keyof DiscordMemberRoleEnv,
) {
	const trimmed = env[key]?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

export function isDiscordSnowflake(value: string) {
	return discordSnowflakePattern.test(value)
}

export function getDiscordMemberRoleConfig(env: DiscordMemberRoleEnv) {
	const botToken = readTrimmedEnv(env, 'DISCORD_BOT_TOKEN')
	const guildId = readTrimmedEnv(env, 'DISCORD_GUILD_ID')
	const roleId = readTrimmedEnv(env, 'DISCORD_MEMBER_ROLE_ID')
	if (!botToken || !guildId || !roleId) return null
	if (!isDiscordSnowflake(guildId) || !isDiscordSnowflake(roleId)) return null
	return { botToken, guildId, roleId }
}

export function isDiscordMemberRoleSyncConfigured(env: DiscordMemberRoleEnv) {
	return getDiscordMemberRoleConfig(env) !== null
}

function memberRoleUrl(guildId: string, discordUserId: string, roleId: string) {
	return `${discordApiBaseUrl}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`
}

async function callDiscordMemberRoleApi(input: {
	env: DiscordMemberRoleEnv
	discordUserId: string
	method: 'PUT' | 'DELETE'
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordMemberRoleSyncResult> {
	if (!isDiscordSnowflake(input.discordUserId)) {
		return { status: 'skipped', reason: 'invalid-user-id' }
	}
	const config = getDiscordMemberRoleConfig(input.env)
	if (!config) {
		return { status: 'skipped', reason: 'not-configured' }
	}

	const fetchImpl = input.fetchImpl ?? fetch
	const timeoutMs = input.timeoutMs ?? DISCORD_MEMBER_ROLE_REQUEST_TIMEOUT_MS
	try {
		const response = await fetchImpl(
			memberRoleUrl(config.guildId, input.discordUserId, config.roleId),
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
	return callDiscordMemberRoleApi({
		...input,
		method: 'PUT',
	})
}

export async function removeDiscordMemberRole(input: {
	env: DiscordMemberRoleEnv
	discordUserId: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordMemberRoleSyncResult> {
	return callDiscordMemberRoleApi({
		...input,
		method: 'DELETE',
	})
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
	if (result.status === 'error') {
		console.warn('Failed to assign Kody Discord member role:', result.message)
	} else if (result.status === 'forbidden') {
		console.warn(
			'Failed to assign Kody Discord member role: bot lacks permission or role hierarchy.',
		)
	}
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
	if (result.status === 'error') {
		console.warn('Failed to remove Kody Discord member role:', result.message)
	} else if (result.status === 'forbidden') {
		console.warn(
			'Failed to remove Kody Discord member role: bot lacks permission or role hierarchy.',
		)
	}
	return result
}
