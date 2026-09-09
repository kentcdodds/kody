import { expect, test } from 'vitest'
import {
	isRetryableWorkersDevSubdomainRace,
	isRetryableWranglerDeployFailure,
	runWranglerDeployWithRetry,
} from './wrangler-deploy-retry.ts'

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
