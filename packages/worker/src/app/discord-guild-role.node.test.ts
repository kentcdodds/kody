import { expect, test } from 'vitest'
import {
	assignDiscordMemberRole,
	getDiscordMemberRoleConfig,
	isDiscordMemberRoleSyncConfigured,
	isDiscordSnowflake,
	maybeAssignDiscordMemberRole,
	maybeRemoveDiscordMemberRole,
	removeDiscordMemberRole,
} from './discord-guild-role.ts'

const configuredEnv = {
	DISCORD_BOT_TOKEN: 'bot-token-test',
	DISCORD_GUILD_ID: '111111111111111111',
	DISCORD_MEMBER_ROLE_ID: '222222222222222222',
}

const discordUserId = '333333333333333333'

function jsonResponse(status: number, body: unknown = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

test('role sync stays off until bot token, guild id, and role id are all set', () => {
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
			url: `https://discord.com/api/v10/guilds/${configuredEnv.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${configuredEnv.DISCORD_MEMBER_ROLE_ID}`,
			method: 'PUT',
			authorization: 'Bot bot-token-test',
		},
		{
			url: `https://discord.com/api/v10/guilds/${configuredEnv.DISCORD_GUILD_ID}/members/${discordUserId}/roles/${configuredEnv.DISCORD_MEMBER_ROLE_ID}`,
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

test('maybe helpers swallow Discord failures instead of throwing', async () => {
	const assigned = await maybeAssignDiscordMemberRole({
		env: configuredEnv,
		discordUserId,
		fetchImpl: async () => {
			throw new Error('network down')
		},
	})
	expect(assigned).toEqual({ status: 'error', message: 'network down' })

	const removed = await maybeRemoveDiscordMemberRole({
		env: configuredEnv,
		discordUserId,
		fetchImpl: async () => jsonResponse(403),
	})
	expect(removed).toEqual({ status: 'forbidden' })
})
