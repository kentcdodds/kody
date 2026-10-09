import { Writable } from 'node:stream'
import { expect, test } from 'vitest'
import {
	isRetryableWorkersDevSubdomainRace,
	isRetryableWranglerDeployFailure,
	isWranglerD1MigrationsApply,
	runWranglerDeployWithRetry,
	spawnWranglerDeploy,
} from './wrangler-deploy-retry.ts'

const wranglerD1FetchFailedLog = [
	'▲ [WARNING] A fetch request failed, likely due to a connectivity issue.',
	'',
	'  Common causes:',
	'    - No internet connection or network connectivity problems',
	'',
	'✘ [ERROR] fetch failed',
].join('\n')

test('isRetryableWorkersDevSubdomainRace requires a successful upload then 10007', () => {
	expect(
		isRetryableWorkersDevSubdomainRace(
			'Uploaded kody-pr-2170-highlight\nThis Worker does not exist on your account [code: 10007]',
		),
	).toBe(true)
	expect(
		isRetryableWorkersDevSubdomainRace(
			'This Worker does not exist on your account [code: 10007]',
		),
	).toBe(false)
	expect(isRetryableWorkersDevSubdomainRace('Uploaded kody-pr-1-jobs')).toBe(
		false,
	)
	expect(
		isRetryableWranglerDeployFailure(
			'Received a malformed response from the API\nupstream connect error or disconnect/reset before headers',
		),
	).toBe(true)
	expect(isRetryableWranglerDeployFailure(wranglerD1FetchFailedLog)).toBe(true)
	expect(
		isRetryableWranglerDeployFailure(
			'✘ [ERROR] Migration 0002_add_audit_actor.sql failed: UNIQUE constraint failed',
		),
	).toBe(false)
})

test('isWranglerD1MigrationsApply matches apply and ignores other d1 commands', () => {
	expect(
		isWranglerD1MigrationsApply([
			'd1',
			'migrations',
			'apply',
			'AUDIT_DB',
			'--remote',
		]),
	).toBe(true)
	expect(isWranglerD1MigrationsApply(['d1', 'migrations', 'list'])).toBe(false)
	expect(isWranglerD1MigrationsApply(['d1', 'execute', 'APP_DB'])).toBe(false)
	expect(isWranglerD1MigrationsApply(['deploy'])).toBe(false)
})

test('runWranglerDeployWithRetry retries a 10007 subdomain race then succeeds', async () => {
	const attempts: Array<number> = []
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['deploy'],
		maxAttempts: 3,
		sleep: async () => {},
		log: () => {},
		run: () => {
			attempts.push(attempts.length + 1)
			if (attempts.length === 1) {
				return {
					status: 1,
					output:
						'Uploaded kody-pr-2163-jobs\nThis Worker does not exist on your account [code: 10007]\n',
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output: 'Uploaded kody-pr-2163-jobs\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([1, 2])
})

test('runWranglerDeployWithRetry retries a D1 fetch-failed flake then succeeds', async () => {
	const attempts: Array<number> = []
	const delays: Array<number> = []
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['d1', 'migrations', 'apply', 'AUDIT_DB', '--remote'],
		maxAttempts: 3,
		baseDelayMs: 10_000,
		sleep: async (ms) => {
			delays.push(ms)
		},
		log: () => {},
		run: () => {
			attempts.push(attempts.length + 1)
			if (attempts.length === 1) {
				return {
					status: 1,
					output: wranglerD1FetchFailedLog,
					errorMessage: '',
				}
			}
			return {
				status: 0,
				output: '✅ No migrations to apply!\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(0)
	expect(attempts).toEqual([1, 2])
	expect(delays).toHaveLength(1)
})

test('runWranglerDeployWithRetry does not retry a genuine missing worker', async () => {
	const attempts: Array<number> = []
	const result = await runWranglerDeployWithRetry({
		command: 'wrangler',
		args: ['deploy'],
		maxAttempts: 3,
		sleep: async () => {},
		log: () => {},
		run: () => {
			attempts.push(attempts.length + 1)
			return {
				status: 1,
				output: 'This Worker does not exist on your account [code: 10007]\n',
				errorMessage: '',
			}
		},
	})
	expect(result.status).toBe(1)
	expect(attempts).toEqual([1])
})

test('spawnWranglerDeploy captures more than spawnSync maxBuffer without killing', async () => {
	const oversizedBytes = 2 * 1024 * 1024
	const sink = new Writable({
		write(_chunk, _encoding, callback) {
			callback()
		},
	})
	const result = await spawnWranglerDeploy(
		process.execPath,
		[
			'-e',
			`process.stdout.write('x'.repeat(${String(oversizedBytes)})); process.stderr.write('Uploaded kody\\n')`,
		],
		undefined,
		{ stdout: sink, stderr: sink },
	)
	expect(result.status).toBe(0)
	expect(result.output.includes('Uploaded kody')).toBe(true)
	expect(result.output.length).toBeGreaterThan(1024 * 1024)
})
