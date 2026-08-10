import { expect, test } from 'vitest'
import {
	createModernMcpClient,
	createTestDatabase,
	startDevServer,
} from '../../../../tools/mcp-test-support.ts'
import { executeProgressPhaseMessages } from './progress.ts'

/**
 * One smoke journey for the stateless 2026-07-28 lane: a real SDK v2 client
 * pinned to the modern revision negotiates over HTTP with OAuth and calls a
 * tool. Everything else about lane behavior is covered by faster node and
 * workers tests beside the implementation (`mcp-auth.workers.test.ts`,
 * `protocol-metrics.node.test.ts`).
 */

test('pinned 2026-07-28 client negotiates the stateless lane and calls search', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using modern = await createModernMcpClient(
		server.origin,
		database.user,
		{ persistDir: database.persistDir },
	)

	const tools = await modern.client.listTools()
	const toolNames = tools.tools.map((tool) => tool.name).sort()
	expect(toolNames).toEqual(['execute', 'search'])
	const searchTool = tools.tools.find((tool) => tool.name === 'search')
	expect(searchTool?.outputSchema).toMatchObject({ type: 'object' })

	const searchResult = await modern.client.callTool({
		name: 'search',
		arguments: { query: 'jobs', limit: 5 },
	})
	expect(searchResult.isError ?? false).toBe(false)
	expect(searchResult.structuredContent).toMatchObject({
		conversationId: expect.any(String),
	})
})

test('stateless lane lists onboarding prompts and emits execute progress', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using modern = await createModernMcpClient(
		server.origin,
		database.user,
		{ persistDir: database.persistDir },
	)

	const prompts = await modern.client.listPrompts()
	const promptNames = prompts.prompts.map((prompt) => prompt.name).sort()
	expect(promptNames).toEqual([
		'onboarding_discovery',
		'onboarding_first_win',
		'onboarding_setup',
	])

	const setupPrompt = await modern.client.getPrompt({
		name: 'onboarding_setup',
	})
	expect(setupPrompt.messages[0]?.content).toMatchObject({
		type: 'text',
		text: expect.stringContaining('Help me get started with Kody.'),
	})

	const progressMessages: Array<string> = []
	const executeResult = await modern.client.callTool(
		{
			name: 'execute',
			arguments: {
				code: `export default async function main() { return { ok: true } }`,
			},
		},
		{
			onprogress: (progress) => {
				if (typeof progress.message === 'string') {
					progressMessages.push(progress.message)
				}
			},
		},
	)
	expect(executeResult.isError ?? false).toBe(false)
	expect(progressMessages.length).toBeGreaterThan(0)
	expect(progressMessages).toContain(executeProgressPhaseMessages.bundle)
	expect(progressMessages).toEqual(
		expect.arrayContaining([
			executeProgressPhaseMessages.hydrate,
			executeProgressPhaseMessages.sandbox,
		]),
	)
})
