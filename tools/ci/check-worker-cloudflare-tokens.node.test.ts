import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	findWorkerTokenProblems,
	main,
} from './check-worker-cloudflare-tokens.ts'

test('worker token preflight fails closed on missing or deploy-scope worker tokens', () => {
	const allWorkerTokens = [
		'CLOUDFLARE_APP_API_TOKEN',
		'CLOUDFLARE_RUNTIME_API_TOKEN',
		'CLOUDFLARE_STATUS_API_TOKEN',
	] as const

	expect(
		findWorkerTokenProblems(
			{
				CLOUDFLARE_API_TOKEN: 'deploy-token',
				CLOUDFLARE_APP_API_TOKEN: 'app-token',
				CLOUDFLARE_RUNTIME_API_TOKEN: 'runtime-token',
				CLOUDFLARE_STATUS_API_TOKEN: 'status-token',
			},
			allWorkerTokens,
		),
	).toEqual([])

	// GitHub Actions renders an unset secret as an empty string.
	const problems = findWorkerTokenProblems(
		{
			CLOUDFLARE_API_TOKEN: 'deploy-token',
			CLOUDFLARE_APP_API_TOKEN: '',
			CLOUDFLARE_RUNTIME_API_TOKEN: ' deploy-token\n',
		},
		allWorkerTokens,
	)
	expect(problems).toHaveLength(3)
	expect(problems[0]).toContain(
		'Missing GitHub Actions secret CLOUDFLARE_APP_API_TOKEN',
	)
	expect(problems[1]).toContain(
		'CLOUDFLARE_RUNTIME_API_TOKEN matches the deploy token CLOUDFLARE_API_TOKEN',
	)
	expect(problems[2]).toContain(
		'Missing GitHub Actions secret CLOUDFLARE_STATUS_API_TOKEN',
	)

	const previousExitCode = process.exitCode
	const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	try {
		process.exitCode = undefined
		main(['CLOUDFLARE_RUNTIME_API_TOKEN'], {
			CLOUDFLARE_API_TOKEN: 'deploy-token',
			CLOUDFLARE_RUNTIME_API_TOKEN: 'runtime-token',
		})
		expect(process.exitCode).toBeUndefined()

		main(['CLOUDFLARE_RUNTIME_API_TOKEN'], {
			CLOUDFLARE_API_TOKEN: 'deploy-token',
		})
		expect(process.exitCode).toBe(1)
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringMatching(
				/^::error::Missing GitHub Actions secret CLOUDFLARE_RUNTIME_API_TOKEN/,
			),
		)

		process.exitCode = undefined
		main(['CLOUDFLARE_API_TOKEN'], {})
		expect(process.exitCode).toBe(1)
	} finally {
		consoleLog.mockRestore()
		process.exitCode = previousExitCode
	}
})
