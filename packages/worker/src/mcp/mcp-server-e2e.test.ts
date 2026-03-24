import { expect, test } from 'bun:test'
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
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const migrationsDir = join(projectRoot, 'packages/worker/migrations')
const bunBin = process.execPath
const defaultTimeoutMs = 60_000
const calculatorUiResourceUri = 'ui://calculator-app/entry-point.html'
const workerConfig = 'packages/worker/wrangler.jsonc'
const workerEnvFile = 'packages/worker/.env'
const primaryUserEmail = 'me@kentcdodds.com'
const primaryUserPassword = 'iliketwix'

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
	const proc = Bun.spawn({
		cmd: [
			bunBin,
			'--no-env-file',
			`--env-file=${workerEnvFile}`,
			'x',
			'wrangler',
			'--config',
			workerConfig,
			...args,
		],
		cwd: projectRoot,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const stdoutPromise = proc.stdout
		? new Response(proc.stdout).text()
		: Promise.resolve('')
	const stderrPromise = proc.stderr
		? new Response(proc.stderr).text()
		: Promise.resolve('')
	const exitCode = await proc.exited
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
	if (exitCode !== 0) {
		throw new Error(
			`wrangler ${args.join(' ')} failed (${exitCode}). ${stderr || stdout}`,
		)
	}
	return { stdout, stderr }
}

async function createTestDatabase() {
	const persistDir = await mkdtemp(join(tmpdir(), 'kody-mcp-e2e-'))
	const user = {
		email: primaryUserEmail,
		password: primaryUserPassword,
	}

	await applyMigrations(persistDir)

	const passwordHash = await createPasswordHash(user.password)
	const username = user.email.split('@')[0] || 'user'
	const insertSql = `INSERT INTO users (username, email, password_hash) VALUES ('${escapeSql(
		username,
	)}', '${escapeSql(user.email)}', '${escapeSql(passwordHash)}');`

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
		user,
		[Symbol.asyncDispose]: async () => {
			await rm(persistDir, { recursive: true, force: true })
		},
	}
}

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

function captureOutput(stream: ReadableStream<Uint8Array> | null) {
	let output = ''
	if (!stream) {
		return () => output
	}

	const reader = stream.getReader()
	const decoder = new TextDecoder()

	const read = async () => {
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				if (value) {
					output += decoder.decode(value)
				}
			}
		} catch {
			// Ignore stream errors while capturing output.
		}
	}

	void read()
	return () => output
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
	proc: ReturnType<typeof Bun.spawn>,
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

async function stopProcess(proc: ReturnType<typeof Bun.spawn>) {
	let exited = false
	void proc.exited.then(() => {
		exited = true
	})
	proc.kill('SIGINT')
	await Promise.race([proc.exited, delay(5_000)])
	if (!exited) {
		proc.kill('SIGKILL')
		await proc.exited
	}
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
	const proc = Bun.spawn({
		cmd: [
			bunBin,
			'--no-env-file',
			`--env-file=${workerEnvFile}`,
			'x',
			'wrangler',
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
		stdout: 'pipe',
		stderr: 'pipe',
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

test(
	'mcp server lists tools after interactive oauth authorize flow',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(
			server.origin,
			database.user,
			{
				simulateInteractiveAuthorize: true,
			},
		)

		const result = await mcpClient.client.listTools()
		const toolNames = result.tools.map((tool) => tool.name)

		expect(toolNames.sort()).toEqual([
			'execute',
			'open_calculator_ui',
			'search',
		])
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server lists tools after oauth flow',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const instructions = mcpClient.client.getInstructions() ?? ''
		expect(instructions).toContain('Quick start')
		expect(instructions).toContain('github.com/kentcdodds/kody')

		const result = await mcpClient.client.listTools()
		const toolNames = result.tools.map((tool) => tool.name)

		expect(toolNames.sort()).toEqual([
			'execute',
			'open_calculator_ui',
			'search',
		])

		const resourcesResult = await mcpClient.client.listResources()
		const resourceUris = resourcesResult.resources.map(
			(resource) => resource.uri,
		)

		expect(resourceUris).toContain(calculatorUiResourceUri)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server searches capabilities',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search',
			arguments: {
				query:
					'calculation add subtract multiply divide finite number arithmetic',
				limit: 8,
			},
		})

		const structuredResult = (result as CallToolResult).structuredContent as
			| Record<string, unknown>
			| undefined
		const searchPayload = structuredResult?.result as
			| Record<string, unknown>
			| undefined
		const matches = searchPayload?.matches as
			| Array<Record<string, unknown>>
			| undefined

		expect(searchPayload?.offline).toBe(true)
		const topMath = matches?.find(
			(m) => m.type === 'capability' && m.name === 'do_math',
		)
		expect(topMath?.domain).toBe('math')
		expect(topMath?.requiredInputFields).toEqual(['left', 'right', 'operator'])
		expect(topMath?.readOnly).toBeUndefined()
		expect(topMath?.inputFields).toBeUndefined()

		const textOutput =
			(result as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''

		expect(textOutput).toContain('do_math')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server search detail mode includes schema field descriptions',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'search',
			arguments: {
				query: 'arithmetic two operands operator precision',
				limit: 5,
				detail: true,
			},
		})

		const structuredResult = (result as CallToolResult).structuredContent as
			| Record<string, unknown>
			| undefined
		const searchPayload = structuredResult?.result as
			| Record<string, unknown>
			| undefined
		const searchResult = searchPayload?.matches as
			| Array<Record<string, unknown>>
			| undefined
		const capability = searchResult?.find(
			(m) => m.type === 'capability' && m.name === 'do_math',
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
		expect(capability?.name).toBe('do_math')
		expect(capability?.keywords).toEqual(
			expect.arrayContaining(['arithmetic', 'calculation', 'divide']),
		)
		expect(capability?.inputFields).toBeUndefined()
		expect(capability?.outputFields).toBeUndefined()
		expect(capability?.requiredInputFields).toEqual([
			'left',
			'right',
			'operator',
		])
		expect(inputSchema?.description).toBe(
			'Inputs for a single arithmetic operation. Use precision to control formatted display output only.',
		)
		expect(inputProperties?.operator?.description).toBe(
			'Operator. Valid values: "+", "-", "*", "/".',
		)
		expect(outputProperties?.expression?.description).toBe(
			'Expression string, for example: "8 + 4".',
		)
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server search returns Cloudflare capability results',
	async () => {
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
			| Record<string, unknown>
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
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server executes do_math via execute tool',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'execute',
			arguments: {
				code: `async () =>
					await codemode.do_math({
						left: 8,
						right: 4,
						operator: '+',
					})`,
			},
		})

		const structuredResult = (result as CallToolResult).structuredContent as
			| Record<string, unknown>
			| undefined
		const executeResult = structuredResult?.result as
			| Record<string, unknown>
			| undefined
		expect(executeResult?.result).toBe(12)

		const textOutput =
			(result as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''

		expect(textOutput).toContain('12')
		expect(textOutput).toContain('meta_save_skill')
	},
	{ timeout: defaultTimeoutMs },
)

test(
	'mcp server executes calculator ui tool and serves resource entry point',
	async () => {
		await using database = await createTestDatabase()
		await using server = await startDevServer(database.persistDir)
		await using mcpClient = await createMcpClient(server.origin, database.user)

		const result = await mcpClient.client.callTool({
			name: 'open_calculator_ui',
		})

		const structuredResult = (result as CallToolResult).structuredContent as
			| Record<string, unknown>
			| undefined
		expect(structuredResult?.widget).toBe('calculator')
		expect(structuredResult?.resourceUri).toBe(calculatorUiResourceUri)

		const textOutput =
			(result as CallToolResult).content.find(
				(item): item is Extract<ContentBlock, { type: 'text' }> =>
					item.type === 'text',
			)?.text ?? ''
		expect(textOutput).toContain('Calculator widget')

		const resourceResult = await mcpClient.client.readResource({
			uri: calculatorUiResourceUri,
		})
		const calculatorResource = resourceResult.contents.find(
			(content): content is { uri: string; mimeType?: string; text: string } =>
				content.uri === calculatorUiResourceUri &&
				'text' in content &&
				typeof content.text === 'string',
		)
		const calculatorResourceMeta = (
			resourceResult.contents.find(
				(content) => content.uri === calculatorUiResourceUri,
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

		expect(calculatorResource).toBeDefined()
		expect(calculatorResource?.mimeType).toBe('text/html;profile=mcp-app')
		expect(calculatorResource?.text).toContain('data-calculator-ui')
		expect(calculatorResource?.text).toContain('rel="stylesheet"')
		expect(calculatorResource?.text).toContain('styles.css')
		expect(calculatorResource?.text).toContain('--color-primary')
		expect(calculatorResource?.text).toContain('--color-background')
		expect(calculatorResource?.text).toContain("data-theme='dark'")
		expect(calculatorResource?.text).toContain('type="module"')
		expect(calculatorResource?.text).toContain('/mcp-apps/calculator-widget.js')

		const calculatorWidgetResponse = await fetch(
			new URL('/mcp-apps/calculator-widget.js', server.origin),
		)
		expect(calculatorWidgetResponse.ok).toBe(true)
		expect(
			calculatorWidgetResponse.headers.get('access-control-allow-origin'),
		).toBe('*')
		const calculatorWidgetSource = await calculatorWidgetResponse.text()
		expect(calculatorWidgetSource).toContain('createWidgetHostBridge')
		expect(calculatorWidgetSource).toContain('Calculator result:')
		expect(calculatorWidgetSource).toContain('sendUserMessageWithFallback')
		expect(calculatorWidgetSource).toContain('ui/initialize')
		expect(calculatorWidgetSource).toContain('ui/message')

		const stylesResponse = await fetch(new URL('/styles.css', server.origin))
		expect(stylesResponse.ok).toBe(true)
		expect(stylesResponse.headers.get('access-control-allow-origin')).toBe('*')

		expect(calculatorResourceMeta?.ui?.domain).toBe(server.origin)
		expect(calculatorResourceMeta?.['openai/widgetDomain']).toBe(server.origin)
		expect(calculatorResourceMeta?.ui?.csp?.resourceDomains).toContain(
			server.origin,
		)
	},
	{ timeout: defaultTimeoutMs },
)
