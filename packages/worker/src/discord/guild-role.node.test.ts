import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
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
const discordApi = 'https://discord.com/api/v10'

const memberUrl = `${discordApi}/guilds/${configuredEnv.DISCORD_GUILD_ID}/members/${discordUserId}`
const roleUrl = (roleId: string) => `${memberUrl}/roles/${roleId}`
const memberRole = roleUrl(configuredEnv.DISCORD_MEMBER_ROLE_ID)
const standardRole = roleUrl(configuredEnv.DISCORD_STANDARD_ROLE_ID)
const proRole = roleUrl(configuredEnv.DISCORD_PRO_ROLE_ID)
const memberByUserUrl = `${discordApi}/guilds/${configuredEnv.DISCORD_GUILD_ID}/members/:userId`
const roleByIdUrl = `${memberUrl}/roles/:roleId`

type Call = { url: string; method: string; authorization: string }

type RecordedHttpRequest = {
	url: string
	method: string
	headers: { get(name: string): string | null }
}

function recordCall(request: RecordedHttpRequest, calls: Array<Call>) {
	calls.push({
		url: request.url,
		method: request.method,
		authorization: request.headers.get('Authorization') ?? '',
	})
}

function jsonResponse(status: number, body: object = {}) {
	return HttpResponse.json(body, { status })
}

const routes = (calls: Array<Call>) =>
	calls.map(({ url, method }) => ({ url, method }))

function noContentHandlers(calls: Array<Call>) {
	return [
		http.put(roleByIdUrl, ({ request }) => {
			recordCall(request, calls)
			return new HttpResponse(null, { status: 204 })
		}),
		http.delete(roleByIdUrl, ({ request }) => {
			recordCall(request, calls)
			return new HttpResponse(null, { status: 204 })
		}),
	]
}

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
	const calls: Array<Call> = []
	using msw = createMswNodeServer([
		http.put(memberUrl, async ({ request }) => {
			recordCall(request, calls)
			bodies.push(await request.clone().json())
			return new HttpResponse(null, { status: 201 })
		}),
	])
	const join = (
		overrides: Partial<Parameters<typeof maybeJoinOfficialDiscordGuild>[0]>,
	) =>
		maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: 'discord-access-token',
			...overrides,
		})

	expect(await join({ accessToken: '  discord-access-token  ' })).toEqual({
		status: 'joined',
	})
	expect(calls).toEqual([
		{ url: memberUrl, method: 'PUT', authorization: 'Bot bot-token-test' },
	])
	expect(bodies).toEqual([{ access_token: 'discord-access-token' }])

	expect(await join({ accessToken: '   ' })).toEqual({
		status: 'skipped',
		reason: 'missing-access-token',
	})
	expect(await join({ accessToken: null })).toEqual({
		status: 'skipped',
		reason: 'missing-access-token',
	})
	expect(await join({ env: {} })).toEqual({
		status: 'skipped',
		reason: 'not-configured',
	})
	expect(await join({ discordUserId: 'mock-discord-user-1' })).toEqual({
		status: 'skipped',
		reason: 'invalid-user-id',
	})

	msw.use(http.put(memberUrl, () => new HttpResponse(null, { status: 204 })))
	expect(await join({})).toEqual({ status: 'already-member' })

	msw.use(http.put(memberUrl, () => jsonResponse(403)))
	expect(await join({})).toEqual({ status: 'forbidden' })

	msw.use(http.put(memberUrl, () => jsonResponse(500)))
	expect(await join({})).toEqual({
		status: 'error',
		message: 'Discord guild join failed (500).',
	})
})

test('official guild membership lookup classifies member, absent, and fail-open', async () => {
	const calls: Array<Call> = []
	using msw = createMswNodeServer([
		http.get(memberUrl, ({ request }) => {
			recordCall(request, calls)
			return jsonResponse(200, { user: { id: discordUserId } })
		}),
	])
	const lookup = (
		overrides: Partial<
			Parameters<typeof readOfficialDiscordGuildMembership>[0]
		> = {},
	) =>
		readOfficialDiscordGuildMembership({
			env: configuredEnv,
			discordUserId,
			...overrides,
		})
	expect(await lookup()).toEqual({ status: 'member' })
	expect(calls).toEqual([
		{ url: memberUrl, method: 'GET', authorization: 'Bot bot-token-test' },
	])

	msw.use(http.get(memberUrl, () => jsonResponse(404)))
	expect(await lookup()).toEqual({ status: 'not-in-guild' })
	expect(await lookup({ env: {} })).toEqual({
		status: 'skipped',
		reason: 'not-configured',
	})
	expect(await lookup({ discordUserId: 'mock-discord-user-1' })).toEqual({
		status: 'skipped',
		reason: 'invalid-user-id',
	})
	msw.use(http.get(memberUrl, () => jsonResponse(500)))
	expect(await lookup()).toEqual({
		status: 'error',
		message: 'Discord guild membership lookup failed (500).',
	})

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
	const forUser = (env: Record<string, unknown> = configuredEnv) =>
		readOfficialDiscordMembershipForUser({
			env: { ...env, APP_DB: db },
			userId: 11,
		})

	msw.resetHandlers()
	expect(await forUser()).toBe(false)

	await linkDiscord(discordUserId)
	expect(await forUser()).toBe(true)
	msw.use(http.get(memberUrl, () => jsonResponse(404)))
	expect(await forUser()).toBe(false)
	expect(await forUser({})).toBeNull()
	msw.use(http.get(memberUrl, () => HttpResponse.error()))
	expect(await forUser()).toBeNull()

	// Any linked Discord account in the guild counts; any lookup error with no
	// member found fails open (null).
	const secondDiscordUserId = '555555555555555555'
	await linkDiscord(secondDiscordUserId)
	const multiCalls: Array<Call> = []
	msw.use(
		http.get(memberByUserUrl, ({ request, params }) => {
			recordCall(request, multiCalls)
			return String(params.userId) === secondDiscordUserId
				? jsonResponse(200, { user: { id: secondDiscordUserId } })
				: jsonResponse(404)
		}),
	)
	expect(await forUser()).toBe(true)
	expect(multiCalls.some(({ url }) => url.includes(discordUserId))).toBe(true)
	expect(multiCalls.some(({ url }) => url.includes(secondDiscordUserId))).toBe(
		true,
	)
	msw.use(http.get(memberByUserUrl, () => jsonResponse(404)))
	expect(await forUser()).toBe(false)
	msw.use(
		http.get(memberByUserUrl, ({ params }) =>
			jsonResponse(String(params.userId) === secondDiscordUserId ? 500 : 404),
		),
	)
	expect(await forUser()).toBeNull()
})

test('assign and remove call the Discord member-role routes and classify outcomes', async () => {
	const calls: Array<Call> = []
	using msw = createMswNodeServer([
		http.put(memberRole, ({ request }) => {
			recordCall(request, calls)
			return new HttpResponse(null, { status: 204 })
		}),
		http.delete(memberRole, ({ request }) => {
			recordCall(request, calls)
			return new HttpResponse(null, { status: 204 })
		}),
	])
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
		}),
	).toEqual({ status: 'assigned' })
	expect(
		await removeDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
		}),
	).toEqual({ status: 'removed' })
	expect(calls).toEqual([
		{ url: memberRole, method: 'PUT', authorization: 'Bot bot-token-test' },
		{ url: memberRole, method: 'DELETE', authorization: 'Bot bot-token-test' },
	])

	expect(
		await assignDiscordMemberRole({
			env: {},
			discordUserId,
		}),
	).toEqual({ status: 'skipped', reason: 'not-configured' })
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId: 'mock-discord-user-1',
		}),
	).toEqual({ status: 'skipped', reason: 'invalid-user-id' })

	msw.use(http.put(memberRole, () => jsonResponse(404)))
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
		}),
	).toEqual({ status: 'not-in-guild' })
	msw.use(http.put(memberRole, () => jsonResponse(403)))
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
		}),
	).toEqual({ status: 'forbidden' })
	msw.use(http.put(memberRole, () => jsonResponse(500)))
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
		}),
	).toEqual({
		status: 'error',
		message: 'Discord member-role PUT failed (500).',
	})
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
		const calls: Array<Call> = []
		using _server = createMswNodeServer(noContentHandlers(calls))
		expect(
			await syncDiscordPlanRoles({
				env: configuredEnv,
				discordUserId,
				stripePlan,
			}),
		).toEqual({ status: 'assigned' })
		expect(routes(calls)).toEqual(expect.arrayContaining([...expectedRoutes]))
		expect(routes(calls)).toHaveLength(expectedRoutes.length)
		expect(
			calls.every((call) => call.authorization === 'Bot bot-token-test'),
		).toBe(true)
	}

	expect(
		await syncDiscordPlanRoles({
			env: {
				...botOnlyEnv,
				DISCORD_MEMBER_ROLE_ID: configuredEnv.DISCORD_MEMBER_ROLE_ID,
			},
			discordUserId,
			stripePlan: 'pro',
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
	using msw = createMswNodeServer()
	msw.use(
		http.put(roleByIdUrl, () => HttpResponse.error()),
		http.delete(roleByIdUrl, () => HttpResponse.error()),
	)
	expect(
		await maybeAssignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
		}),
	).toMatchObject({ status: 'error', message: expect.any(String) })
	expect(consoleWarn).toHaveBeenCalledTimes(1)

	msw.use(http.delete(memberRole, () => jsonResponse(403)))
	expect(
		await maybeRemoveDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
		}),
	).toEqual({ status: 'forbidden' })
	expect(consoleWarn).toHaveBeenCalledTimes(2)

	msw.use(
		http.put(roleByIdUrl, () => HttpResponse.error()),
		http.delete(roleByIdUrl, () => HttpResponse.error()),
	)
	expect(
		await maybeSyncDiscordPlanRoles({
			env: configuredEnv,
			discordUserId,
			stripePlan: 'pro',
		}),
	).toMatchObject({ status: 'error', message: expect.any(String) })
	expect(consoleWarn).toHaveBeenCalledTimes(3)
})

test('user-level sync looks up Discord and stripe_plan, then disconnect removes every role', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT,
			deleted_at TEXT
		);
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			stripe_plan TEXT,
			deleted_at TEXT
		);
		CREATE TABLE oauth_connections (
			user_id INTEGER NOT NULL,
			provider_name TEXT NOT NULL,
			provider_id TEXT NOT NULL
		);
		INSERT INTO users (id, stable_user_id) VALUES (7, 'user-7');
		INSERT INTO orgs (id, stripe_plan) VALUES ('user-7', 'standard');
		INSERT INTO oauth_connections (user_id, provider_name, provider_id)
		VALUES (7, 'discord', '${discordUserId}');
	`)
	const env = { ...configuredEnv, APP_DB: createD1FromSqlite(sqlite) }
	const calls: Array<Call> = []
	using _server = createMswNodeServer(noContentHandlers(calls))

	const synced = await maybeSyncDiscordGuildRolesForUser({
		env,
		userId: 7,
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
	expect(
		calls.every((call) => call.authorization === 'Bot bot-token-test'),
	).toBe(true)

	const afterSync = calls.length
	expect(await maybeSyncDiscordGuildRolesForUser({ env, userId: 99 })).toEqual({
		status: 'skipped',
		reason: 'no-discord-connection',
	})
	expect(calls).toHaveLength(afterSync)

	const removed = await maybeRemoveDiscordGuildRoles({
		env,
		discordUserId,
	})
	expect(removed.member).toEqual({ status: 'removed' })
	expect(removed.plan).toEqual({ status: 'assigned' })
	expect(routes(calls.slice(afterSync))).toEqual(
		expect.arrayContaining([
			{ url: memberRole, method: 'DELETE' },
			{ url: standardRole, method: 'DELETE' },
			{ url: proRole, method: 'DELETE' },
		]),
	)
})
