import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	assignDiscordMemberRole,
	getDiscordMemberRoleConfig,
	isDiscordGuildRoleSyncConfigured,
	isDiscordMemberRoleSyncConfigured,
	isDiscordPlanRoleSyncConfigured,
	isDiscordSnowflake,
	maybeAssignDiscordMemberRole,
	maybeJoinOfficialDiscordGuild,
	maybeRemoveDiscordGuildRoles,
	maybeRemoveDiscordMemberRole,
	maybeSyncDiscordGuildRolesForUser,
	maybeSyncDiscordPlanRoles,
	readOfficialDiscordGuildMembership,
	readOfficialDiscordMembershipForUser,
	removeDiscordMemberRole,
	summarizeDiscordGuildRoleSync,
	syncDiscordPlanRoles,
} from './guild-role.ts'

const configuredEnv = {
	DISCORD_BOT_TOKEN: 'bot-token-test',
	DISCORD_GUILD_ID: '111111111111111111',
	DISCORD_MEMBER_ROLE_ID: '222222222222222222',
	DISCORD_STANDARD_ROLE_ID: '444444444444444444',
	DISCORD_PRO_ROLE_ID: '555555555555555555',
}
const botOnlyEnv = {
	DISCORD_BOT_TOKEN: 'bot-token-test',
	DISCORD_GUILD_ID: configuredEnv.DISCORD_GUILD_ID,
}

const discordUserId = '333333333333333333'

function jsonResponse(status: number, body: unknown = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

const respond = (status: number) => async () => jsonResponse(status)
const noContent = async () => new Response(null, { status: 204 })

const memberUrl = `https://discord.com/api/v10/guilds/${configuredEnv.DISCORD_GUILD_ID}/members/${discordUserId}`
const roleUrl = (roleId: string) => `${memberUrl}/roles/${roleId}`
const memberRole = roleUrl(configuredEnv.DISCORD_MEMBER_ROLE_ID)
const standardRole = roleUrl(configuredEnv.DISCORD_STANDARD_ROLE_ID)
const proRole = roleUrl(configuredEnv.DISCORD_PRO_ROLE_ID)

type Call = { url: string; method: string; authorization: string }

function recordingFetch(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
	const calls: Array<Call> = []
	async function fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
		const url = String(input)
		calls.push({
			url,
			method: init?.method ?? 'GET',
			authorization: new Headers(init?.headers).get('Authorization') ?? '',
		})
		return handler(url, init)
	}
	return { calls, fetchImpl }
}

const routes = (calls: Array<Call>) =>
	calls.map(({ url, method }) => ({ url, method }))

test('role sync stays off until bot token, guild id, and at least one role id are set', () => {
	expect(isDiscordSnowflake('12345')).toBe(true)
	expect(isDiscordSnowflake('mock-discord-user-1')).toBe(false)
	expect(getDiscordMemberRoleConfig({})).toBeNull()
	expect(isDiscordMemberRoleSyncConfigured(botOnlyEnv)).toBe(false)
	expect(isDiscordMemberRoleSyncConfigured(configuredEnv)).toBe(true)
	expect(
		isDiscordPlanRoleSyncConfigured({
			...botOnlyEnv,
			DISCORD_STANDARD_ROLE_ID: configuredEnv.DISCORD_STANDARD_ROLE_ID,
		}),
	).toBe(true)
	expect(
		isDiscordGuildRoleSyncConfigured({
			...botOnlyEnv,
			DISCORD_PRO_ROLE_ID: configuredEnv.DISCORD_PRO_ROLE_ID,
		}),
	).toBe(true)
})

test('guild join uses the ephemeral access token once and classifies outcomes', async () => {
	consoleWarn.mockImplementation(() => {})
	const bodies: Array<unknown> = []
	const { calls, fetchImpl } = recordingFetch((url, init) => {
		bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
		return url === memberUrl && init?.method === 'PUT'
			? new Response(null, { status: 201 })
			: jsonResponse(500)
	})
	const join = (
		overrides: Partial<Parameters<typeof maybeJoinOfficialDiscordGuild>[0]>,
	) =>
		maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: 'discord-access-token',
			fetchImpl,
			...overrides,
		})

	expect(await join({ accessToken: '  discord-access-token  ' })).toEqual({
		status: 'joined',
	})
	expect(calls).toEqual([
		{ url: memberUrl, method: 'PUT', authorization: 'Bot bot-token-test' },
	])
	expect(bodies).toEqual([{ access_token: 'discord-access-token' }])

	const cases = [
		[
			{ accessToken: '   ' },
			{ status: 'skipped', reason: 'missing-access-token' },
		],
		[
			{ accessToken: null },
			{ status: 'skipped', reason: 'missing-access-token' },
		],
		[{ env: {} }, { status: 'skipped', reason: 'not-configured' }],
		[
			{ discordUserId: 'mock-discord-user-1' },
			{ status: 'skipped', reason: 'invalid-user-id' },
		],
		[{ fetchImpl: noContent }, { status: 'already-member' }],
		[{ fetchImpl: respond(403) }, { status: 'forbidden' }],
		[
			{ fetchImpl: respond(500) },
			{ status: 'error', message: 'Discord guild join failed (500).' },
		],
	] as const
	expect(
		await Promise.all(cases.map(([overrides]) => join(overrides))),
	).toEqual(cases.map(([, expected]) => expected))
})

test('official guild membership lookup classifies member, absent, and fail-open', async () => {
	const { calls, fetchImpl } = recordingFetch(() =>
		jsonResponse(200, { user: { id: discordUserId } }),
	)
	const lookup = (
		overrides: Partial<
			Parameters<typeof readOfficialDiscordGuildMembership>[0]
		> = {},
	) =>
		readOfficialDiscordGuildMembership({
			env: configuredEnv,
			discordUserId,
			fetchImpl,
			...overrides,
		})
	expect(await lookup()).toEqual({ status: 'member' })
	expect(calls).toEqual([
		{ url: memberUrl, method: 'GET', authorization: 'Bot bot-token-test' },
	])
	const cases = [
		[{ fetchImpl: respond(404) }, { status: 'not-in-guild' }],
		[{ env: {} }, { status: 'skipped', reason: 'not-configured' }],
		[
			{ discordUserId: 'mock-discord-user-1' },
			{ status: 'skipped', reason: 'invalid-user-id' },
		],
		[
			{ fetchImpl: respond(500) },
			{
				status: 'error',
				message: 'Discord guild membership lookup failed (500).',
			},
		],
	] as const
	expect(
		await Promise.all(cases.map(([overrides]) => lookup(overrides))),
	).toEqual(cases.map(([, expected]) => expected))

	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE oauth_connections (
			user_id INTEGER NOT NULL,
			provider_name TEXT NOT NULL,
			provider_id TEXT NOT NULL
		)
	`)
	const db = createD1FromSqlite(sqlite)
	const linkDiscord = (providerId: string) =>
		db
			.prepare(
				`INSERT INTO oauth_connections (user_id, provider_name, provider_id)
				 VALUES (?, 'discord', ?)`,
			)
			.bind(11, providerId)
			.run()
	const forUser = (
		userFetch: typeof fetchImpl,
		env: Record<string, unknown> = configuredEnv,
	) =>
		readOfficialDiscordMembershipForUser({
			env: { ...env, APP_DB: db },
			userId: 11,
			fetchImpl: userFetch,
		})
	expect(await forUser(fetchImpl)).toBe(false)

	await linkDiscord(discordUserId)
	expect(await forUser(fetchImpl)).toBe(true)
	expect(await forUser(respond(404))).toBe(false)
	expect(await forUser(fetchImpl, {})).toBeNull()
	expect(
		await forUser(async () => {
			throw new Error('discord down')
		}),
	).toBeNull()

	// Any linked Discord account in the guild counts; any lookup error with no
	// member found fails open (null).
	const secondDiscordUserId = '555555555555555555'
	await linkDiscord(secondDiscordUserId)
	const multi = recordingFetch((url) =>
		url.includes(secondDiscordUserId)
			? jsonResponse(200, { user: { id: secondDiscordUserId } })
			: jsonResponse(404),
	)
	expect(await forUser(multi.fetchImpl)).toBe(true)
	expect(multi.calls.some(({ url }) => url.includes(discordUserId))).toBe(true)
	expect(multi.calls.some(({ url }) => url.includes(secondDiscordUserId))).toBe(
		true,
	)
	expect(await forUser(respond(404))).toBe(false)
	expect(
		await forUser(async (input) =>
			jsonResponse(String(input).includes(secondDiscordUserId) ? 500 : 404),
		),
	).toBeNull()
})

test('assign and remove call the Discord member-role routes and classify outcomes', async () => {
	const { calls, fetchImpl } = recordingFetch((url, init) =>
		url === memberRole && (init?.method === 'PUT' || init?.method === 'DELETE')
			? new Response(null, { status: 204 })
			: jsonResponse(500),
	)
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
			fetchImpl,
		}),
	).toEqual({ status: 'assigned' })
	expect(
		await removeDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
			fetchImpl,
		}),
	).toEqual({ status: 'removed' })
	expect(calls).toEqual([
		{ url: memberRole, method: 'PUT', authorization: 'Bot bot-token-test' },
		{ url: memberRole, method: 'DELETE', authorization: 'Bot bot-token-test' },
	])

	const cases = [
		[{ env: {} }, { status: 'skipped', reason: 'not-configured' }],
		[
			{ discordUserId: 'mock-discord-user-1' },
			{ status: 'skipped', reason: 'invalid-user-id' },
		],
		[{ fetchImpl: respond(404) }, { status: 'not-in-guild' }],
		[{ fetchImpl: respond(403) }, { status: 'forbidden' }],
		[
			{ fetchImpl: respond(500) },
			{ status: 'error', message: 'Discord member-role PUT failed (500).' },
		],
	] as const
	expect(
		await Promise.all(
			cases.map(([overrides]) =>
				assignDiscordMemberRole({
					env: configuredEnv,
					discordUserId,
					fetchImpl,
					...overrides,
				}),
			),
		),
	).toEqual(cases.map(([, expected]) => expected))
})

test('plan role sync assigns the subscribed plan and removes the other', async () => {
	for (const [stripePlan, expectedRoutes] of [
		[
			'pro',
			[
				{ url: standardRole, method: 'DELETE' },
				{ url: proRole, method: 'PUT' },
			],
		],
		[
			'standard',
			[
				{ url: standardRole, method: 'PUT' },
				{ url: proRole, method: 'DELETE' },
			],
		],
		[
			null,
			[
				{ url: standardRole, method: 'DELETE' },
				{ url: proRole, method: 'DELETE' },
			],
		],
	] as const) {
		const { calls, fetchImpl } = recordingFetch(noContent)
		expect(
			await syncDiscordPlanRoles({
				env: configuredEnv,
				discordUserId,
				stripePlan,
				fetchImpl,
			}),
		).toEqual({ status: 'assigned' })
		expect(routes(calls)).toEqual(expectedRoutes)
	}

	expect(
		await syncDiscordPlanRoles({
			env: {
				...botOnlyEnv,
				DISCORD_MEMBER_ROLE_ID: configuredEnv.DISCORD_MEMBER_ROLE_ID,
			},
			discordUserId,
			stripePlan: 'pro',
			fetchImpl: noContent,
		}),
	).toEqual({ status: 'skipped', reason: 'not-configured' })

	expect(
		summarizeDiscordGuildRoleSync({
			member: { status: 'assigned' },
			plan: { status: 'forbidden' },
		}),
	).toEqual({ status: 'forbidden' })
	const planError = {
		status: 'error',
		message: 'Discord plan-role PUT failed (500).',
	} as const
	expect(
		summarizeDiscordGuildRoleSync({
			member: { status: 'assigned' },
			plan: planError,
		}),
	).toEqual(planError)
})

test('maybe helpers swallow Discord failures instead of throwing', async () => {
	consoleWarn.mockImplementation(() => {})
	expect(
		await maybeAssignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
			fetchImpl: async () => {
				throw new Error('network down')
			},
		}),
	).toEqual({ status: 'error', message: 'network down' })
	expect(consoleWarn).toHaveBeenCalledTimes(1)

	expect(
		await maybeRemoveDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
			fetchImpl: respond(403),
		}),
	).toEqual({ status: 'forbidden' })
	expect(consoleWarn).toHaveBeenCalledTimes(2)

	expect(
		await maybeSyncDiscordPlanRoles({
			env: configuredEnv,
			discordUserId,
			stripePlan: 'pro',
			fetchImpl: async () => {
				throw new Error('plan role down')
			},
		}),
	).toEqual({ status: 'error', message: 'plan role down' })
	expect(consoleWarn).toHaveBeenCalledTimes(3)
})

test('user-level sync looks up Discord and stripe_plan, then disconnect removes every role', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stripe_plan TEXT
		);
		CREATE TABLE oauth_connections (
			user_id INTEGER NOT NULL,
			provider_name TEXT NOT NULL,
			provider_id TEXT NOT NULL
		);
		INSERT INTO users (id, stripe_plan) VALUES (7, 'standard');
		INSERT INTO oauth_connections (user_id, provider_name, provider_id)
		VALUES (7, 'discord', '${discordUserId}');
	`)
	const env = { ...configuredEnv, APP_DB: createD1FromSqlite(sqlite) }
	const { calls, fetchImpl } = recordingFetch(noContent)

	const synced = await maybeSyncDiscordGuildRolesForUser({
		env,
		userId: 7,
		fetchImpl,
	})
	expect('member' in synced && synced.member).toEqual({ status: 'assigned' })
	expect('plan' in synced && synced.plan).toEqual({ status: 'assigned' })
	expect(
		summarizeDiscordGuildRoleSync(
			synced as Extract<typeof synced, { member: unknown }>,
		),
	).toEqual({ status: 'assigned' })
	expect(routes(calls)).toEqual(
		expect.arrayContaining([
			{ url: memberRole, method: 'PUT' },
			{ url: standardRole, method: 'PUT' },
			{ url: proRole, method: 'DELETE' },
		]),
	)

	calls.length = 0
	expect(
		await maybeSyncDiscordGuildRolesForUser({ env, userId: 99, fetchImpl }),
	).toEqual({ status: 'skipped', reason: 'no-discord-connection' })
	expect(calls).toEqual([])

	const removed = await maybeRemoveDiscordGuildRoles({
		env,
		discordUserId,
		fetchImpl,
	})
	expect(removed.member).toEqual({ status: 'removed' })
	expect(removed.plan).toEqual({ status: 'assigned' })
	expect(routes(calls)).toEqual(
		expect.arrayContaining([
			{ url: memberRole, method: 'DELETE' },
			{ url: standardRole, method: 'DELETE' },
			{ url: proRole, method: 'DELETE' },
		]),
	)
})
