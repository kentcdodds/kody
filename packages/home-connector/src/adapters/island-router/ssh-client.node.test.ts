import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises'
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
	const tempDir = await mkdtemp(
		path.join(os.tmpdir(), 'kody-island-router-test-'),
	)
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

test('ssh runner builds guarded DHCP reservation commands from validated tokens', async () => {
	const config = createConfig()
	const tempDir = await mkdtemp(
		path.join(os.tmpdir(), 'kody-island-router-test-'),
	)
	const binDir = path.join(tempDir, 'bin')
	const stdinPath = path.join(tempDir, 'ssh-stdin.txt')
	await mkdir(binDir, { recursive: true })
	const fakeSshPath = path.join(binDir, 'ssh')
	await writeFile(
		fakeSshPath,
		[
			'#!/bin/sh',
			`while IFS= read -r line; do printf '%s\n' "$line" >> "${stdinPath}"; done`,
			'exit 0',
		].join('\n'),
		'utf8',
	)
	await chmod(fakeSshPath, 0o755)

	const originalPath = process.env.PATH
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

	try {
		const runner = createIslandRouterSshCommandRunner(config)
		const reserveResult = await runner({
			id: 'reserve-dhcp-address',
			ipAddress: '192.168.3.77',
			macAddress: '00-00-5E-00-53-7A',
			timeoutMs: 1000,
		})
		expect(reserveResult.commandLines).toEqual([
			'terminal length 0',
			'configure terminal',
			'ip dhcp-reserve 192.168.3.77 00:00:5e:00:53:7a',
			'exit',
		])

		const removeResult = await runner({
			id: 'remove-dhcp-reservation',
			ipAddress: '192.168.3.77',
			macAddress: '00:00:5E:00:53:7A',
			timeoutMs: 1000,
		})
		expect(removeResult.commandLines).toEqual([
			'terminal length 0',
			'configure terminal',
			'no ip dhcp-reserve 192.168.3.77 00:00:5e:00:53:7a',
			'exit',
		])

		const stdin = await readFile(stdinPath, 'utf8')
		expect(stdin).toContain('ip dhcp-reserve 192.168.3.77 00:00:5e:00:53:7a')
		expect(stdin).toContain('no ip dhcp-reserve 192.168.3.77 00:00:5e:00:53:7a')
		expect(stdin).not.toContain('write memory')
	} finally {
		process.env.PATH = originalPath
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('ssh runner treats completed Island CLI sessions with exit code 1 as success', async () => {
	const config = createConfig()
	const tempDir = await mkdtemp(
		path.join(os.tmpdir(), 'kody-island-router-test-'),
	)
	const binDir = path.join(tempDir, 'bin')
	await mkdir(binDir, { recursive: true })
	const fakeSshPath = path.join(binDir, 'ssh')
	await writeFile(
		fakeSshPath,
		[
			'#!/bin/sh',
			'while IFS= read -r _line; do :; done',
			"printf '%s\n' 'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3'",
			"printf '%s\n' 'Copyright 2004-2026 PerfTech, Inc.'",
			"printf '%s\n' ''",
			"printf '%s\n' 'Dodds-Island>show version'",
			"printf '%s\n' ''",
			"printf '%s\n' 'Island Pro (IL-0002-01) serial number 08008A020104 Version 3.2.3'",
			"printf '%s\n' 'Copyright 2004-2026 PerfTech, Inc.'",
			"printf '%s\n' ''",
			"printf '%s\n' 'Dodds-Island>exit'",
			"printf '%s\n' 'Goodbye'",
			'exit 1',
		].join('\n'),
		'utf8',
	)
	await chmod(fakeSshPath, 0o755)

	const originalPath = process.env.PATH
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

	try {
		const runner = createIslandRouterSshCommandRunner(config)
		const result = await runner({
			id: 'show-version',
			timeoutMs: 1000,
		})
		expect(result.exitCode).toBe(0)
		expect(result.signal).toBeNull()
		expect(result.timedOut).toBe(false)
		expect(result.stdout).toContain('Dodds-Island>show version')
		expect(result.stdout).toContain('Goodbye')
	} finally {
		process.env.PATH = originalPath
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('ssh runner keeps genuine exit-code-1 failures detectable', async () => {
	const config = createConfig()
	const tempDir = await mkdtemp(
		path.join(os.tmpdir(), 'kody-island-router-test-'),
	)
	const binDir = path.join(tempDir, 'bin')
	await mkdir(binDir, { recursive: true })
	const fakeSshPath = path.join(binDir, 'ssh')
	await writeFile(
		fakeSshPath,
		[
			'#!/bin/sh',
			'while IFS= read -r _line; do :; done',
			"printf '%s\n' 'Permission denied'",
			'exit 1',
		].join('\n'),
		'utf8',
	)
	await chmod(fakeSshPath, 0o755)

	const originalPath = process.env.PATH
	process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`

	try {
		const runner = createIslandRouterSshCommandRunner(config)
		const result = await runner({
			id: 'show-version',
			timeoutMs: 1000,
		})
		expect(result.exitCode).toBe(1)
		expect(result.signal).toBeNull()
		expect(result.timedOut).toBe(false)
		expect(result.stdout).toContain('Permission denied')
	} finally {
		process.env.PATH = originalPath
		await rm(tempDir, { recursive: true, force: true })
	}
})
