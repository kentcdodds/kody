import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	isRetryableDeployFailure,
	main,
} from './is-retryable-deploy-failure.ts'

test('production deploy retries transient Cloudflare flakes and fails fast on real errors', () => {
	const previousExitCode = process.exitCode
	const logDir = mkdtempSync(join(tmpdir(), 'retryable-deploy-'))

	const startupCpuLog = [
		'\u001b[31m✘ \u001b[41;31m[\u001b[41;97mERROR\u001b[41;31m]\u001b[0m \u001b[1mYour Worker failed validation because it exceeded startup limits.\u001b[0m',
		'',
		'  A request to the Cloudflare API (/accounts/a99ee2e72728dd52902ef288b7b1447d/workers/scripts/kody-platform/versions) failed.',
		'   - Error: Script startup exceeded CPU time limit.',
		'   [code: 10021]',
	].join('\n')
	const internalServerLog =
		'workflows.api.error.internal_server: failed to create workflow'
	const apiAuthFlakeLog =
		'A request to the Cloudflare API (/accounts/acct/workers/scripts/kody-production/versions) failed.\n [code: 10001]'
	const durableObjectMigrationLog = [
		'A request to the Cloudflare API (/accounts/acct/workers/scripts/kody-production/versions) failed.',
		"Cannot apply delete-class migration to class 'AppRunner' which was not exported in the previous version of the script",
		'[code: 10074]',
	].join('\n')

	expect(isRetryableDeployFailure(startupCpuLog)).toBe(true)
	expect(
		isRetryableDeployFailure('Error: Script startup exceeded CPU time limit.'),
	).toBe(true)
	expect(isRetryableDeployFailure(internalServerLog)).toBe(true)
	expect(isRetryableDeployFailure(apiAuthFlakeLog)).toBe(true)
	expect(isRetryableDeployFailure(durableObjectMigrationLog)).toBe(false)
	expect(isRetryableDeployFailure('')).toBe(false)

	const startupLogPath = join(logDir, 'deploy-platform.log')
	writeFileSync(startupLogPath, startupCpuLog)
	process.exitCode = undefined
	main([startupLogPath])
	expect(process.exitCode).toBe(0)

	const migrationLogPath = join(logDir, 'deploy.log')
	writeFileSync(migrationLogPath, durableObjectMigrationLog)
	process.exitCode = undefined
	main([migrationLogPath])
	expect(process.exitCode).toBe(1)

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	main([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/is-retryable-deploy-failure.ts <deploy-log>',
	)

	process.exitCode = previousExitCode
})
