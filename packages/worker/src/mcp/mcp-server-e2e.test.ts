import { afterAll, beforeAll, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
	auth,
	type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
	type OAuthClientInformationMixed,
	type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
	type CallToolResult,
	type ContentBlock,
} from '@modelcontextprotocol/sdk/types.js'
import getPort from 'get-port'
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeClaudeWidgetDomain } from '#mcp/apps/claude-widget-domain.ts'
import {
	captureOutput,
	nodeBin,
	readOutput,
	spawnProcess,
	stopProcess,
	type SpawnedProcess,
} from '#mcp/test-process.ts'

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const migrationsDir = join(projectRoot, 'packages/worker/migrations')
const generatedUiResourceUri = 'ui://generated-ui-shell/entry-point.html'
const workerConfig = 'packages/worker/wrangler.jsonc'
const workerEnvFile = 'packages/worker/.env'
const primaryUserEmail = 'me@kentcdodds.com'
const primaryUserPassword = 'iliketwix'
const primaryUser = {
	email: primaryUserEmail,
	password: primaryUserPassword,
} as const

const passwordHashPrefix = 'pbkdf2_sha256'
const passwordSaltBytes = 16
const passwordHashBytes = 32
const passwordHashIterations = 100_000

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function toHex(bytes: Uint8Array) {
	return Array.from(bytes)
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('')
}

async function createPasswordHash(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(passwordSaltBytes))
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	)
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt,
			iterations: passwordHashIterations,
			hash: 'SHA-256',
		},
		key,
		passwordHashBytes * 8,
	)
	return `${passwordHashPrefix}$${passwordHashIterations}$${toHex(salt)}$${toHex(
		new Uint8Array(derivedBits),
	)}`
}

function escapeSql(value: string) {
	return value.replace(/'/g, "''")
}

async function runWrangler(args: Array<string>) {
	const proc = spawnProcess({
		cmd: [
			nodeBin,
			`--env-file=${workerEnvFile}`,
			'./wrangler-env.ts',
			'--config',
			workerConfig,
			...args,
		],
		cwd: projectRoot,
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		readOutput(proc.stdout),
		readOutput(proc.stderr),
		proc.exited,
	])
	if (exitCode !== 0) {
		throw new Error(
			`wrangler ${args.join(' ')} failed (${exitCode}). ${stderr || stdout}`,
		)
	}
	return { stdout, stderr }
}

type TestDatabase = {
	persistDir: string
	user: typeof primaryUser
	[Symbol.asyncDispose]: () => Promise<void>
}

let baselineDatabase: TestDatabase | null = null

async function createSeededTestDatabase(): Promise<TestDatabase> {
	const persistDir = await mkdtemp(join(tmpdir(), 'kody-mcp-e2e-'))
	await applyMigrations(persistDir)

	const passwordHash = await createPasswordHash(primaryUser.password)
	const username = primaryUser.email.split('@')[0] || 'user'
	const insertSql = `INSERT INTO users (username, email, password_hash) VALUES ('${escapeSql(
		username,
	)}', '${escapeSql(primaryUser.email)}', '${escapeSql(passwordHash)}');`

	await runWrangler([
		'd1',
		'execute',
		'APP_DB',
		'--local',
		'--env',
		'test',
		'--persist-to',
		persistDir,
		'--command',
		insertSql,
	])

	return {
		persistDir,
		user: primaryUser,
		[Symbol.asyncDispose]: async () => {
			await rm(persistDir, { recursive: true, force: true })
		},
	}
}

function getBaselineDatabase(): TestDatabase {
	if (!baselineDatabase) {
		throw new Error('Baseline MCP test database has not been initialized.')
	}
	return baselineDatabase
}

async function createTestDatabase(): Promise<TestDatabase> {
	const cloneRootDir = await mkdtemp(join(tmpdir(), 'kody-mcp-e2e-clone-'))
	const persistDir = join(cloneRootDir, 'persist')
	await cp(getBaselineDatabase().persistDir, persistDir, { recursive: true })

	return {
		persistDir,
		user: primaryUser,
		[Symbol.asyncDispose]: async () => {
			await rm(cloneRootDir, { recursive: true, force: true })
		},
	}
}

beforeAll(async () => {
	baselineDatabase = await createSeededTestDatabase()
}, 30_000)

afterAll(async () => {
	const database = baselineDatabase
	baselineDatabase = null
	if (!database) return
	await rm(database.persistDir, { recursive: true, force: true })
}, 30_000)

async function applyMigrations(persistDir: string) {
	const migrationFiles = await listMigrationFiles()
	if (migrationFiles.length === 0) {
		throw new Error('No migration files found in migrations directory.')
	}

	for (const migrationFile of migrationFiles) {
		await runWrangler([
			'd1',
			'execute',
			'APP_DB',
			'--local',
			'--env',
			'test',
			'--persist-to',
			persistDir,
			'--file',
			join('packages/worker/migrations', migrationFile),
		])
	}
}

async function listMigrationFiles() {
	const entries = await readdir(migrationsDir, { withFileTypes: true })
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right))
}

function formatOutput(stdout: string, stderr: string) {
	const snippets: Array<string> = []
	if (stdout.trim()) {
		snippets.push(`stdout: ${stdout.trim().slice(-2000)}`)
	}
	if (stderr.trim()) {
		snippets.push(`stderr: ${stderr.trim().slice(-2000)}`)
	}
	return snippets.length > 0 ? ` Output:\n${snippets.join('\n')}` : ''
}

async function waitForServer(
	origin: string,
	proc: SpawnedProcess,
	getStdout: () => string,
	getStderr: () => string,
) {
	let exited = false
	let exitCode: number | null = null
	void proc.exited
		.then((code) => {
			exited = true
			exitCode = code
		})
		.catch(() => {
			exited = true
		})

	const metadataUrl = new URL('/.well-known/oauth-protected-resource', origin)
	const deadline = Date.now() + 25_000
	while (Date.now() < deadline) {
		if (exited) {
			throw new Error(
				`wrangler dev exited (${exitCode ?? 'unknown'}).${formatOutput(
					getStdout(),
					getStderr(),
				)}`,
			)
		}
		try {
			const response = await fetch(metadataUrl)
			if (response.ok) {
				await response.body?.cancel()
				return
			}
		} catch {
			// Retry until the server is ready.
		}
		await delay(250)
	}

	throw new Error(
		`Timed out waiting for dev server at ${origin}.${formatOutput(
			getStdout(),
			getStderr(),
		)}`,
	)
}

async function startDevServer(persistDir: string) {
	const port = await getPort({ host: '127.0.0.1' })
	const inspectorPortBase =
		port + 10_000 <= 65_535 ? port + 10_000 : Math.max(1, port - 10_000)
	const inspectorPort = await getPort({
		host: '127.0.0.1',
		port: Array.from(
			{ length: 10 },
			(_, index) => inspectorPortBase + index,
		).filter((candidate) => candidate > 0 && candidate <= 65_535),
	})
	const origin = `http://127.0.0.1:${port}`
	const proc = spawnProcess({
		cmd: [
			nodeBin,
			`--env-file=${workerEnvFile}`,
			'./wrangler-env.ts',
			'--config',
			workerConfig,
			'dev',
			'--local',
			'--env',
			'test',
			'--port',
			String(port),
			'--inspector-port',
			String(inspectorPort),
			'--ip',
			'127.0.0.1',
			'--persist-to',
			persistDir,
			'--show-interactive-dev-session=false',
			'--log-level',
			'error',
		],
		cwd: projectRoot,
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'test',
		},
	})

	const getStdout = captureOutput(proc.stdout)
	const getStderr = captureOutput(proc.stderr)

	await waitForServer(origin, proc, getStdout, getStderr)

	return {
		origin,
		[Symbol.asyncDispose]: async () => {
			await stopProcess(proc)
		},
	}
}

async function authorizeWithPassword(
	authorizationUrl: URL,
	user: { email: string; password: string },
	options: { simulateInteractiveAuthorize?: boolean } = {},
) {
	if (options.simulateInteractiveAuthorize) {
		const authorizeInfoUrl = new URL('/oauth/authorize-info', authorizationUrl)
		authorizeInfoUrl.search = authorizationUrl.search
		const authorizeInfoResponse = await fetch(authorizeInfoUrl, {
			headers: { Accept: 'application/json' },
		})
		const authorizeInfoPayload = (await authorizeInfoResponse
			.json()
			.catch(() => null)) as unknown
		const authorizeInfo =
			authorizeInfoPayload &&
			typeof authorizeInfoPayload === 'object' &&
			'ok' in authorizeInfoPayload
				? (authorizeInfoPayload as { ok?: unknown })
				: null
		if (!authorizeInfoResponse.ok || authorizeInfo?.ok !== true) {
			throw new Error(
				`OAuth authorize-info failed (${authorizeInfoResponse.status}). ${JSON.stringify(authorizeInfoPayload)}`,
			)
		}
	}

	const response = await fetch(authorizationUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		},
		body: new URLSearchParams({
			decision: 'approve',
			email: user.email,
			password: user.password,
		}),
	})
	const payload = (await response.json().catch(() => null)) as unknown

	if (!response.ok || !payload || typeof payload !== 'object') {
		throw new Error(
			`OAuth approval failed (${response.status}). ${JSON.stringify(payload)}`,
		)
	}

	const approval = payload as { ok?: unknown; redirectTo?: unknown }
	if (approval.ok !== true || typeof approval.redirectTo !== 'string') {
		throw new Error(
			`OAuth approval failed (${response.status}). ${JSON.stringify(payload)}`,
		)
	}

	const redirectUrl = new URL(approval.redirectTo)
	const code = redirectUrl.searchParams.get('code')
	if (!code) {
		throw new Error('Authorization response missing code.')
	}
	return code
}

type TestOAuthProvider = OAuthClientProvider & {
	waitForAuthorizationCode: () => Promise<string>
}

function createOAuthProvider({
	redirectUrl,
	clientMetadata,
	authorize,
}: {
	redirectUrl: URL
	clientMetadata: OAuthClientProvider['clientMetadata']
	authorize: (authorizationUrl: URL) => Promise<string>
}): TestOAuthProvider {
	let clientInformation: OAuthClientInformationMixed | undefined
	let tokens: OAuthTokens | undefined
	let codeVerifier: string | undefined
	let authorizationCode: Promise<string> | undefined

	return {
		redirectUrl,
		clientMetadata,
		clientInformation() {
			return clientInformation
		},
		saveClientInformation(nextClientInfo) {
			clientInformation = nextClientInfo
		},
		tokens() {
			return tokens
		},
		saveTokens(nextTokens) {
			tokens = nextTokens
		},
		redirectToAuthorization(authorizationUrl) {
			authorizationCode = authorize(authorizationUrl)
		},
		saveCodeVerifier(nextCodeVerifier) {
			codeVerifier = nextCodeVerifier
		},
		codeVerifier() {
			if (!codeVerifier) {
				throw new Error('No code verifier saved')
			}
			return codeVerifier
		},
		async waitForAuthorizationCode() {
			if (!authorizationCode) {
				throw new Error('Authorization flow was not started')
			}
			return authorizationCode
		},
	}
}

async function ensureAuthorized(
	serverUrl: URL,
	transport: StreamableHTTPClientTransport,
	provider: TestOAuthProvider,
) {
	const result = await auth(provider, { serverUrl })
	if (result === 'AUTHORIZED') {
		return
	}
	const authorizationCode = await provider.waitForAuthorizationCode()
	await transport.finishAuth(authorizationCode)
}

async function createMcpClient(
	origin: string,
	user: { email: string; password: string },
	options: { simulateInteractiveAuthorize?: boolean } = {},
) {
	const redirectUrl = new URL('/oauth/callback', origin)
	const provider = createOAuthProvider({
		redirectUrl,
		clientMetadata: {
			client_name: 'mcp-e2e-client',
			redirect_uris: [redirectUrl.toString()],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'client_secret_post',
		},
		authorize: (authorizationUrl) =>
			authorizeWithPassword(authorizationUrl, user, options),
	})
	const serverUrl = new URL('/mcp', origin)
	const transport = new StreamableHTTPClientTransport(serverUrl, {
		authProvider: provider,
	})
	const client = new Client(
		{ name: 'mcp-e2e', version: '1.0.0' },
		{ capabilities: {} },
	)

	await ensureAuthorized(serverUrl, transport, provider)
	await client.connect(transport)

	return {
		client,
		[Symbol.asyncDispose]: async () => {
			await client.close()
		},
	}
}

test('mcp server lists tools after interactive oauth authorize flow', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user, {
		simulateInteractiveAuthorize: true,
	})

	const result = await mcpClient.client.listTools()
	const toolNames = result.tools.map((tool) => tool.name)

	expect(toolNames.sort()).toEqual(['execute', 'open_generated_ui', 'search'])
})

test('mcp server lists tools after oauth flow', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const instructions = mcpClient.client.getInstructions() ?? ''
	expect(instructions).toContain('Quick start')
	expect(instructions).toContain('github.com/kentcdodds/kody')

	const result = await mcpClient.client.listTools()
	const toolNames = result.tools.map((tool) => tool.name)

	expect(toolNames.sort()).toEqual(['execute', 'open_generated_ui', 'search'])

	const resourcesResult = await mcpClient.client.listResources()
	const resourceUris = resourcesResult.resources.map((resource) => resource.uri)

	expect(resourceUris).toContain(generatedUiResourceUri)
})

test('mcp server searches capabilities', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'save reusable generated ui artifact and reopen app by id',
			limit: 15,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: {
					matches?: Array<Record<string, unknown>>
					offline?: boolean
				}
		  }
		| undefined
	const searchPayload = structuredResult?.result as
		| Record<string, unknown>
		| undefined
	const matches = searchPayload?.matches as
		| Array<Record<string, unknown>>
		| undefined

	expect(searchPayload?.offline).toBe(true)
	const saveApp = matches?.find(
		(m) => m.type === 'capability' && m.name === 'ui_save_app',
	)
	expect(saveApp?.domain).toBe('apps')
	expect(saveApp?.requiredInputFields).toEqual([
		'title',
		'description',
		'keywords',
		'code',
	])
	expect(saveApp?.readOnly).toBeUndefined()
	expect(saveApp?.inputFields).toBeUndefined()

	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

	expect(textOutput).toContain('ui_save_app')
})

test('mcp server search detail mode includes schema field descriptions', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'load saved app artifact source code runtime app_id',
			limit: 5,
			detail: true,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: {
					matches?: Array<Record<string, unknown>>
					offline?: boolean
				}
		  }
		| undefined
	const searchPayload = structuredResult?.result as
		| Record<string, unknown>
		| undefined
	const searchResult = searchPayload?.matches as
		| Array<Record<string, unknown>>
		| undefined
	const capability = searchResult?.find(
		(m) => m.type === 'capability' && m.name === 'ui_get_app',
	)
	const inputSchema = capability?.inputSchema as
		| Record<string, unknown>
		| undefined
	const outputSchema = capability?.outputSchema as
		| Record<string, unknown>
		| undefined
	const inputProperties = inputSchema?.properties as
		| Record<string, Record<string, unknown>>
		| undefined
	const outputProperties = outputSchema?.properties as
		| Record<string, Record<string, unknown>>
		| undefined

	expect(capability?.type).toBe('capability')
	expect(capability?.name).toBe('ui_get_app')
	expect(capability?.keywords).toEqual(
		expect.arrayContaining(['app', 'ui', 'artifact']),
	)
	expect(capability?.inputFields).toBeUndefined()
	expect(capability?.outputFields).toBeUndefined()
	expect(capability?.requiredInputFields).toEqual(['app_id'])
	expect(inputProperties?.app_id?.description).toBe(
		'Saved UI artifact id returned by ui_save_app.',
	)
	expect(outputProperties?.code?.description).toBe(
		'Generated UI source code to render inside the generic shell.',
	)
})

test('mcp server search returns Cloudflare capability results', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'cloudflare dns zones workers api docs markdown',
			limit: 10,
			detail: true,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: {
					matches?: Array<Record<string, unknown>>
					offline?: boolean
				}
		  }
		| undefined
	const searchPayload = structuredResult?.result as
		| Record<string, unknown>
		| undefined
	const matches = searchPayload?.matches as
		| Array<Record<string, unknown>>
		| undefined

	expect(searchPayload?.offline).toBe(true)
	expect(
		matches?.some(
			(match) =>
				match.type === 'capability' && match.name === 'cloudflare_rest',
		),
	).toBe(true)
	expect(
		matches?.some(
			(match) =>
				match.type === 'capability' && match.name === 'cloudflare_api_docs',
		),
	).toBe(true)

	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	expect(textOutput).toContain('cloudflare_rest')
	expect(textOutput).toContain('cloudflare_api_docs')
})

test('mcp server executes ui_save_app via execute tool', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Execute generated app',
						description: 'Saved through execute.',
						keywords: ['execute', 'ui'],
						code: '<main><h1>Execute App</h1></main>',
					})`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const executeResult = structuredResult?.result as
		| Record<string, unknown>
		| undefined
	expect(typeof executeResult?.app_id).toBe('string')
	expect(executeResult?.hosted_url).toBe(
		`${server.origin}/ui/${executeResult?.app_id}`,
	)

	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

	expect(textOutput).toContain('app_id')
	expect(textOutput).toContain('hosted_url')
	expect(textOutput).toContain('meta_save_skill')
})

test('mcp server opens generated ui with inline code and serves shell resource', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			code: '<main><h1>Hello Shell</h1><p>Inline app content.</p></main>',
			title: 'Inline Hello',
			description: 'Inline render test.',
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| Record<string, unknown>
		| undefined
	expect(structuredResult?.renderSource).toBe('inline_code')
	expect(structuredResult?.resourceUri).toBe(generatedUiResourceUri)

	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	expect(textOutput).toContain('Generated UI ready')

	const resourceResult = await mcpClient.client.readResource({
		uri: generatedUiResourceUri,
	})
	const generatedResource = resourceResult.contents.find(
		(content): content is { uri: string; mimeType?: string; text: string } =>
			content.uri === generatedUiResourceUri &&
			'text' in content &&
			typeof content.text === 'string',
	)
	const generatedResourceMeta = (
		resourceResult.contents.find(
			(content) => content.uri === generatedUiResourceUri,
		) as { _meta?: Record<string, unknown> } | undefined
	)?._meta as
		| {
				ui?: {
					domain?: string
					csp?: {
						resourceDomains?: Array<string>
					}
				}
				'openai/widgetDomain'?: string
		  }
		| undefined

	expect(generatedResource).toBeDefined()
	expect(generatedResource?.mimeType).toBe('text/html;profile=mcp-app')
	expect(generatedResource?.text).toContain('data-generated-ui-frame')
	expect(generatedResource?.text).not.toContain('Toggle fullscreen')
	expect(generatedResource?.text).not.toContain('Open saved app link')
	expect(generatedResource?.text).toContain('type="module"')
	expect(generatedResource?.text).toContain('/mcp-apps/generated-ui-shell.js')

	const generatedShellResponse = await fetch(
		new URL('/mcp-apps/generated-ui-shell.js', server.origin),
	)
	expect(generatedShellResponse.ok).toBe(true)
	expect(
		generatedShellResponse.headers.get('access-control-allow-origin'),
	).toBe('*')
	const generatedShellSource = await generatedShellResponse.text()
	expect(generatedShellSource).toContain('createWidgetHostBridge')
	expect(generatedShellSource).toContain('ui/initialize')
	expect(generatedShellSource).toContain('ui/message')
	expect(generatedShellSource).toContain('ui/request-display-mode')
	expect(generatedShellSource).toContain('ui/open-link')
	expect(generatedShellSource).toContain('executeCode')
	expect(generatedShellSource).toContain('tools/call')

	expect(generatedResourceMeta?.ui?.domain).toBe(
		await computeClaudeWidgetDomain(new URL('/mcp', server.origin).toString()),
	)
	expect(generatedResourceMeta?.['openai/widgetDomain']).toBe(server.origin)
	expect(generatedResourceMeta?.ui?.csp?.resourceDomains).toContain(
		server.origin,
	)
})

test('mcp server saves app, search returns app hit, and open_generated_ui supports app_id', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Saved Searchable App',
						description: 'Saved generated UI artifact for search and reopen.',
						keywords: ['saved', 'searchable', 'ui'],
						code: '<main><h1>Saved Searchable App</h1></main>',
						search_text: 'searchable saved ui artifact demo',
					})`,
		},
	})

	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const savedApp = saveStructured?.result as Record<string, unknown> | undefined
	const appId = typeof savedApp?.app_id === 'string' ? savedApp.app_id : null
	expect(appId).not.toBeNull()

	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'searchable saved ui artifact demo',
			limit: 10,
			detail: true,
		},
	})
	const searchStructured = (searchResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const searchPayload = searchStructured?.result as
		| Record<string, unknown>
		| undefined
	const matches = searchPayload?.matches as
		| Array<Record<string, unknown>>
		| undefined
	const appMatch = matches?.find(
		(match) => match.type === 'app' && match.appId === appId,
	)
	expect(appMatch?.title).toBe('Saved Searchable App')
	expect(appMatch?.usage).toContain('open_generated_ui')

	const openResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: appId,
		},
	})
	const openStructured = (openResult as CallToolResult).structuredContent as
		| Record<string, unknown>
		| undefined
	expect(openStructured?.renderSource).toBe('saved_app')
	expect(openStructured?.appId).toBe(appId)
	expect(openStructured?.resourceUri).toBe(generatedUiResourceUri)
	expect(openStructured?.hostedUrl).toBe(`${server.origin}/ui/${appId}`)
	const openText =
		(openResult as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''
	expect(openText).toContain(`${server.origin}/ui/${appId}`)
})

test('generated ui session endpoints support source, execute, and secure input', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Session Endpoint App',
						description: 'Saved app for generated UI endpoint tests.',
						keywords: ['session', 'endpoint', 'ui'],
						code: '<main><h1>Session Endpoint App</h1></main>',
						search_text: 'generated ui session endpoint app',
					})`,
		},
	})
	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const savedApp = saveStructured?.result as Record<string, unknown> | undefined
	const appId = typeof savedApp?.app_id === 'string' ? savedApp.app_id : null
	expect(appId).not.toBeNull()

	const openResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: appId,
		},
	})
	const openStructured = (openResult as CallToolResult).structuredContent as
		| {
				appSession?: {
					token?: string
					endpoints?: {
						appSource?: string
						action?: string
						secureInput?: string
					}
				}
		  }
		| undefined
	const appSession = openStructured?.appSession
	const token = appSession?.token ?? null
	const appSourceUrl = appSession?.endpoints?.appSource ?? null
	const actionUrl = appSession?.endpoints?.action ?? null
	const secureInputUrl = appSession?.endpoints?.secureInput ?? null
	expect(token).not.toBeNull()
	expect(appSourceUrl).toContain('/ui-api/')
	expect(actionUrl).toContain('/ui-api/')
	expect(secureInputUrl).toContain('/ui-api/')

	async function fetchSessionJson(url: string, init?: RequestInit) {
		const response = await fetch(url, {
			...init,
			headers: {
				Accept: 'application/json',
				Authorization: `Bearer ${token}`,
				...(init?.headers ?? {}),
			},
		})
		const payload = (await response.json().catch(() => null)) as
			| Record<string, unknown>
			| null
		return { response, payload }
	}

	const sourceRequestUrl = new URL(appSourceUrl ?? server.origin)
	sourceRequestUrl.searchParams.set('app_id', appId ?? '')
	const { response: sourceResponse, payload: sourcePayload } =
		await fetchSessionJson(sourceRequestUrl.toString())
	expect(sourceResponse.ok).toBe(true)
	expect((sourcePayload?.app as { app_id?: string } | undefined)?.app_id).toBe(
		appId,
	)
	expect((sourcePayload?.app as { code?: string } | undefined)?.code).toContain(
		'Session Endpoint App',
	)

	const { response: executeResponse, payload: executePayload } =
		await fetchSessionJson(actionUrl ?? server.origin, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				code: 'async (params) => ({ greeting: `Hello ${params.name}` })',
				params: { name: 'Kody' },
			}),
		})
	expect(executeResponse.ok).toBe(true)
	expect(executePayload?.result).toEqual({ greeting: 'Hello Kody' })

	const setupCode = `async () =>
		await codemode.connections_begin_setup({
			provider: {
				key: 'demo-provider',
				display_name: 'Demo Provider',
			},
			auth: {
				strategy: 'manual_token',
				instructions: ['Enter a token'],
				secret_fields: [
					{
						name: 'api_key',
						label: 'API Key',
						input_type: 'password',
					},
				],
				request: {
					base_url: 'https://example.com',
					auth_transport: {
						type: 'api_key_header',
						header_name: 'x-api-key',
					},
				},
			},
		})`
	const { response: setupResponse, payload: setupPayload } = await fetchSessionJson(
		actionUrl ?? server.origin,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				code: setupCode,
			}),
		},
	)
	expect(setupResponse.ok).toBe(true)
	const setupId = (setupPayload?.result as { setup_id?: string } | undefined)
		?.setup_id
	expect(setupId).toBeTruthy()

	const { response: secureInputResponse, payload: secureInputPayload } =
		await fetchSessionJson(secureInputUrl ?? server.origin, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				setup_id: setupId,
				fields: {
					api_key: 'demo-secret',
				},
			}),
		})
	expect(secureInputResponse.ok).toBe(true)
	expect(secureInputPayload?.stored_secret_names).toEqual(['api_key'])
	expect(secureInputPayload?.status).toBe('ready_to_finalize')
})

test('mcp server deletes saved ui app artifacts', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Delete Me App',
						description: 'Saved app to delete.',
						keywords: ['delete', 'ui'],
						code: '<main><h1>Delete Me</h1></main>',
					})`,
		},
	})
	const saveStructured = (saveResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const savedApp = saveStructured?.result as Record<string, unknown> | undefined
	const appId = typeof savedApp?.app_id === 'string' ? savedApp.app_id : null
	expect(appId).not.toBeNull()

	const deleteResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_delete_app({ app_id: ${JSON.stringify(appId)} })`,
		},
	})
	const deleteStructured = (deleteResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const deletePayload = deleteStructured?.result as
		| Record<string, unknown>
		| undefined
	expect(deletePayload?.deleted).toBe(true)
	expect(deletePayload?.app_id).toBe(appId)

	const listResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => await codemode.ui_list_apps({})`,
		},
	})
	const listStructured = (listResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const listPayload = listStructured?.result as
		| Record<string, unknown>
		| undefined
	const apps = listPayload?.apps as Array<{ app_id?: string }> | undefined
	expect(apps?.some((app) => app.app_id === appId)).toBe(false)
})
