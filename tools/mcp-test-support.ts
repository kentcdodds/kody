import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { type Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import {
	Client as ModernClient,
	StreamableHTTPClientTransport as ModernStreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import getPort from 'get-port'
import { createTestHarness } from 'wrangler'
import {
	captureOutput,
	nodeBin,
	spawnProcess,
	stopProcess,
} from '#mcp/test-process.ts'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'
import {
	authorizeOAuthClient,
	closeMcpConnection,
	connectMcpClient,
	exchangeAuthorizationCode,
	loginToApp,
	registerOAuthClient,
	type AppAuthUser,
} from './mcp-oauth-client.ts'
import { buildRoleAssignmentSql } from './seed-sql.ts'

const projectRoot = process.cwd()
const primaryUserEmail = 'kody@example.com'
// Must satisfy the server-side password policy (see
// @kody-internal/shared/password-policy.ts). Matches the documented local seed
// fixture login (kody@example.com / ilikecode).
const testUserPassword = 'ilikecode'
const localhost = '127.0.0.1'
const defaultWaitTimeoutMs = process.env.CI ? 60_000 : 45_000
const perAttemptFetchTimeoutMs = 5_000
const maxPortBindRetries = 5

type TestUser = AppAuthUser

type TestCallToolParams = CallToolRequest['params'] & {
	headers?: Record<string, string>
}

type ConnectedTestClient = {
	callTool(params: TestCallToolParams): ReturnType<Client['callTool']>
	listTools(): ReturnType<Client['listTools']>
}

export async function createTestDatabase() {
	const persistDir = await mkdtemp(path.join(tmpdir(), 'kody-mcp-e2e-'))
	const user = {
		email: primaryUserEmail,
		username: 'mcp-test-user',
		password: testUserPassword,
	} satisfies TestUser

	return {
		persistDir,
		user,
		async [Symbol.asyncDispose]() {
			await rm(persistDir, { recursive: true, force: true })
		},
	}
}

export async function startDevServer(
	persistDir: string,
	options?: { withCloudflareMock?: boolean },
) {
	if (options?.withCloudflareMock) {
		return startDevServerWithCloudflareMock()
	}
	await applyMigrations(persistDir)

	// These smoke tests do not exercise Cloudflare APIs. Keeping that client
	// unconfigured keeps MCP authentication independent of the email mock;
	// test-runtime signup deliberately permits a skipped verification send,
	// and createMcpClient marks the account verified before OAuth begins.
	// The blank overrides matter: a developer's packages/worker/.env may hold
	// real Cloudflare credentials, and without them signup would attempt a
	// live Email API send and fail the run.
	for (let attempt = 1; attempt <= maxPortBindRetries; attempt++) {
		const port = await getPort({ host: localhost })
		const origin = `http://${localhost}:${port}`
		const proc = spawnProcess({
			cmd: [
				nodeBin,
				'--env-file=packages/worker/.env',
				'./wrangler-env.ts',
				'dev',
				'--local',
				'--persist-to',
				persistDir,
				'--port',
				String(port),
				'--ip',
				localhost,
				'--show-interactive-dev-session=false',
				'--log-level',
				'error',
				// MCP smoke journeys do not call JOBS or HIGHLIGHT. Passing the
				// origin config explicitly keeps wrangler-env from attaching those
				// secondary configs; Wrangler's multi-config additional-module
				// watcher can reload forever on Cloud Agent overlay filesystems.
				'--config',
				'packages/worker/wrangler.jsonc',
				'--var',
				`APP_BASE_URL:${origin}`,
				'--var',
				'CLOUDFLARE_API_BASE_URL:',
				'--var',
				'CLOUDFLARE_API_TOKEN:',
				'--var',
				'CLOUDFLARE_ACCOUNT_ID:',
			],
			cwd: projectRoot,
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
			},
		})
		const getStdout = captureOutput(proc.stdout)
		const getStderr = captureOutput(proc.stderr)

		try {
			await waitForHttpReady({
				label: 'Test worker',
				url: new URL('/mcp', origin),
				isReady: (response) => response.status === 401 || response.ok,
				exited: proc.exited,
				getStdout,
				getStderr,
			})
			return {
				origin,
				async [Symbol.asyncDispose]() {
					await stopProcess(proc)
				},
			}
		} catch (error) {
			await stopProcess(proc).catch(() => undefined)
			if (isPortAlreadyInUseError(error) && attempt < maxPortBindRetries) {
				continue
			}
			throw error
		}
	}

	throw new Error(
		'Failed to start MCP test dev servers after multiple retries.',
	)
}

async function startDevServerWithCloudflareMock() {
	await Promise.all([ensureWorkerBundlerModules(), ensureGuideCatalogModules()])
	const cloudflareMock = await startCloudflareMock(
		`mcp-e2e-cloudflare-${randomUUID()}`,
	)
	const cloudflareVars = {
		CLOUDFLARE_API_BASE_URL: cloudflareMock.origin,
		CLOUDFLARE_API_TOKEN: cloudflareMock.token,
		CLOUDFLARE_ACCOUNT_ID: 'cf_account_mock_123',
		CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
	}
	const harness = createTestHarness({
		root: projectRoot,
		workers: [
			{
				configPath: 'packages/worker/wrangler.jsonc',
				env: 'test',
				vars: cloudflareVars,
				bindingOverrides: {
					CLOUDFLARE_API_MOCK: 'kody-mock-cloudflare-test',
				},
			},
			{
				configPath: 'packages/mock-servers/cloudflare/wrangler.jsonc',
				env: 'test',
				vars: { MOCK_API_TOKEN: cloudflareMock.token },
			},
			{
				configPath: 'packages/jobs-worker/wrangler.jsonc',
				env: 'test',
			},
			{
				configPath: 'packages/highlight-worker/wrangler.jsonc',
				env: 'test',
			},
		],
	})
	try {
		const { url } = await harness.listen()
		const worker = harness.getWorker<{
			APP_DB: D1Database
			AUDIT_DB: D1Database
		}>()
		await worker.applyD1Migrations('APP_DB')
		await worker.applyD1Migrations('AUDIT_DB')
		await harness.getWorker('kody-jobs-test').applyD1Migrations('JOBS_DB')
		const env = await worker.getEnv()
		return {
			origin: url.origin,
			async markEmailVerified(email: string) {
				await env.APP_DB.prepare(
					`UPDATE users
SET email_verified_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE email = ?`,
				)
					.bind(email)
					.run()
			},
			async [Symbol.asyncDispose]() {
				try {
					await harness.close()
				} finally {
					await cloudflareMock[Symbol.asyncDispose]()
				}
			},
		}
	} catch (error) {
		await harness.close().catch(() => undefined)
		await cloudflareMock[Symbol.asyncDispose]()
		throw error
	}
}

export async function markEmailVerifiedInMcpTestDatabase(input: {
	persistDir: string
	email: string
}) {
	const sql = `
UPDATE users
SET email_verified_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE email = ${quoteSqlString(input.email)};`.trim()
	const proc = spawnProcess({
		cmd: [
			nodeBin,
			'--env-file=packages/worker/.env',
			'./wrangler-env.ts',
			'd1',
			'execute',
			'APP_DB',
			'--local',
			'--persist-to',
			input.persistDir,
			'--command',
			sql,
		],
		cwd: projectRoot,
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'test',
		},
	})
	const getStdout = captureOutput(proc.stdout)
	const getStderr = captureOutput(proc.stderr)
	const exitCode = await proc.exited
	if (exitCode === 0) return
	throw new Error(
		[
			`Failed to mark MCP test user email verified (exit ${String(exitCode)}).`,
			getStdout(),
			getStderr(),
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}

export async function assignRoleInMcpTestDatabase(input: {
	persistDir: string
	email: string
	role: string
}) {
	const sql = buildRoleAssignmentSql({ email: input.email, role: input.role })
	const proc = spawnProcess({
		cmd: [
			nodeBin,
			'--env-file=packages/worker/.env',
			'./wrangler-env.ts',
			'd1',
			'execute',
			'APP_DB',
			'--local',
			'--persist-to',
			input.persistDir,
			'--command',
			sql,
		],
		cwd: projectRoot,
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'test',
		},
	})
	const getStdout = captureOutput(proc.stdout)
	const getStderr = captureOutput(proc.stderr)
	const exitCode = await proc.exited
	if (exitCode === 0) return
	throw new Error(
		[
			`Failed to assign MCP test role (exit ${String(exitCode)}).`,
			getStdout(),
			getStderr(),
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}

function isPortAlreadyInUseError(error: unknown) {
	if (!(error instanceof Error)) return false
	const message = error.message.toLowerCase()
	const codeValue =
		typeof error === 'object' && error !== null
			? Reflect.get(error, 'code')
			: undefined
	const code = typeof codeValue === 'string' ? codeValue.toLowerCase() : ''
	return (
		message.includes('address already in use') ||
		message.includes('eaddrinuse') ||
		code === 'eaddrinuse'
	)
}

/**
 * Browser session cookie for authenticated app-origin fetches
 * (`Cookie: kody_session=…`). Same JSON `/auth` signup-or-login path used by
 * MCP OAuth setup; safe to call again after `createMcpClient`.
 */
export async function createAppSessionCookie(origin: string, user: TestUser) {
	return loginToApp(origin, user)
}

export async function createMcpClient(
	origin: string,
	user: TestUser,
	options: {
		// `/mcp` rejects unverified accounts, so the test user's email is
		// marked verified in the local D1 database before connecting.
		persistDir: string
		extraHeaders?: Record<string, string>
		markEmailVerified?: (email: string) => Promise<void>
	},
) {
	const extraHeaders = options.extraHeaders
	const cookieHeader = await loginToApp(origin, user)
	if (options.markEmailVerified) {
		await options.markEmailVerified(user.email)
	} else {
		await markEmailVerifiedInMcpTestDatabase({
			persistDir: options.persistDir,
			email: user.email,
		})
	}
	const clientRegistration = await registerOAuthClient(origin)
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
	)
	const defaultHeaders: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
	}

	const defaultConnection = await connectMcpClient(origin, {
		...defaultHeaders,
		...extraHeaders,
	})

	const client: ConnectedTestClient = {
		listTools() {
			return defaultConnection.client.listTools()
		},
		async callTool(params) {
			const { headers, ...callToolParams } = params
			if (!headers || Object.keys(headers).length === 0) {
				return defaultConnection.client.callTool(callToolParams)
			}

			const overrideConnection = await connectMcpClient(origin, {
				...defaultHeaders,
				...extraHeaders,
				...headers,
			})
			try {
				return await overrideConnection.client.callTool(callToolParams)
			} finally {
				await closeMcpConnection(overrideConnection)
			}
		},
	}

	return {
		client,
		async [Symbol.asyncDispose]() {
			await closeMcpConnection(defaultConnection)
		},
	}
}

/**
 * Modern-era MCP client (protocol revision 2026-07-28) from the SDK v2
 * client package, pinned so the connection fails loudly unless the server
 * serves the stateless lane. Reuses the same signup + OAuth plumbing as
 * `createMcpClient`.
 */
export async function createModernMcpClient(
	origin: string,
	user: TestUser,
	options: {
		persistDir: string
	},
) {
	const cookieHeader = await loginToApp(origin, user)
	await markEmailVerifiedInMcpTestDatabase({
		persistDir: options.persistDir,
		email: user.email,
	})
	const clientRegistration = await registerOAuthClient(origin)
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
	)
	const client = new ModernClient(
		{ name: 'kody-mcp-e2e-modern-client', version: '1.0.0' },
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
	)
	const transport = new ModernStreamableHTTPClientTransport(
		new URL('/mcp', origin),
		{
			requestInit: {
				headers: { Authorization: `Bearer ${accessToken}` },
			},
		},
	)
	await client.connect(transport)
	return {
		client,
		async [Symbol.asyncDispose]() {
			await client.close().catch(() => undefined)
			await transport.close().catch(() => undefined)
		},
	}
}

async function applyMigrations(persistDir: string) {
	const proc = spawnProcess({
		cmd: [
			nodeBin,
			'--env-file=packages/worker/.env',
			'tools/apply-local-app-migrations.ts',
			'--persist-to',
			persistDir,
		],
		cwd: projectRoot,
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'test',
		},
	})
	const getStdout = captureOutput(proc.stdout)
	const getStderr = captureOutput(proc.stderr)
	const exitCode = await proc.exited
	if (exitCode !== 0) {
		throw new Error(
			[
				`Failed to apply local D1 migrations (exit ${String(exitCode)}).`,
				getStdout(),
				getStderr(),
			]
				.filter(Boolean)
				.join('\n\n'),
		)
	}

	// The jobs worker (ADR 0016) runs alongside the main worker in local dev
	// and owns its own D1 database, so its migrations apply too.
	const jobsProc = spawnProcess({
		cmd: [
			nodeBin,
			'--env-file=packages/worker/.env',
			'./wrangler-env.ts',
			'd1',
			'migrations',
			'apply',
			'JOBS_DB',
			'--local',
			'--config',
			'packages/jobs-worker/wrangler.jsonc',
			'--persist-to',
			persistDir,
		],
		cwd: projectRoot,
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'test',
		},
	})
	const getJobsStdout = captureOutput(jobsProc.stdout)
	const getJobsStderr = captureOutput(jobsProc.stderr)
	const jobsExitCode = await jobsProc.exited
	if (jobsExitCode === 0) return

	throw new Error(
		[
			`Failed to apply local jobs D1 migrations (exit ${String(jobsExitCode)}).`,
			getJobsStdout(),
			getJobsStderr(),
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}

async function waitForHttpReady(input: {
	/** Which process this readiness poll belongs to, for error messages. */
	label: string
	url: URL
	isReady: (response: Response) => boolean
	exited: Promise<number | null>
	getStdout: () => string
	getStderr: () => string
}) {
	const deadline = Date.now() + defaultWaitTimeoutMs
	while (Date.now() < deadline) {
		const exitCode = await Promise.race([
			input.exited,
			delay(200).then(() => null),
		])
		if (typeof exitCode === 'number') {
			throw new Error(
				[
					`${input.label} exited before becoming ready (exit ${exitCode}).`,
					input.getStdout(),
					input.getStderr(),
				]
					.filter(Boolean)
					.join('\n\n'),
			)
		}

		try {
			// Bound each attempt so a stalled response cannot hang the poll
			// past the overall deadline (checked only between attempts).
			const response = await fetch(input.url, {
				signal: AbortSignal.timeout(perAttemptFetchTimeoutMs),
			})
			const ready = input.isReady(response)
			await response.body?.cancel()
			if (ready) return
		} catch {
			// Retry until the process starts accepting connections.
		}
	}

	throw new Error(
		[
			`Timed out waiting for ${input.label} at ${input.url.toString()}.`,
			input.getStdout(),
			input.getStderr(),
		]
			.filter(Boolean)
			.join('\n\n'),
	)
}
