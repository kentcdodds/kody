import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	durableObjectNameFromParts,
	jobManagerDurableObjectName,
	mailboxDurableObjectName,
	mcpClientHubDurableObjectName,
	packageRealtimeSessionDurableObjectName,
	repoSessionDurableObjectName,
	repoSessionIndexDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	userMeterDurableObjectName,
} from './user-scoped-durable-object-name.ts'

const identityModuleRelativePath =
	'packages/worker/src/user-scoped-durable-object-name.ts'

test('user-scoped Durable Object name helpers preserve frozen idFromName contracts', () => {
	// JobManager, RunLog, UserMeter, Mailbox, and RepoSessionIndex historically
	// do not trim; the untrimmed userId is the frozen idFromName wire format.
	// `ownerIdFromStored` would trim, so these existing ids are branded without
	// changing bytes. The builders must keep returning those exact names.
	const existingId = 'user-aaa' as OwnerId
	const paddedExistingId = '  user-aaa  ' as OwnerId
	const untrimmed = [
		jobManagerDurableObjectName,
		runLogDurableObjectName,
		userMeterDurableObjectName,
		mailboxDurableObjectName,
		repoSessionIndexDurableObjectName,
	]
	expect(
		untrimmed.map((name) => [name(existingId), name(paddedExistingId)]),
	).toEqual(untrimmed.map(() => ['user-aaa', '  user-aaa  ']))

	expect([
		mcpClientHubDurableObjectName(paddedExistingId),
		storageRunnerDurableObjectName(existingId, 'job:1'),
		packageRealtimeSessionDurableObjectName({
			userId: existingId,
			packageId: 'pkg-1',
		}),
		repoSessionDurableObjectName('session-1'),
		durableObjectNameFromParts(['user-aaa', 'a/b']),
	]).toEqual([
		'user-aaa',
		'["user-aaa","job:1"]',
		'["user-aaa","pkg-1"]',
		'session-1',
		'["user-aaa","a/b"]',
	])
	expect(durableObjectNameFromParts(['user-aaa', 'a'])).not.toBe(
		durableObjectNameFromParts(['user-aaa', 'a/b']),
	)
})

test('private JSON-tuple Durable Object name builders live only in the identity module', () => {
	const workerSrcRoot = fileURLToPath(new URL('.', import.meta.url))
	const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

	// Extracted private builders must not return; new DO naming must go through
	// user-scoped-durable-object-name.ts.
	const bannedPrivateBuilders = [
		'function buildStorageRunnerName',
		'function buildRealtimeSessionName',
	]
	// Production call sites must not invent tuple DO names inline.
	const inlineIdFromNameTuple = /idFromName\(\s*JSON\.stringify\s*\(/g

	const offenders: Array<string> = []

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
