import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	durableObjectNameFromParts,
	jobManagerDurableObjectName,
	mcpClientHubDurableObjectName,
	packageRealtimeSessionDurableObjectName,
	packageServiceInstanceDurableObjectName,
	repoSessionDurableObjectName,
	storageRunnerDurableObjectName,
} from './user-scoped-durable-object-name.ts'

const identityModuleRelativePath =
	'packages/worker/src/user-scoped-durable-object-name.ts'
const connectorSessionKeyRelativePath =
	'packages/worker/src/remote-connector/connector-session-key.ts'

test('user-scoped Durable Object name helpers preserve frozen idFromName contracts', () => {
	expect(jobManagerDurableObjectName('user-aaa')).toBe('user-aaa')
	// JobManager historically does not trim; keep that wire format frozen.
	expect(jobManagerDurableObjectName('  user-aaa  ')).toBe('  user-aaa  ')

	expect(mcpClientHubDurableObjectName('  user-aaa  ')).toBe('user-aaa')

	expect(storageRunnerDurableObjectName('user-aaa', 'job:1')).toBe(
		'["user-aaa","job:1"]',
	)
	expect(
		packageRealtimeSessionDurableObjectName({
			userId: 'user-aaa',
			packageId: 'pkg-1',
		}),
	).toBe('["user-aaa","pkg-1"]')
	expect(
		packageServiceInstanceDurableObjectName({
			userId: 'user-aaa',
			packageId: 'pkg-1',
			serviceName: 'gateway',
		}),
	).toBe('["user-aaa","pkg-1","gateway"]')

	expect(repoSessionDurableObjectName('session-1')).toBe('session-1')

	expect(durableObjectNameFromParts(['user-aaa', 'a/b'])).toBe(
		'["user-aaa","a/b"]',
	)
	expect(durableObjectNameFromParts(['user-aaa', 'a'])).not.toBe(
		durableObjectNameFromParts(['user-aaa', 'a/b']),
	)
})

test('private JSON-tuple Durable Object name builders live only in the identity module', () => {
	const workerSrcRoot = fileURLToPath(new URL('.', import.meta.url))
	const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

	// Extracted private builders must not return; new DO naming must go through
	// user-scoped-durable-object-name.ts (or connector-session-key for connectors).
	const bannedPrivateBuilders = [
		'function buildStorageRunnerName',
		'function buildPackageServiceName',
		'function buildRealtimeSessionName',
	]
	// Production call sites must not invent tuple DO names inline.
	const inlineIdFromNameTuple = /idFromName\(\s*JSON\.stringify\s*\(/g

	const offenders: Array<string> = []
	const connectorSource = readFileSync(
		join(repoRoot, connectorSessionKeyRelativePath),
		'utf8',
	)
	expect(
		connectorSource.includes('durableObjectNameFromParts'),
		'connector-session-key.ts must build DO names via durableObjectNameFromParts',
	).toBe(true)
	expect(connectorSource).not.toMatch(/JSON\.stringify\(\s*\[/)

	function walk(dir: string) {
		for (const entry of readdirSync(dir)) {
			const fullPath = join(dir, entry)
			const stat = statSync(fullPath)
			if (stat.isDirectory()) {
				if (
					entry === 'node_modules' ||
					entry === 'dist' ||
					entry === '.wrangler'
				) {
					continue
				}
				walk(fullPath)
				continue
			}
			if (!entry.endsWith('.ts')) continue
			if (entry.endsWith('.test.ts') || entry.endsWith('.workers.test.ts')) {
				continue
			}
			const relativePath = relative(repoRoot, fullPath).replaceAll('\\', '/')
			if (relativePath === identityModuleRelativePath) continue
			const source = readFileSync(fullPath, 'utf8')
			for (const banned of bannedPrivateBuilders) {
				if (source.includes(banned)) {
					offenders.push(`${relativePath}: ${banned}`)
				}
			}
			if (inlineIdFromNameTuple.test(source)) {
				offenders.push(`${relativePath}: idFromName(JSON.stringify(...))`)
			}
			inlineIdFromNameTuple.lastIndex = 0
		}
	}

	walk(workerSrcRoot)

	expect(
		offenders,
		'Move private JSON.stringify([userId, ...]) DO name builders into user-scoped-durable-object-name.ts',
	).toEqual([])
})
