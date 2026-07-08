import { expect, test } from 'vitest'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	assignRoleInMcpTestDatabase,
	createMcpClient,
	createTestDatabase,
	startDevServer,
} from '../../../../tools/mcp-test-support.ts'

/**
 * MCP E2E is intentionally tiny.
 *
 * Do not add cases here unless the thing being tested genuinely requires the
 * real MCP HTTP transport and OAuth flow all at once. Most capability behavior
 * belongs in faster node/workers tests beside the implementation. Keep this
 * file to a couple of smoke journeys.
 */

test('mcp endpoint requires OAuth bearer auth', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)

	const response = await fetch(new URL('/mcp', server.origin), {
		headers: {
			Accept: 'application/json, text/event-stream',
		},
	})

	expect(response.status).toBe(401)
	const authenticateHeader = response.headers.get('WWW-Authenticate') ?? ''
	expect(authenticateHeader).toMatch(/^Bearer\s+/)
})

test('authenticated MCP search shows admin capabilities only to admin users', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	const regularUser = {
		email: 'jane@example.com',
		username: 'jane',
		password: 'ilikecode',
	}
	await using regularClient = await createMcpClient(
		server.origin,
		regularUser,
		{ persistDir: database.persistDir },
	)

	const regularSearch = await regularClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'admin users roles audit',
			limit: 10,
		},
	})
	const regularMatches =
		(
			(regularSearch as CallToolResult).structuredContent as {
				result?: { matches?: Array<{ id?: string }> }
			}
		)?.result?.matches ?? []
	expect(regularMatches.some((match) => match.id === 'admin_user_list')).toBe(
		false,
	)

	await using bootstrapClient = await createMcpClient(
		server.origin,
		database.user,
		{ persistDir: database.persistDir },
	)
	void bootstrapClient
	await assignRoleInMcpTestDatabase({
		persistDir: database.persistDir,
		email: database.user.email,
		role: 'admin',
	})
	await using adminClient = await createMcpClient(
		server.origin,
		database.user,
		{ persistDir: database.persistDir },
	)

	const adminSearch = await adminClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'admin users roles audit',
			limit: 10,
		},
	})
	const adminMatches =
		(
			(adminSearch as CallToolResult).structuredContent as {
				result?: { matches?: Array<{ id?: string }> }
			}
		)?.result?.matches ?? []
	expect(adminMatches.some((match) => match.id === 'admin_user_list')).toBe(
		true,
	)
})
