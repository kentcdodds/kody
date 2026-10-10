import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { type Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
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
	connectStatelessMcpClient,
	exchangeAuthorizationCode,
	loginToApp,
	registerOAuthClient,
	type AppAuthUser,
} from './mcp-oauth-client.ts'
import {
	buildRoleAssignmentSql,
	buildSeedPersonalOrgSql,
	seedStableUserIdFromEmail,
} from './seed-sql.ts'

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

export type SharedMcpE2eServer = {
	origin: string
	ensureUser(user: TestUser): Promise<void>
	markEmailVerified(email: string): Promise<void>
	assignRole(email: string, role: string): Promise<void>
}

type SharedMcpE2eServerHandle = SharedMcpE2eServer & {
	close(): Promise<void>
}

let sharedMcpE2eServerPromise: Promise<SharedMcpE2eServerHandle> | null = null

/**
 * One Wrangler test harness for the whole mcp-e2e project. Each test still
 * seeds its own user/org so order does not matter; only the cold boot is
 * shared. The vitest worker process exit tears the harness down.
 */
export async function getSharedMcpE2eServer(): Promise<SharedMcpE2eServer> {
	sharedMcpE2eServerPromise ??= startSharedMcpE2eServer()
	const server = await sharedMcpE2eServerPromise
	return {
		origin: server.origin,
		ensureUser: (user) => server.ensureUser(user),
		markEmailVerified: (email) => server.markEmailVerified(email),
		assignRole: (email, role) => server.assignRole(email, role),
	}
}

/** Unique DNS-safe username + email so shared-DB tests stay isolated. */
export function createUniqueTestUser(): TestUser {
	const id = randomUUID().replace(/-/g, '').slice(0, 10)
	return {
		email: `mcp-${id}@example.com`,
		username: `u${id}`,
		password: testUserPassword,
	}
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

type DevServer = {
	origin: string
	[Symbol.asyncDispose](): Promise<void>
}

export function startDevServer(
	persistDir: string,
	options: { withCloudflareMock: true },
): ReturnType<typeof startDevServerWithCloudflareMock>
export function startDevServer(
	persistDir: string,
	options?: { withCloudflareMock?: boolean },
): Promise<DevServer>
export async function startDevServer(
	persistDir: string,
	options?: { withCloudflareMock?: boolean },
): Promise<DevServer> {
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

async function startSharedMcpE2eServer(): Promise<SharedMcpE2eServerHandle> {
	const started = await startHarnessWithCloudflareMock()
	return {
		origin: started.origin,
		ensureUser: started.ensureUser,
		markEmailVerified: started.markEmailVerified,
		assignRole: started.assignRole,
		close: started.close,
	}
}

async function startDevServerWithCloudflareMock() {
	const started = await startHarnessWithCloudflareMock()
	return {
		origin: started.origin,
		ensureUser: started.ensureUser,
		markEmailVerified: started.markEmailVerified,
		async [Symbol.asyncDispose]() {
			await started.close()
		},
	}
}

async function startHarnessWithCloudflareMock() {
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
			// Seed before /auth. These workers point CLOUDFLARE_API_* at the
			// mock so package publish can snapshot sources; a configured
			// sender then tries to deliver the verification email. The mock
			// Email DO can still 503 / return an empty body after /__mocks/meta
			// looks ready, and signup rolls the user back.
			async ensureUser(user: TestUser) {
				await seedMcpTestUser(env.APP_DB, user)
			},
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
			async assignRole(email: string, role: string) {
				await env.APP_DB.prepare(
					`INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ? AND r.name = ?`,
				)
					.bind(email, role)
					.run()
			},
			async close() {
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

export async function seedMcpTestUser(db: D1Database, user: TestUser) {
	const passwordHash = await createPasswordHash(user.password)
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'free')
ON CONFLICT(email) DO UPDATE SET
	username = excluded.username,
	password_hash = excluded.password_hash,
	email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at),
	stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
	plan = COALESCE(users.plan, excluded.plan),
	updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			user.username,
			user.email,
			passwordHash,
			seedStableUserIdFromEmail(user.email),
		)
		.run()
	await db
		.prepare(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ? AND r.name = 'user'`,
		)
		.bind(user.email)
		.run()
	const personalOrgSql = buildSeedPersonalOrgSql({
		stableUserId: seedStableUserIdFromEmail(user.email),
		username: user.username,
	})
	for (const statement of personalOrgSql.split(';')) {
		const sql = statement.trim()
		if (!sql) continue
		await db.prepare(sql).run()
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
		persistDir?: string
		extraHeaders?: Record<string, string>
		ensureUser?: (user: TestUser) => Promise<void>
		markEmailVerified?: (email: string) => Promise<void>
	},
) {
	const extraHeaders = options.extraHeaders
	if (options.ensureUser) {
		await options.ensureUser(user)
	}
	const cookieHeader = await loginToApp(origin, user)
	if (options.markEmailVerified) {
		await options.markEmailVerified(user.email)
	} else if (options.persistDir) {
		await markEmailVerifiedInMcpTestDatabase({
			persistDir: options.persistDir,
			email: user.email,
		})
	} else {
		throw new Error(
			'createMcpClient requires persistDir or markEmailVerified to verify the test user.',
		)
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
		persistDir?: string
		ensureUser?: (user: TestUser) => Promise<void>
		markEmailVerified?: (email: string) => Promise<void>
	},
) {
	if (options.ensureUser) {
		await options.ensureUser(user)
	}
	const cookieHeader = await loginToApp(origin, user)
	if (options.markEmailVerified) {
		await options.markEmailVerified(user.email)
	} else if (options.persistDir) {
		await markEmailVerifiedInMcpTestDatabase({
			persistDir: options.persistDir,
			email: user.email,
		})
	} else {
		throw new Error(
			'createModernMcpClient requires persistDir or markEmailVerified to verify the test user.',
		)
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
	const connection = await connectStatelessMcpClient(
		origin,
		{ Authorization: `Bearer ${accessToken}` },
		{ name: 'kody-mcp-e2e-modern-client' },
	)
	return {
		client: connection.client,
		async [Symbol.asyncDispose]() {
			await connection.client.close().catch(() => undefined)
			await connection.transport.close().catch(() => undefined)
		},
	}
}

async function applyMigrations(persistDir: string) {
	// APP_DB, AUDIT_DB, and JOBS_DB all land in persistDir.
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
