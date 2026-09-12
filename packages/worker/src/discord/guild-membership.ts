/**
 * Official Kody Discord membership as Waiting can see it: a linked Discord
 * social-login snowflake plus a live guild member GET. Role writes stay in
 * `guild-role.ts` so this probe does not pull that graph into MCP Waiting.
 */

export const DISCORD_MEMBERSHIP_REQUEST_TIMEOUT_MS = 8_000

export type DiscordMembershipEnv = {
	DISCORD_BOT_TOKEN?: string | undefined
	DISCORD_GUILD_ID?: string | undefined
}

export type DiscordGuildMembershipSkipReason =
	| 'not-configured'
	| 'invalid-user-id'

export type DiscordGuildMembershipResult =
	| { status: 'member' }
	| { status: 'not-in-guild' }
	| { status: 'skipped'; reason: DiscordGuildMembershipSkipReason }
	| { status: 'error'; message: string }

const discordApiBaseUrl = 'https://discord.com/api/v10'
const discordSnowflakePattern = /^\d{5,20}$/

function isDiscordSnowflake(value: string) {
	return discordSnowflakePattern.test(value)
}

function readOfficialGuildBotConfig(env: DiscordMembershipEnv) {
	const botToken = env.DISCORD_BOT_TOKEN?.trim()
	const guildId = env.DISCORD_GUILD_ID?.trim()
	if (!botToken || !guildId || !isDiscordSnowflake(guildId)) return null
	return { botToken, guildId }
}

function guildMemberUrl(guildId: string, discordUserId: string) {
	return `${discordApiBaseUrl}/guilds/${guildId}/members/${discordUserId}`
}

async function readDiscordConnectionUserIds(db: D1Database, userId: number) {
	const result = await db
		.prepare(
			`SELECT provider_id FROM oauth_connections
			 WHERE user_id = ? AND provider_name = 'discord'`,
		)
		.bind(userId)
		.all<{ provider_id: string }>()
	const ids: Array<string> = []
	for (const row of result.results ?? []) {
		const providerId = row.provider_id?.trim()
		if (providerId) ids.push(providerId)
	}
	return ids
}

/**
 * Read whether the Discord user is currently in the official guild. Failures
 * are classified and never thrown. Callers treat `skipped` / `error` as
 * unknown so a bot or network blip cannot invent a Waiting card.
 */
export async function readOfficialDiscordGuildMembership(input: {
	env: DiscordMembershipEnv
	discordUserId: string
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<DiscordGuildMembershipResult> {
	if (!isDiscordSnowflake(input.discordUserId)) {
		return { status: 'skipped', reason: 'invalid-user-id' }
	}
	const config = readOfficialGuildBotConfig(input.env)
	if (!config) {
		return { status: 'skipped', reason: 'not-configured' }
	}

	const fetchImpl = input.fetchImpl ?? fetch
	const timeoutMs = input.timeoutMs ?? DISCORD_MEMBERSHIP_REQUEST_TIMEOUT_MS
	try {
		const response = await fetchImpl(
			guildMemberUrl(config.guildId, input.discordUserId),
			{
				method: 'GET',
				headers: {
					Authorization: `Bot ${config.botToken}`,
					'User-Agent': 'kody',
				},
				signal: AbortSignal.timeout(timeoutMs),
			},
		)
		if (response.ok) {
			return { status: 'member' }
		}
		if (response.status === 404) {
			return { status: 'not-in-guild' }
		}
		return {
			status: 'error',
			message: `Discord guild membership lookup failed (${response.status}).`,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return { status: 'error', message }
	}
}

/**
 * Official-guild membership as Kody can see it: Discord social login plus a
 * live member read. A user can have more than one Discord identity. `true`
 * means any linked identity is in the guild. `false` means none are linked,
 * or every linked identity is confirmed out. `null` is unknown — bot unset,
 * API blip, or a storage error — so Waiting must not invent a card.
 */
export async function readOfficialDiscordMembershipForUser(input: {
	env: DiscordMembershipEnv & { APP_DB: D1Database }
	userId: number
	fetchImpl?: typeof fetch
	timeoutMs?: number
}): Promise<boolean | null> {
	try {
		const discordUserIds = await readDiscordConnectionUserIds(
			input.env.APP_DB,
			input.userId,
		)
		if (discordUserIds.length === 0) return false
		let sawUnknown = false
		for (const discordUserId of discordUserIds) {
			const membership = await readOfficialDiscordGuildMembership({
				env: input.env,
				discordUserId,
				fetchImpl: input.fetchImpl,
				timeoutMs: input.timeoutMs,
			})
			switch (membership.status) {
				case 'member':
					return true
				case 'not-in-guild':
					break
				case 'skipped':
				case 'error':
					sawUnknown = true
					break
				default: {
					const exhaustive: never = membership
					void exhaustive
					sawUnknown = true
				}
			}
		}
		return sawUnknown ? null : false
	} catch {
		return null
	}
}
