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
const generatedUiResourceUri = 'ui://generated-ui-runtime/entry-point.html'
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

async function loginToApp(
	origin: string,
	user: { email: string; password: string },
) {
	const response = await fetch(new URL('/auth', origin), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			mode: 'login',
			email: user.email,
			password: user.password,
		}),
	})
	const cookieHeader = response.headers.get('set-cookie')
	if (!cookieHeader) {
		const body = await response.text().catch(() => '')
		throw new Error(
			`Login did not return a session cookie (${response.status}): ${body}`,
		)
	}
	return cookieHeader.split(';')[0] ?? cookieHeader
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
			limit: 8,
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
			query: 'ui_get_app saved ui artifact source code',
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

test('mcp server returns structured guidance for missing secret errors in execute', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const result = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => {
				await fetch('https://example.com/private', {
					headers: {
						Authorization: 'Bearer {{secret:missingToken|scope=user}}',
					},
				})
				return { ok: true }
			}`,
		},
	})

	const structuredResult = (result as CallToolResult).structuredContent as
		| {
				error?: unknown
				errorDetails?: Record<string, unknown>
		  }
		| undefined
	const errorDetails = structuredResult?.errorDetails
	const textOutput =
		(result as CallToolResult).content.find(
			(item): item is Extract<ContentBlock, { type: 'text' }> =>
				item.type === 'text',
		)?.text ?? ''

	expect((result as CallToolResult).isError).toBe(true)
	expect(textOutput).toContain('Secret "missingToken" was not found.')
	expect(textOutput).toContain(
		'Next step: Open a generated UI so the user can provide and save this secret, then retry the workflow. Do not ask the user to paste the secret into chat.',
	)
	expect(errorDetails).toEqual({
		kind: 'secret_required',
		message: 'Secret "missingToken" was not found.',
		nextStep:
			'Open a generated UI so the user can provide and save this secret, then retry the workflow. Do not ask the user to paste the secret into chat.',
		secretNames: ['missingToken'],
		suggestedAction: {
			type: 'open_generated_ui',
			reason: 'collect_secret',
		},
	})
})

test('mcp server opens generated ui with inline code and serves runtime resource', async () => {
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
	expect(generatedResource?.text).not.toContain('data-generated-ui-frame')
	expect(generatedResource?.text).toContain('data-generated-ui-root')
	expect(generatedResource?.text).toContain('"mode":"entry"')
	expect(generatedResource?.text).not.toContain('Toggle fullscreen')
	expect(generatedResource?.text).not.toContain('Open saved app link')
	expect(generatedResource?.text).toContain('"@kody/utils"')
	expect(generatedResource?.text).toContain('type="module"')
	expect(generatedResource?.text).toContain('/mcp-apps/generated-ui-runtime.js')

	const generatedShellResponse = await fetch(
		new URL('/mcp-apps/generated-ui-runtime.js', server.origin),
	)
	expect(generatedShellResponse.ok).toBe(true)
	expect(generatedShellResponse.headers.get('content-type')).toContain(
		'javascript',
	)
	const generatedShellSource = await generatedShellResponse.text()
	expect(generatedShellSource).toContain('createWidgetHostBridge')
	expect(generatedShellSource).toContain('ui/initialize')
	expect(generatedShellSource).toContain('ui/message')
	expect(generatedShellSource).toContain('ui/notifications/size-changed')
	expect(generatedShellSource).toContain('ui/request-display-mode')
	expect(generatedShellSource).toContain('ui/open-link')
	expect(generatedShellSource).toContain('executeCode')
	expect(generatedShellSource).toContain('tools/call')

	expect(generatedShellSource).toContain('__kodyGeneratedUiBootstrap')
	expect(generatedShellSource).toContain('__kodyGeneratedUiRuntimeHooks')

	const generatedRuntimeStylesResponse = await fetch(
		new URL('/mcp-apps/generated-ui-runtime.css', server.origin),
	)
	expect(generatedRuntimeStylesResponse.ok).toBe(true)
	expect(generatedRuntimeStylesResponse.headers.get('content-type')).toContain(
		'text/css',
	)
	const generatedRuntimeStyles = await generatedRuntimeStylesResponse.text()
	expect(generatedRuntimeStyles).toContain('[data-generated-ui-root]')
	expect(generatedRuntimeStyles).toContain('--color-bg')

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

test('mcp server supports parameterized saved apps with resolved runtime params', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Parameterized Greeting App',
						description: 'Reusable greeting UI with runtime params.',
						keywords: ['greeting', 'parameterized', 'ui'],
						parameters: [
							{
								name: 'name',
								description: 'Name to greet.',
								type: 'string',
								required: true,
							},
							{
								name: 'showConfetti',
								description: 'Whether to celebrate.',
								type: 'boolean',
								default: false,
							},
						],
						code: '<main><h1>Greeting App</h1></main>',
						search_text: 'parameterized greeting ui app',
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

	const getResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () => await codemode.ui_get_app({ app_id: ${JSON.stringify(appId)} })`,
		},
	})
	const getStructured = (getResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const getPayload = getStructured?.result as
		| Record<string, unknown>
		| undefined
	expect(getPayload?.parameters).toEqual([
		{
			name: 'name',
			description: 'Name to greet.',
			type: 'string',
			required: true,
		},
		{
			name: 'showConfetti',
			description: 'Whether to celebrate.',
			type: 'boolean',
			required: false,
			default: false,
		},
	])

	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'parameterized greeting ui app',
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
	expect(appMatch?.parameters).toEqual([
		{
			name: 'name',
			description: 'Name to greet.',
			type: 'string',
			required: true,
		},
		{
			name: 'showConfetti',
			description: 'Whether to celebrate.',
			type: 'boolean',
			required: false,
			default: false,
		},
	])
	expect(appMatch?.usage).toContain('"params"')

	const openResult = await mcpClient.client.callTool({
		name: 'open_generated_ui',
		arguments: {
			app_id: appId,
			params: {
				name: 'Kent',
				showConfetti: true,
			},
		},
	})
	const openStructured = (openResult as CallToolResult).structuredContent as
		| {
				params?: Record<string, unknown>
				appSession?: {
					token?: string
					endpoints?: {
						source?: string
						execute?: string
					}
				}
		  }
		| undefined
	expect(openStructured?.params).toEqual({
		name: 'Kent',
		showConfetti: true,
	})
	const token =
		typeof openStructured?.appSession?.token === 'string'
			? openStructured.appSession.token
			: null
	const sourceUrl =
		typeof openStructured?.appSession?.endpoints?.source === 'string'
			? openStructured.appSession.endpoints.source
			: null
	const executeUrl =
		typeof openStructured?.appSession?.endpoints?.execute === 'string'
			? openStructured.appSession.endpoints.execute
			: null
	expect(token).not.toBeNull()
	expect(sourceUrl).toContain('/ui-api/')
	expect(executeUrl).toContain('/ui-api/')

	const sourceResponse = await fetch(sourceUrl!, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
		},
	})
	expect(sourceResponse.ok).toBe(true)
	const sourcePayload = (await sourceResponse.json()) as {
		ok?: boolean
		app?: {
			app_id?: string
			parameters?: Array<Record<string, unknown>> | string
			params?: Record<string, unknown>
		}
	}
	expect(sourcePayload.ok).toBe(true)
	expect(sourcePayload.app?.app_id).toBe(appId)
	expect(
		typeof sourcePayload.app?.parameters === 'string'
			? JSON.parse(sourcePayload.app.parameters)
			: sourcePayload.app?.parameters,
	).toEqual([
		{
			name: 'name',
			description: 'Name to greet.',
			type: 'string',
			required: true,
		},
		{
			name: 'showConfetti',
			description: 'Whether to celebrate.',
			type: 'boolean',
			required: false,
			default: false,
		},
	])
	expect(sourcePayload.app?.params).toEqual({
		name: 'Kent',
		showConfetti: true,
	})

	const executeResponse = await fetch(executeUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async (params) => ({
				name: params.name,
				showConfetti: params.showConfetti,
			})`,
		}),
	})
	expect(executeResponse.ok).toBe(true)
	const executePayload = (await executeResponse.json()) as {
		ok?: boolean
		result?: Record<string, unknown>
	}
	expect(executePayload).toMatchObject({
		ok: true,
		result: {
			name: 'Kent',
			showConfetti: true,
		},
	})
})

test('generated ui sessions support secret storage, execute-time resolution, and scoped search visibility', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Secrets App',
						description: 'Generated UI for secret-backed deployments.',
						keywords: ['secret', 'deploy'],
						code: '<main><h1>Secrets App</h1></main>',
						search_text: 'cloudflare deploy secret app',
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
						source?: string
						execute?: string
						secrets?: string
						deleteSecret?: string
					}
				}
		  }
		| undefined
	const appSession = openStructured?.appSession
	const token = typeof appSession?.token === 'string' ? appSession.token : null
	const sourceUrl =
		typeof appSession?.endpoints?.source === 'string'
			? appSession.endpoints.source
			: null
	const executeUrl =
		typeof appSession?.endpoints?.execute === 'string'
			? appSession.endpoints.execute
			: null
	const secretsUrl =
		typeof appSession?.endpoints?.secrets === 'string'
			? appSession.endpoints.secrets
			: null
	const deleteSecretUrl =
		typeof appSession?.endpoints?.deleteSecret === 'string'
			? appSession.endpoints.deleteSecret
			: null
	expect(token).not.toBeNull()
	expect(sourceUrl).toContain('/ui-api/')
	expect(executeUrl).toContain('/ui-api/')
	expect(secretsUrl).toContain('/ui-api/')
	expect(deleteSecretUrl).toContain('/ui-api/')

	const sourceResponse = await fetch(sourceUrl!, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
		},
	})
	expect(sourceResponse.ok).toBe(true)
	const sourcePayload = (await sourceResponse.json()) as {
		ok?: boolean
		app?: {
			app_id?: string
			code?: string
		}
	}
	expect(sourcePayload.ok).toBe(true)
	expect(sourcePayload.app?.app_id).toBe(appId)
	expect(sourcePayload.app?.code).toContain('Secrets App')

	const saveAppSecretResponse = await fetch(secretsUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			name: 'cloudflareToken',
			value: 'secret-app-token',
			description: 'App-scoped Cloudflare deployment token',
			scope: 'app',
		}),
	})
	expect(saveAppSecretResponse.ok).toBe(true)

	const saveUserSecretResponse = await fetch(secretsUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			name: 'globalApiKey',
			value: 'secret-user-token',
			description: 'Reusable cross-app API key',
			scope: 'user',
		}),
	})
	expect(saveUserSecretResponse.ok).toBe(true)

	const saveSessionSecretResponse = await fetch(secretsUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			name: 'ephemeralCode',
			value: '123456',
			description: 'Session-only verification code',
			scope: 'session',
		}),
	})
	const saveSessionSecretRaw = await saveSessionSecretResponse.text()
	const saveSessionSecretPayload = JSON.parse(saveSessionSecretRaw) as {
		ok?: boolean
		secret?: Record<string, unknown>
		error?: string
	}
	expect(
		saveSessionSecretResponse.ok,
		`${saveSessionSecretResponse.status} ${saveSessionSecretRaw}`,
	).toBe(true)
	expect(saveSessionSecretPayload.ok).toBe(true)
	expect(saveSessionSecretPayload.secret).toEqual({
		name: 'ephemeralCode',
		scope: 'session',
		description: 'Session-only verification code',
		app_id: null,
		allowed_hosts: [],
		allowed_capabilities: [],
		created_at: expect.any(String),
		updated_at: expect.any(String),
		ttl_ms: expect.any(Number),
	})

	const executeResponse = await fetch(executeUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				const appSecrets = await codemode.secret_list({ scope: 'app' })
				const userSecrets = await codemode.secret_list({ scope: 'user' })
				const sessionSecrets = await codemode.secret_list({ scope: 'session' })
				const getName = (secret) => (secret && typeof secret === 'object' ? secret.name : null)
				return {
					appSecretNames: appSecrets.secrets.map(getName).filter(Boolean),
					userSecretNames: userSecrets.secrets.map(getName).filter(Boolean),
					sessionSecretNames: sessionSecrets.secrets.map(getName).filter(Boolean),
				}
			}`,
		}),
	})
	if (!executeResponse.ok) {
		throw new Error(await executeResponse.text())
	}
	expect(executeResponse.ok).toBe(true)
	const executePayload = (await executeResponse.json()) as {
		ok?: boolean
		result?: {
			appSecretNames?: Array<string>
			userSecretNames?: Array<string>
			sessionSecretNames?: Array<string>
		}
		logs?: Array<string>
	}
	expect(executePayload.ok).toBe(true)
	expect(executePayload.result?.appSecretNames).toContain('cloudflareToken')
	expect(executePayload.result?.userSecretNames).toContain('globalApiKey')
	expect(executePayload.result?.sessionSecretNames).toContain('ephemeralCode')

	const listSecretsResponse = await fetch(`${secretsUrl!}?scope=app`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/json',
		},
	})
	const listSecretsRaw = await listSecretsResponse.text()
	expect(listSecretsResponse.ok, listSecretsRaw).toBe(true)
	const listSecretsPayload = JSON.parse(listSecretsRaw) as {
		ok?: boolean
		secrets?: Array<{ name?: string; scope?: string }>
	}
	expect(listSecretsPayload.ok).toBe(true)
	expect(listSecretsPayload.secrets).toEqual([
		{
			name: 'cloudflareToken',
			scope: 'app',
			description: 'App-scoped Cloudflare deployment token',
			app_id: appId,
			allowed_hosts: [],
			allowed_capabilities: [],
			created_at: expect.any(String),
			updated_at: expect.any(String),
			ttl_ms: null,
		},
	])

	const valuesExecuteResponse = await fetch(executeUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				await codemode.value_set({
					name: 'workspaceSlug',
					value: 'session-workspace',
					description: 'Session workspace slug',
					scope: 'session',
				})
				await codemode.value_set({
					name: 'workspaceSlug',
					value: 'app-workspace',
					description: 'App workspace slug',
					scope: 'app',
				})
				await codemode.value_set({
					name: 'accountSlug',
					value: 'kent',
					description: 'User account slug',
					scope: 'user',
				})
				const current = await codemode.value_get({
					name: 'workspaceSlug',
				})
				const appOnly = await codemode.value_get({
					name: 'workspaceSlug',
					scope: 'app',
				})
				const listed = await codemode.value_list({})
				const deleted = await codemode.value_delete({
					name: 'accountSlug',
					scope: 'user',
				})
				const remaining = await codemode.value_list({})
				return {
					current: current.value,
					appOnly: appOnly.value,
					listedNames: listed.values.map((value) => value.name + ':' + value.scope + ':' + value.value),
					deleted: deleted.deleted,
					remainingNames: remaining.values.map((value) => value.name + ':' + value.scope),
				}
			}`,
		}),
	})
	if (!valuesExecuteResponse.ok) {
		throw new Error(await valuesExecuteResponse.text())
	}
	const valuesExecutePayload = (await valuesExecuteResponse.json()) as {
		ok?: boolean
		result?: {
			current?: Record<string, unknown>
			appOnly?: Record<string, unknown>
			listedNames?: Array<string>
			deleted?: boolean
			remainingNames?: Array<string>
		}
	}
	expect(valuesExecutePayload.ok).toBe(true)
	expect(valuesExecutePayload.result?.current).toEqual({
		name: 'workspaceSlug',
		scope: 'session',
		value: 'session-workspace',
		description: 'Session workspace slug',
		app_id: null,
		created_at: expect.any(String),
		updated_at: expect.any(String),
		ttl_ms: expect.any(Number),
	})
	expect(valuesExecutePayload.result?.appOnly).toEqual({
		name: 'workspaceSlug',
		scope: 'app',
		value: 'app-workspace',
		description: 'App workspace slug',
		app_id: appId,
		created_at: expect.any(String),
		updated_at: expect.any(String),
		ttl_ms: null,
	})
	expect(valuesExecutePayload.result?.listedNames).toEqual([
		'workspaceSlug:session:session-workspace',
		'workspaceSlug:app:app-workspace',
		'accountSlug:user:kent',
	])
	expect(valuesExecutePayload.result?.deleted).toBe(true)
	expect(valuesExecutePayload.result?.remainingNames).toEqual([
		'workspaceSlug:session',
		'workspaceSlug:app',
	])

	const returnedPlaceholderResponse = await fetch(executeUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				return {
					interpolatedSecret: '{{secret:cloudflareToken|scope=app}}',
				}
			}`,
		}),
	})
	expect(returnedPlaceholderResponse.status).toBe(400)
	const returnedPlaceholderPayload =
		(await returnedPlaceholderResponse.json()) as {
			ok?: boolean
			error?: string
		}
	expect(returnedPlaceholderPayload.ok).toBe(false)
	expect(returnedPlaceholderPayload.error).toContain(
		'executeCode may not return unresolved `{{secret:...}}` placeholders',
	)

	const approvedFetchReference = crypto
		.randomUUID()
		.replace(/-/g, '')
		.slice(0, 24)
	const blockedFetchExecuteResponse = await fetch(executeUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				const response = await fetch(
					'https://example.com/deploy?reference=${approvedFetchReference}',
					{
						method: 'POST',
						headers: {
							Authorization: 'Bearer {{secret:cloudflareToken|scope=app}}',
						},
						body: JSON.stringify({ note: 'deploy' }),
					},
				)
				return {
					status: response.status,
				}
			}`,
		}),
	})
	expect(blockedFetchExecuteResponse.status).toBe(400)
	const blockedFetchExecutePayload =
		(await blockedFetchExecuteResponse.json()) as {
			ok?: boolean
			error?: string
			errorDetails?: Record<string, unknown>
		}
	expect(blockedFetchExecutePayload.ok).toBe(false)
	expect(blockedFetchExecutePayload.error).toContain(
		'Secrets require host approval:',
	)
	const approvalUrl = (
		blockedFetchExecutePayload.errorDetails as
			| {
					missingApprovals?: Array<{ approvalUrl?: string }>
			  }
			| undefined
	)?.missingApprovals?.[0]?.approvalUrl
	expect(approvalUrl).toMatch(
		/https?:\/\/\S*\/account\/secrets\/[^\s?]+\?[^)\s]*allowed-host=[^&\s)]+[^)\s]*/,
	)
	expect(blockedFetchExecutePayload.errorDetails).toEqual({
		kind: 'host_approval_required_batch',
		message: expect.stringContaining('Secrets require host approval:'),
		nextStep:
			'Ask the user whether they want to approve these hosts for the listed secrets in the account web UI, then retry after approval.',
		missingApprovals: [
			expect.objectContaining({
				secretName: 'cloudflareToken',
				host: 'example.com',
			}),
		],
		suggestedAction: {
			type: 'approve_secret_host',
		},
	})

	const appCookieHeader = await loginToApp(server.origin, database.user)
	const approvalResponse = await fetch(approvalUrl!, {
		headers: {
			Cookie: appCookieHeader,
		},
	})
	expect(approvalResponse.ok).toBe(true)

	const approvalApiResponse = await fetch(
		new URL('/account/secrets.json', server.origin),
		{
			method: 'POST',
			headers: {
				Cookie: appCookieHeader,
				'Content-Type': 'application/json',
				Accept: 'application/json',
			},
			body: JSON.stringify({
				action: 'approve',
				requestToken: new URL(approvalUrl!).searchParams.get('request'),
			}),
		},
	)
	const approvalApiRaw = await approvalApiResponse.text()
	expect(approvalApiResponse.ok, approvalApiRaw).toBe(true)
	const approvalApiPayload = JSON.parse(approvalApiRaw) as {
		ok?: boolean
		secrets?: Array<Record<string, unknown>>
	}
	expect(approvalApiPayload.ok).toBe(true)
	expect(approvalApiPayload.secrets).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'cloudflareToken',
				scope: 'app',
				allowedHosts: ['example.com'],
			}),
		]),
	)

	const approvedFetchExecuteResponse = await fetch(executeUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				const response = await fetch(
					'https://example.com/deploy?reference=${approvedFetchReference}',
					{
						method: 'POST',
						headers: {
							Authorization: 'Bearer {{secret:cloudflareToken|scope=app}}',
						},
						body: JSON.stringify({ note: 'deploy' }),
					},
				)
				return {
					ok: response.ok,
					status: response.status,
				}
			}`,
		}),
	})
	if (!approvedFetchExecuteResponse.ok) {
		const raw = await approvedFetchExecuteResponse.text().catch(() => '')
		throw new Error(
			`Approved fetch failed (${approvedFetchExecuteResponse.status}): ${raw}. reference=${approvedFetchReference}`,
		)
	}
	const approvedFetchExecutePayload =
		(await approvedFetchExecuteResponse.json()) as {
			ok?: boolean
			result?: {
				ok?: boolean
				status?: number
			}
		}
	expect(approvedFetchExecutePayload.ok).toBe(true)
	expect(approvedFetchExecutePayload.result).toEqual({
		ok: false,
		status: 405,
	})

	const searchResult = await mcpClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'cloudflare deploy token',
			limit: 10,
			detail: true,
		},
	})
	const searchStructured = (searchResult as CallToolResult).structuredContent as
		| {
				result?: {
					matches?: Array<Record<string, unknown>>
				}
		  }
		| undefined
	const matches = searchStructured?.result?.matches ?? []
	const userSecretMatch = matches.find(
		(match) => match.type === 'secret' && match.name === 'globalApiKey',
	)
	expect(userSecretMatch?.description).toBe('Reusable cross-app API key')
	const sessionSecretMatch = matches.find(
		(match) => match.type === 'secret' && match.name === 'ephemeralCode',
	)
	expect(sessionSecretMatch).toBeUndefined()
	const appMatch = matches.find(
		(match) => match.type === 'app' && match.appId === appId,
	)
	expect(appMatch?.availableSecrets).toEqual([
		{
			name: 'cloudflareToken',
			description: 'App-scoped Cloudflare deployment token',
		},
	])

	const deleteSecretExecuteResponse = await fetch(executeUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			code: `async () => {
				return await codemode.secret_delete({
					name: 'ephemeralCode',
					scope: 'session',
				})
			}`,
		}),
	})
	expect(deleteSecretExecuteResponse.ok).toBe(true)
	const deleteSecretExecutePayload =
		(await deleteSecretExecuteResponse.json()) as {
			ok?: boolean
			result?: {
				deleted?: boolean
			}
		}
	expect(deleteSecretExecutePayload).toMatchObject({
		ok: true,
		result: {
			deleted: true,
		},
	})

	const deleteSecretResponse = await fetch(deleteSecretUrl!, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({
			name: 'cloudflareToken',
			scope: 'app',
		}),
	})
	expect(deleteSecretResponse.ok).toBe(true)
	const deleteSecretPayload = (await deleteSecretResponse.json()) as {
		ok?: boolean
		deleted?: boolean
	}
	expect(deleteSecretPayload).toEqual({
		ok: true,
		deleted: true,
	})
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

test('mcp server updates saved ui app artifacts', async () => {
	await using database = await createTestDatabase()
	await using server = await startDevServer(database.persistDir)
	await using mcpClient = await createMcpClient(server.origin, database.user)

	const saveResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_save_app({
						title: 'Original App',
						description: 'Original app description.',
						keywords: ['original', 'ui'],
						code: '<main><h1>Original</h1></main>',
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

	const updateResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_update_app({
						app_id: ${JSON.stringify(appId)},
						title: 'Updated App',
						description: 'Updated description.',
						keywords: ['updated', 'ui'],
						code: '<main><h1>Updated</h1></main>',
						runtime: 'javascript',
						search_text: 'updated searchable text',
					})`,
		},
	})
	const updateStructured = (updateResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const updatePayload = updateStructured?.result as
		| Record<string, unknown>
		| undefined
	expect(updatePayload?.app_id).toBe(appId)
	expect(updatePayload?.runtime).toBe('javascript')
	expect(updatePayload?.hosted_url).toBe(`${server.origin}/ui/${appId}`)

	const getResult = await mcpClient.client.callTool({
		name: 'execute',
		arguments: {
			code: `async () =>
					await codemode.ui_get_app({ app_id: ${JSON.stringify(appId)} })`,
		},
	})
	const getStructured = (getResult as CallToolResult).structuredContent as
		| {
				result?: Record<string, unknown>
		  }
		| undefined
	const getPayload = getStructured?.result as
		| Record<string, unknown>
		| undefined
	expect(getPayload?.title).toBe('Updated App')
	expect(getPayload?.description).toBe('Updated description.')
	expect(getPayload?.keywords).toEqual(['updated', 'ui'])
	expect(getPayload?.code).toBe('<main><h1>Updated</h1></main>')
	expect(getPayload?.runtime).toBe('javascript')
	expect(getPayload?.search_text).toBe('updated searchable text')
})
