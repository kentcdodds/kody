import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	buildSpawnEnv,
	buildWranglerSecretBulkFlags,
	collectSpawnedProcessOutput,
	parseDotenv,
	retrySecretBulkUpload,
} from './sync-worker-secrets'

const baseOptions = {
	env: undefined,
	name: undefined,
	config: undefined,
	dotenvPaths: [],
	setPairs: [],
	setFromEnv: [],
	setFromEnvOptional: [],
	generateCookieSecret: false,
	includeEmpty: false,
	emptyAsSpace: false,
}

test('parseDotenv unescapes double-quoted PEM newlines', () => {
	const secrets = parseDotenv(
		'OIDC_SIGNING_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----"\n',
	)
	expect(secrets.get('OIDC_SIGNING_PRIVATE_KEY_PEM')).toBe(
		'-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
	)
})

test('buildSpawnEnv preserves optional vars only when they have values', () => {
	const options = {
		...baseOptions,
		setFromEnvOptional: ['CLOUDFLARE_API_BASE_URL', 'SENTRY_DSN'],
	}
	const spawnEnvWithoutOptionalValues = buildSpawnEnv(options, {
		CLOUDFLARE_API_BASE_URL: '',
		COOKIE_SECRET: 'cookie',
		PATH: '/usr/bin',
		SENTRY_DSN: '',
	})
	expect(spawnEnvWithoutOptionalValues.CLOUDFLARE_API_BASE_URL).toBeUndefined()
	expect(spawnEnvWithoutOptionalValues.COOKIE_SECRET).toBe('cookie')
	expect(spawnEnvWithoutOptionalValues.PATH).toBe('/usr/bin')
	expect(spawnEnvWithoutOptionalValues.SENTRY_DSN).toBeUndefined()

	const spawnEnvWithOptionalValues = buildSpawnEnv(options, {
		CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com',
		PATH: '/usr/bin',
		SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
	})
	expect(spawnEnvWithOptionalValues.CLOUDFLARE_API_BASE_URL).toBe(
		'https://api.cloudflare.com',
	)
	expect(spawnEnvWithOptionalValues.PATH).toBe('/usr/bin')
	expect(spawnEnvWithOptionalValues.SENTRY_DSN).toBe(
		'https://examplePublicKey@o0.ingest.sentry.io/0',
	)
})

test('secret bulk omits empty --env so --name pins the unsuffixed script', () => {
	const secretsFile = '/tmp/wrangler-secrets.env'
	expect(
		buildWranglerSecretBulkFlags(
			{
				...baseOptions,
				env: '',
				name: 'kody-runtime',
				config: 'packages/runtime-worker/wrangler-production.generated.json',
			},
			secretsFile,
		),
	).toEqual([
		'secret',
		'bulk',
		secretsFile,
		'--name',
		'kody-runtime',
		'--config',
		'packages/runtime-worker/wrangler-production.generated.json',
	])

	expect(
		buildWranglerSecretBulkFlags(
			{
				...baseOptions,
				env: 'production',
				config: 'packages/worker/wrangler-production.generated.json',
			},
			secretsFile,
		),
	).toEqual([
		'secret',
		'bulk',
		secretsFile,
		'--env',
		'production',
		'--config',
		'packages/worker/wrangler-production.generated.json',
	])
})

test('secret bulk rejects --env with --name so it cannot target name-env', () => {
	const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
		throw new Error('process.exit called')
	}) as never)
	consoleError.mockImplementation(() => {})
	try {
		expect(() =>
			buildWranglerSecretBulkFlags(
				{
					...baseOptions,
					env: 'production',
					name: 'kody-runtime',
				},
				'/tmp/wrangler-secrets.env',
			),
		).toThrow('process.exit called')
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('kody-runtime-production'),
		)
	} finally {
		exitSpy.mockRestore()
	}
})

test('secret bulk retries a Cloudflare 503 then fails fast on real errors', async () => {
	const secretBulk503Log = [
		'🚨 Secrets failed to upload',
		'',
		'Received a malformed response from the API',
		'',
		'  upstream connect error or disconnect/reset before headers. reset reason: connection termination',
		'  PATCH /accounts/acct/workers/scripts/kody-runtime/secrets-bulk -> 503 Service Unavailable',
	].join('\n')
	const authErrorLog = 'Authentication error [code: 9109]'
	const delays: Array<number> = []
	const retries: Array<number> = []
	let flakeCalls = 0
	const recovered = await retrySecretBulkUpload(
		async () => {
			flakeCalls += 1
			if (flakeCalls === 1) {
				return { exitCode: 1, output: secretBulk503Log }
			}
			return { exitCode: 0, output: 'Uploaded' }
		},
		{
			attempts: 3,
			baseDelayMs: 25,
			sleep: async (ms) => {
				delays.push(ms)
			},
			onRetry: ({ attempt }) => {
				retries.push(attempt)
			},
		},
	)
	expect(recovered.exitCode).toBe(0)
	expect(recovered.output).toBe('Uploaded')
	expect(flakeCalls).toBe(2)
	expect(delays).toEqual([25])
	expect(retries).toEqual([1])

	let exhaustedCalls = 0
	const exhausted = await retrySecretBulkUpload(
		async () => {
			exhaustedCalls += 1
			return { exitCode: 1, output: secretBulk503Log }
		},
		{
			attempts: 3,
			baseDelayMs: 10,
			sleep: async () => {},
			onRetry: () => {},
		},
	)
	expect(exhausted.exitCode).toBe(1)
	expect(exhaustedCalls).toBe(3)

	let authCalls = 0
	const authFailure = await retrySecretBulkUpload(
		async () => {
			authCalls += 1
			return { exitCode: 1, output: authErrorLog }
		},
		{
			attempts: 3,
			baseDelayMs: 10,
			sleep: async () => {
				throw new Error('should not sleep for non-retryable errors')
			},
			onRetry: () => {
				throw new Error('should not retry non-retryable errors')
			},
		},
	)
	expect(authFailure.exitCode).toBe(1)
	expect(authCalls).toBe(1)
})

test('secret bulk output includes stderr that arrives after exit', async () => {
	const stdout = new PassThrough()
	const stderr = new PassThrough()
	const proc = Object.assign(new EventEmitter(), { stdout, stderr })
	const resultPromise = collectSpawnedProcessOutput(proc)

	proc.emit('exit', 1)
	stderr.write(
		'PATCH /accounts/acct/workers/scripts/kody-runtime/secrets-bulk -> 503 Service Unavailable\n',
	)
	stdout.end()
	stderr.end()
	proc.emit('close', 1)

	const result = await resultPromise
	expect(result.exitCode).toBe(1)
	expect(result.output).toContain('secrets-bulk -> 503 Service Unavailable')
})
