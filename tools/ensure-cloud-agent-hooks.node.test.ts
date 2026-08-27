import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
	ensureCloudAgentHooks,
	findAgentHooksDir,
	huskyHandlerDir,
	huskyUserHookNames,
} from './ensure-cloud-agent-hooks.ts'

async function createLayout(options?: { includeCommitMsg?: boolean }) {
	const root = await mkdtemp(join(tmpdir(), 'cloud-agent-hooks-'))
	const repoRoot = join(root, 'repo')
	const homeDir = join(root, 'home')
	const agentHooksDir = join(homeDir, '.cursor', 'agent-hooks', 'abcd')
	const huskyDir = join(repoRoot, '.husky')
	const huskyHandler = join(huskyDir, '_')

	await mkdir(agentHooksDir, { recursive: true })
	await mkdir(huskyHandler, { recursive: true })
	await writeFile(join(agentHooksDir, '.dispatcher'), '#!/bin/bash\n', {
		mode: 0o755,
	})
	await writeFile(join(huskyHandler, 'h'), '#!/usr/bin/env sh\n', {
		mode: 0o755,
	})
	for (const hookName of huskyUserHookNames) {
		if (hookName === 'commit-msg' && options?.includeCommitMsg === false) {
			continue
		}
		await writeFile(join(huskyDir, hookName), `npm run ${hookName}\n`)
		await writeFile(
			join(huskyHandler, hookName),
			'#!/usr/bin/env sh\n. ./h\n',
			{
				mode: 0o755,
			},
		)
	}

	return {
		root,
		repoRoot,
		homeDir,
		agentHooksDir,
		[Symbol.asyncDispose]: async () => {
			await rm(root, { recursive: true, force: true })
		},
	}
}

test('findAgentHooksDir picks the first dispatcher directory and ignores empties', async () => {
	await using layout = await createLayout()
	const empty = join(layout.homeDir, '.cursor', 'agent-hooks', 'aaaa')
	await mkdir(empty, { recursive: true })
	expect(
		findAgentHooksDir(join(layout.homeDir, '.cursor', 'agent-hooks')),
	).toBe(layout.agentHooksDir)
	expect(findAgentHooksDir(join(layout.root, 'missing'))).toBeNull()
})

test('ensureCloudAgentHooks no-ops on a machine without Cursor agent-hooks', async () => {
	await using layout = await createLayout()
	const calls: Array<string> = []
	const result = ensureCloudAgentHooks({
		repoRoot: layout.repoRoot,
		homeDir: join(layout.root, 'laptop'),
		gitHooksPath: {
			get: () => '.husky/_',
			set: (hooksPath) => {
				calls.push(hooksPath)
			},
		},
	})
	expect(result).toEqual({ status: 'skipped', reason: 'no-agent-hooks' })
	expect(calls).toEqual([])
})

test('ensureCloudAgentHooks composes the dispatcher with Husky _ handlers', async () => {
	await using layout = await createLayout()
	await writeFile(
		join(layout.agentHooksDir, '.cursor-original-hooks-path'),
		`${layout.repoRoot}/.git/hooks\n`,
	)
	symlinkSync('.dispatcher', join(layout.agentHooksDir, 'pre-commit'))
	const calls: Array<string> = []
	const result = ensureCloudAgentHooks({
		repoRoot: layout.repoRoot,
		homeDir: layout.homeDir,
		gitHooksPath: {
			get: () => '.husky/_',
			set: (hooksPath) => {
				calls.push(hooksPath)
			},
		},
	})
	expect(result).toEqual({
		status: 'composed',
		agentHooksDir: layout.agentHooksDir,
		originalHooksPath: huskyHandlerDir(layout.repoRoot),
		restoredHooksPath: true,
		linkedHookNames: ['pre-push', 'pre-commit', 'commit-msg'],
	})
	expect(calls).toEqual([layout.agentHooksDir])
	expect(
		readFileSync(
			join(layout.agentHooksDir, '.cursor-original-hooks-path'),
			'utf8',
		),
	).toBe(`${huskyHandlerDir(layout.repoRoot)}\n`)
	expect(readlinkSync(join(layout.agentHooksDir, 'pre-push'))).toBe(
		'.dispatcher',
	)
	expect(readlinkSync(join(layout.agentHooksDir, 'pre-commit'))).toBe(
		'.dispatcher',
	)
	expect(readlinkSync(join(layout.agentHooksDir, 'commit-msg'))).toBe(
		'.dispatcher',
	)
	expect(huskyHandlerDir(layout.repoRoot).endsWith('/.husky/_')).toBe(true)
})

test('ensureCloudAgentHooks is idempotent and skips hooks without a user script', async () => {
	await using layout = await createLayout({ includeCommitMsg: false })
	const first = ensureCloudAgentHooks({
		repoRoot: layout.repoRoot,
		homeDir: layout.homeDir,
		gitHooksPath: {
			get: () => layout.agentHooksDir,
			set: () => {
				throw new Error('should not reset hooksPath when already composed')
			},
		},
	})
	expect(first.status).toBe('composed')
	if (first.status !== 'composed') return
	expect(first.restoredHooksPath).toBe(false)
	expect(first.linkedHookNames).toEqual(['pre-push', 'pre-commit'])
	expect(existsSync(join(layout.agentHooksDir, 'commit-msg'))).toBe(false)

	const second = ensureCloudAgentHooks({
		repoRoot: layout.repoRoot,
		homeDir: layout.homeDir,
		gitHooksPath: {
			get: () => layout.agentHooksDir,
			set: () => {
				throw new Error('should not reset hooksPath on a second compose')
			},
		},
	})
	expect(second).toEqual(first)
})

test('ensureCloudAgentHooks refuses to compose when Husky handlers are missing', async () => {
	await using layout = await createLayout()
	await rm(join(layout.repoRoot, '.husky', '_'), { recursive: true })
	expect(() =>
		ensureCloudAgentHooks({
			repoRoot: layout.repoRoot,
			homeDir: layout.homeDir,
			gitHooksPath: {
				get: () => null,
				set: () => {},
			},
		}),
	).toThrow(/Husky handler directory is missing/)
})
