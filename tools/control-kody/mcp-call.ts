import { readFile } from 'node:fs/promises'
import {
	connectAppMcpClient,
	usernameFromEmail,
	type AppAuthUser,
} from '../mcp-oauth-client.ts'
import { isProductionKodyOrigin } from './package-create.ts'
import {
	defaultMcpCallOptions,
	readExecuteResult,
	readSearchResult,
	type McpCallConnection,
} from './mcp-tool-result.ts'

export type AppMcpCallReport = {
	ok: true
	tool: 'execute' | 'search'
	result: unknown
	cookieHeader: string
}

export async function readJsonObjectFile(filePath: string) {
	const raw = await readFile(filePath, 'utf8')
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (error) {
		throw new Error(
			`Could not parse JSON from ${filePath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${filePath} must contain a JSON object.`)
	}
	return parsed as Record<string, unknown>
}

export async function executeAppMcp(input: {
	origin: string
	email: string
	password: string
	code: string
	params?: Record<string, unknown>
	connect?: (origin: string, user: AppAuthUser) => Promise<McpCallConnection>
}): Promise<AppMcpCallReport> {
	if (isProductionKodyOrigin(input.origin)) {
		throw new Error('execute refuses to run against https://kody.codes')
	}
	return callAppMcpTool({
		origin: input.origin,
		email: input.email,
		password: input.password,
		tool: 'execute',
		arguments: {
			code: input.code,
			...(input.params ? { params: input.params } : {}),
		},
		readResult: readExecuteResult,
		connect: input.connect,
	})
}

export async function searchAppMcp(input: {
	origin: string
	email: string
	password: string
	query?: string
	domain?: string
	entity?: string
	limit?: number
	connect?: (origin: string, user: AppAuthUser) => Promise<McpCallConnection>
}): Promise<AppMcpCallReport> {
	if (isProductionKodyOrigin(input.origin)) {
		throw new Error('search refuses to run against https://kody.codes')
	}
	const arguments_: Record<string, unknown> = {}
	if (input.query) arguments_.query = input.query
	if (input.domain) arguments_.domain = input.domain
	if (input.entity) arguments_.entity = input.entity
	if (input.limit !== undefined) arguments_.limit = input.limit
	return callAppMcpTool({
		origin: input.origin,
		email: input.email,
		password: input.password,
		tool: 'search',
		arguments: arguments_,
		readResult: readSearchResult,
		connect: input.connect,
	})
}

async function callAppMcpTool(input: {
	origin: string
	email: string
	password: string
	tool: 'execute' | 'search'
	arguments: Record<string, unknown>
	readResult: (toolResult: unknown) => unknown
	connect?: (origin: string, user: AppAuthUser) => Promise<McpCallConnection>
}): Promise<AppMcpCallReport> {
	const user: AppAuthUser = {
		email: input.email,
		password: input.password,
		username: usernameFromEmail(input.email),
	}
	const connect = input.connect ?? connectAppMcpClient
	const connection = await connect(input.origin, user)
	try {
		const toolResult = await connection.client.callTool(
			{
				name: input.tool,
				arguments: input.arguments,
			},
			defaultMcpCallOptions,
		)
		return {
			ok: true,
			tool: input.tool,
			result: input.readResult(toolResult),
			cookieHeader: connection.cookieHeader,
		}
	} finally {
		await connection[Symbol.asyncDispose]?.()
	}
}

export function formatMcpCallReport(report: AppMcpCallReport) {
	if (typeof report.result === 'string') return report.result
	return JSON.stringify(report.result, null, 2)
}
