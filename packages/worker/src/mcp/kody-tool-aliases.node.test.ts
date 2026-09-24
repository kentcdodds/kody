import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createToolDispatchers } from '#mcp/executor.ts'
import { removedValueWriteMessage } from '#mcp/capabilities/values/shared.ts'
import { buildKodyFns } from '#mcp/run-kody-registry.ts'
import {
	aliasSnakeCaseKodyTools,
	resolveKodyCapabilityName,
} from '#mcp/kody-tool-aliases.ts'

test('execute host resolves snake_case OAuth tool names to the camelCase tools it registers', async () => {
	const calls: Array<{ tool: string; args: unknown }> = []
	const integrationGet = async (args: unknown) => {
		calls.push({ tool: 'integrationGet', args })
		return { integration: { name: 'x-kodykoala' } }
	}
	const integrationTokenRefresh = async (args: unknown) => {
		calls.push({ tool: 'integrationTokenRefresh', args })
		return { ok: true, refreshedAt: '2026-09-23T00:00:00.000Z' }
	}
	const valueSet = async () => ({ wrote: true })
	const removal = async () => {
		throw new Error(removedValueWriteMessage)
	}
	const aliased = aliasSnakeCaseKodyTools({
		integrationGet,
		integrationTokenRefresh,
		search: async () => ({ ok: true }),
		value_set: removal,
		valueSet,
	})

	expect(aliased.integration_get).toBe(integrationGet)
	expect(aliased.integration_token_refresh).toBe(integrationTokenRefresh)
	expect(aliased.search).toBeTypeOf('function')
	expect(aliased).not.toHaveProperty('search_')
	expect(Object.hasOwn(aliased, 'search')).toBe(true)
	expect(Object.keys(aliased).filter((name) => name === 'search')).toEqual([
		'search',
	])
	expect(aliased.value_set).toBe(removal)
	expect(aliased.valueSet).toBe(valueSet)

	const dispatchers = createToolDispatchers([{ name: 'kody', fns: aliased }], {
		active: true,
	})
	const snakeCase = JSON.parse(
		(await dispatchers.kody?.call(
			'integration_get',
			JSON.stringify({ name: 'x-kodykoala' }),
		)) ?? '{}',
	)
	const camelCase = JSON.parse(
		(await dispatchers.kody?.call(
			'integrationGet',
			JSON.stringify({ name: 'x' }),
		)) ?? '{}',
	)
	const refresh = JSON.parse(
		(await dispatchers.kody?.call(
			'integration_token_refresh',
			JSON.stringify({ name: 'x-kodykoala' }),
		)) ?? '{}',
	)
	const missing = JSON.parse(
		(await dispatchers.kody?.call('integration_missing', '{}')) ?? '{}',
	)
	const removed = JSON.parse(
		(await dispatchers.kody?.call('value_set', '{}')) ?? '{}',
	)

	expect(snakeCase).toEqual({
		result: { integration: { name: 'x-kodykoala' } },
	})
	expect(camelCase).toEqual({
		result: { integration: { name: 'x-kodykoala' } },
	})
	expect(refresh).toEqual({
		result: { ok: true, refreshedAt: '2026-09-23T00:00:00.000Z' },
	})
	expect(missing).toEqual({ error: 'Tool "integration_missing" not found' })
	expect(removed).toEqual({ error: removedValueWriteMessage })
	expect(calls).toEqual([
		{ tool: 'integrationGet', args: { name: 'x-kodykoala' } },
		{ tool: 'integrationGet', args: { name: 'x' } },
		{ tool: 'integrationTokenRefresh', args: { name: 'x-kodykoala' } },
	])

	const tools = await buildKodyFns(
		{} as Env,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: { userId: 'user-123' },
		}),
		{
			skipCapabilityRegistry: true,
			additionalTools: { integrationGet, integrationTokenRefresh },
		},
	)
	expect(tools.integration_get).toBe(tools.integrationGet)
	expect(tools.integration_token_refresh).toBe(tools.integrationTokenRefresh)
	await expect(tools.value_set?.({})).rejects.toThrow(removedValueWriteMessage)

	expect(
		resolveKodyCapabilityName('integration_get', { integrationGet: true }),
	).toBe('integrationGet')
	expect(
		resolveKodyCapabilityName('integrationGet', { integrationGet: true }),
	).toBe('integrationGet')
	expect(resolveKodyCapabilityName('value_set', { integrationGet: true })).toBe(
		'value_set',
	)
	expect(resolveKodyCapabilityName('integration_missing', {})).toBe(
		'integration_missing',
	)
})
