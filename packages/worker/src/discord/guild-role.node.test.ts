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

const discordUserId = '333333333333333333'

function jsonResponse(status: number, body: unknown = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function roleUrl(roleId: string) {
	return `https://discord.com/api/v10/guilds/${configuredEnv.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${roleId}`
}

function memberUrl() {
	return `https://discord.com/api/v10/guilds/${configuredEnv.DISCORD_GUILD_ID}/members/${discordUserId}`
}

test('role sync stays off until bot token, guild id, and at least one role id are set', () => {
	expect(isDiscordSnowflake('12345')).toBe(true)
	expect(isDiscordSnowflake('mock-discord-user-1')).toBe(false)
	expect(getDiscordMemberRoleConfig({})).toBeNull()
	expect(
		isDiscordMemberRoleSyncConfigured({
			DISCORD_BOT_TOKEN: 'bot-token-test',
			DISCORD_GUILD_ID: '111111111111111111',
		}),
	).toBe(false)
	expect(isDiscordMemberRoleSyncConfigured(configuredEnv)).toBe(true)
	expect(
		isDiscordPlanRoleSyncConfigured({
			DISCORD_BOT_TOKEN: 'bot-token-test',
			DISCORD_GUILD_ID: '111111111111111111',
			DISCORD_STANDARD_ROLE_ID: configuredEnv.DISCORD_STANDARD_ROLE_ID,
		}),
	).toBe(true)
	expect(
		isDiscordGuildRoleSyncConfigured({
			DISCORD_BOT_TOKEN: 'bot-token-test',
			DISCORD_GUILD_ID: '111111111111111111',
			DISCORD_PRO_ROLE_ID: configuredEnv.DISCORD_PRO_ROLE_ID,
		}),
	).toBe(true)
})

test('guild join uses the ephemeral access token once and classifies outcomes', async () => {
	consoleWarn.mockImplementation(() => {})
	const calls: Array<{
		url: string
		method: string
		authorization: string
		body: unknown
	}> = []

	async function fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
		const url = String(input)
		calls.push({
			url,
			method: init?.method ?? 'GET',
			authorization: new Headers(init?.headers).get('Authorization') ?? '',
			body: init?.body ? JSON.parse(String(init.body)) : null,
		})
		if (url === memberUrl() && init?.method === 'PUT') {
			return new Response(null, { status: 201 })
		}
		return jsonResponse(500)
	}

	expect(
		await maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: '  discord-access-token  ',
			fetchImpl,
		}),
	).toEqual({ status: 'joined' })
	expect(calls).toEqual([
		{
			url: memberUrl(),
			method: 'PUT',
			authorization: 'Bot bot-token-test',
			body: { access_token: 'discord-access-token' },
		},
	])

	expect(
		await maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: '   ',
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'missing-access-token' })
	expect(
		await maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: null,
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'missing-access-token' })
	expect(
		await maybeJoinOfficialDiscordGuild({
			env: {},
			discordUserId,
			accessToken: 'discord-access-token',
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'not-configured' })
	expect(
		await maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId: 'mock-discord-user-1',
			accessToken: 'discord-access-token',
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'invalid-user-id' })
	expect(
		await maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: 'discord-access-token',
			fetchImpl: async () => new Response(null, { status: 204 }),
		}),
	).toEqual({ status: 'already-member' })
	expect(
		await maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: 'discord-access-token',
			fetchImpl: async () => jsonResponse(403),
		}),
	).toEqual({ status: 'forbidden' })
	expect(
		await maybeJoinOfficialDiscordGuild({
			env: configuredEnv,
			discordUserId,
			accessToken: 'discord-access-token',
			fetchImpl: async () => jsonResponse(500),
		}),
	).toEqual({
		status: 'error',
		message: 'Discord guild join failed (500).',
	})
})

test('assign and remove call the Discord member-role routes and classify outcomes', async () => {
	const calls: Array<{ url: string; method: string; authorization: string }> =
		[]

	async function fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
		const url = String(input)
		calls.push({
			url,
			method: init?.method ?? 'GET',
			authorization: new Headers(init?.headers).get('Authorization') ?? '',
		})
		if (url.endsWith(`/roles/${configuredEnv.DISCORD_MEMBER_ROLE_ID}`)) {
			if (init?.method === 'PUT') return new Response(null, { status: 204 })
			if (init?.method === 'DELETE') return new Response(null, { status: 204 })
		}
		return jsonResponse(500)
	}

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
		{
			url: roleUrl(configuredEnv.DISCORD_MEMBER_ROLE_ID),
			method: 'PUT',
			authorization: 'Bot bot-token-test',
		},
		{
			url: roleUrl(configuredEnv.DISCORD_MEMBER_ROLE_ID),
			method: 'DELETE',
			authorization: 'Bot bot-token-test',
		},
	])

	expect(
		await assignDiscordMemberRole({
			env: {},
			discordUserId,
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'not-configured' })
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId: 'mock-discord-user-1',
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'invalid-user-id' })
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
			fetchImpl: async () => jsonResponse(404),
		}),
	).toEqual({ status: 'not-in-guild' })
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
			fetchImpl: async () => jsonResponse(403),
		}),
	).toEqual({ status: 'forbidden' })
	expect(
		await assignDiscordMemberRole({
			env: configuredEnv,
			discordUserId,
			fetchImpl: async () => jsonResponse(500),
		}),
	).toEqual({
		status: 'error',
		message: 'Discord member-role PUT failed (500).',
	})
})

test('plan role sync assigns the subscribed plan and removes the other', async () => {
	const calls: Array<{ url: string; method: string }> = []

	async function fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
		calls.push({
			url: String(input),
			method: init?.method ?? 'GET',
		})
		return new Response(null, { status: 204 })
	}

	expect(
		await syncDiscordPlanRoles({
			env: configuredEnv,
			discordUserId,
			stripePlan: 'pro',
			fetchImpl,
		}),
	).toEqual({ status: 'assigned' })
	expect(calls).toEqual([
		{
			url: roleUrl(configuredEnv.DISCORD_STANDARD_ROLE_ID),
			method: 'DELETE',
		},
		{ url: roleUrl(configuredEnv.DISCORD_PRO_ROLE_ID), method: 'PUT' },
	])

	calls.length = 0
	expect(
		await syncDiscordPlanRoles({
			env: configuredEnv,
			discordUserId,
			stripePlan: 'standard',
			fetchImpl,
		}),
	).toEqual({ status: 'assigned' })
	expect(calls).toEqual([
		{ url: roleUrl(configuredEnv.DISCORD_STANDARD_ROLE_ID), method: 'PUT' },
		{ url: roleUrl(configuredEnv.DISCORD_PRO_ROLE_ID), method: 'DELETE' },
	])

	calls.length = 0
	expect(
		await syncDiscordPlanRoles({
			env: configuredEnv,
			discordUserId,
			stripePlan: null,
			fetchImpl,
		}),
	).toEqual({ status: 'assigned' })
	expect(calls).toEqual([
		{
			url: roleUrl(configuredEnv.DISCORD_STANDARD_ROLE_ID),
			method: 'DELETE',
		},
		{ url: roleUrl(configuredEnv.DISCORD_PRO_ROLE_ID), method: 'DELETE' },
	])

	expect(
		await syncDiscordPlanRoles({
			env: {
				DISCORD_BOT_TOKEN: 'bot-token-test',
				DISCORD_GUILD_ID: configuredEnv.DISCORD_GUILD_ID,
				DISCORD_MEMBER_ROLE_ID: configuredEnv.DISCORD_MEMBER_ROLE_ID,
			},
			discordUserId,
			stripePlan: 'pro',
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'not-configured' })

	expect(
		summarizeDiscordGuildRoleSync({
			member: { status: 'assigned' },
			plan: { status: 'forbidden' },
		}),
	).toEqual({ status: 'forbidden' })
	expect(
		summarizeDiscordGuildRoleSync({
			member: { status: 'assigned' },
			plan: { status: 'error', message: 'Discord plan-role PUT failed (500).' },
		}),
	).toEqual({
		status: 'error',
		message: 'Discord plan-role PUT failed (500).',
	})
})

test('maybe helpers swallow Discord failures instead of throwing', async () => {
	consoleWarn.mockImplementation(() => {})
	const assigned = await maybeAssignDiscordMemberRole({
		env: configuredEnv,
		discordUserId,
		fetchImpl: async () => {
			throw new Error('network down')
		},
	})
	expect(assigned).toEqual({ status: 'error', message: 'network down' })
	expect(consoleWarn).toHaveBeenCalled()

	const removed = await maybeRemoveDiscordMemberRole({
		env: configuredEnv,
		discordUserId,
		fetchImpl: async () => jsonResponse(403),
	})
	expect(removed).toEqual({ status: 'forbidden' })
	expect(consoleWarn).toHaveBeenCalled()

	const plan = await maybeSyncDiscordPlanRoles({
		env: configuredEnv,
		discordUserId,
		stripePlan: 'pro',
		fetchImpl: async () => {
			throw new Error('plan role down')
		},
	})
	expect(plan).toEqual({ status: 'error', message: 'plan role down' })
	expect(consoleWarn).toHaveBeenCalled()
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
	const env = {
		...configuredEnv,
		APP_DB: createD1FromSqlite(sqlite),
	}
	const calls: Array<{ url: string; method: string }> = []
	async function fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
		calls.push({ url: String(input), method: init?.method ?? 'GET' })
		return new Response(null, { status: 204 })
	}

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
	expect(calls).toEqual(
		expect.arrayContaining([
			{
				url: roleUrl(configuredEnv.DISCORD_MEMBER_ROLE_ID),
				method: 'PUT',
			},
			{
				url: roleUrl(configuredEnv.DISCORD_STANDARD_ROLE_ID),
				method: 'PUT',
			},
			{
				url: roleUrl(configuredEnv.DISCORD_PRO_ROLE_ID),
				method: 'DELETE',
			},
		]),
	)

	calls.length = 0
	expect(
		await maybeSyncDiscordGuildRolesForUser({
			env,
			userId: 99,
			fetchImpl,
		}),
	).toEqual({ status: 'skipped', reason: 'no-discord-connection' })
	expect(calls).toEqual([])

	const removed = await maybeRemoveDiscordGuildRoles({
		env,
		discordUserId,
		fetchImpl,
	})
	expect(removed.member).toEqual({ status: 'removed' })
	expect(removed.plan).toEqual({ status: 'assigned' })
	expect(calls).toEqual(
		expect.arrayContaining([
			{
				url: roleUrl(configuredEnv.DISCORD_MEMBER_ROLE_ID),
				method: 'DELETE',
			},
			{
				url: roleUrl(configuredEnv.DISCORD_STANDARD_ROLE_ID),
				method: 'DELETE',
			},
			{
				url: roleUrl(configuredEnv.DISCORD_PRO_ROLE_ID),
				method: 'DELETE',
			},
		]),
	)
})
