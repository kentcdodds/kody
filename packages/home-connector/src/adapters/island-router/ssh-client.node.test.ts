import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createIslandRouterSshCommandRunner } from './ssh-client.ts'

function createConfig() {
	process.env.MOCKS = 'false'
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.HOME_CONNECTOR_SHARED_SECRET =
		'home-connector-secret-home-connector-secret'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.HOME_CONNECTOR_DB_PATH = ':memory:'
	process.env.ISLAND_ROUTER_HOST = 'router.local'
	process.env.ISLAND_ROUTER_PORT = '22'
	process.env.ISLAND_ROUTER_USERNAME = 'user'
	process.env.ISLAND_ROUTER_PRIVATE_KEY_PATH = '/keys/id_ed25519'
	process.env.ISLAND_ROUTER_KNOWN_HOSTS_PATH = ''
	process.env.ISLAND_ROUTER_HOST_FINGERPRINT = ''
	process.env.ISLAND_ROUTER_COMMAND_TIMEOUT_MS = '5000'
	process.env.VENSTAR_SCAN_CIDRS = '192.168.10.40/32'
	return loadHomeConnectorConfig()
}

test('ssh runner explicitly disables host verification when no known-host or fingerprint is configured', async () => {
	const config = createConfig()
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-island-router-test-'))
	const binDir = path.join(tempDir, 'bin')
	const argsPath = path.join(tempDir, 'ssh-args.txt')
	await mkdir(binDir, { recursive: true })
	const fakeSshPath = path.join(binDir, 'ssh')
	await writeFile(
		fakeSshPath,
		[
			'#!/bin/sh',
			`printf '%s\n' "$@" > "${argsPath}"`,
			'while IFS= read -r _line; do :; done',
			'exit 0',
		].join('\n'),
		'utf8',
	)
	await chmod(fakeSshPath, 0o755)

	const originalPath = process.env.PATH
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

	try {
		const runner = createIslandRouterSshCommandRunner(config)
		await runner({
			id: 'show-version',
			timeoutMs: 1000,
		})
		const args = await readFile(argsPath, 'utf8')
		expect(args).toContain('StrictHostKeyChecking=no')
		expect(args).toContain('UserKnownHostsFile=/dev/null')
		expect(args).toContain('GlobalKnownHostsFile=/dev/null')
	} finally {
		process.env.PATH = originalPath
		await rm(tempDir, { recursive: true, force: true })
	}
})
