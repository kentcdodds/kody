import { expect, test } from 'vitest'
import {
	assertPackageSourceOverwriteAllowed,
	assertRestorablePackageSourceSnapshot,
	buildPublishedCommitHeadMismatchCallerMessage,
	buildSourceRecoveryProblemMessage,
	destructiveOverwriteConfirmationField,
	isPublishedCommitHeadMismatchMessage,
} from './source-safety-policy.ts'
import { type EntitySourceRow } from './types.ts'

function packageSource(
	overrides: Partial<EntitySourceRow> = {},
): EntitySourceRow {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-06-06T00:00:00.000Z',
		updated_at: '2026-06-06T00:00:00.000Z',
		...overrides,
	}
}

function createEnvWithSnapshot(files: Record<string, string> | null) {
	return {
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: 'text' | 'json') {
				if (type !== 'json' || files == null) return null
				return {
					version: 1,
					sourceId: 'source-1',
					repoId: 'repo-1',
					entityKind: 'package',
					entityId: 'package-1',
					publishedCommit: 'commit-1',
					manifestPath: 'package.json',
					sourceRoot: '/',
					files,
					createdAt: '2026-06-06T00:00:00.000Z',
				}
			},
		},
	} as unknown as Env
}

function createEnvWithRawSnapshot(snapshot: unknown) {
	return {
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: 'text' | 'json') {
				return type === 'json' ? snapshot : null
			},
		},
	} as unknown as Env
}

test('published commit HEAD mismatch messages are detected for caller-error classification', () => {
	const mismatch = buildSourceRecoveryProblemMessage({
		source: packageSource({
			published_commit: 'commit-published',
			repo_id: 'package-1',
		}),
		operation: 'repo_open_session',
		reason:
			'artifact source repo "package-1" default branch HEAD "commit-unpublished" does not match published commit "commit-published"',
	})
	expect(isPublishedCommitHeadMismatchMessage(mismatch)).toBe(true)
	expect(
		isPublishedCommitHeadMismatchMessage(
			buildSourceRecoveryProblemMessage({
				source: packageSource(),
				operation: 'repo_open_session',
				reason: 'artifact source repo "package-1" was not found',
			}),
		),
	).toBe(false)
	expect(buildPublishedCommitHeadMismatchCallerMessage(mismatch)).toContain(
		'package_publish_external_push',
	)
})

test('package source overwrite requires explicit destructive confirmation before snapshot verification', async () => {
	await expect(
		assertPackageSourceOverwriteAllowed({
			env: createEnvWithSnapshot({ 'package.json': '{}' }),
			userId: 'user-1',
			source: packageSource(),
			operation: 'package_save',
		}),
	).rejects.toThrow(destructiveOverwriteConfirmationField)
})

test('restorable package source snapshot verification rejects corrupt snapshots and accepts manifest-bearing backups', async () => {
	await expect(
		assertRestorablePackageSourceSnapshot({
			env: createEnvWithSnapshot(null),
			userId: 'user-1',
			source: packageSource(),
			operation: 'package_publish_external_push force publish',
		}),
	).rejects.toThrow('Stop and report this source recovery problem')

	await expect(
		assertRestorablePackageSourceSnapshot({
			env: createEnvWithSnapshot({ 'src/index.ts': 'export {}' }),
			userId: 'user-1',
			source: packageSource(),
			operation: 'package_publish_external_push force publish',
		}),
	).rejects.toThrow('missing manifest "package.json"')

	await expect(
		assertRestorablePackageSourceSnapshot({
			env: createEnvWithRawSnapshot({
				version: 1,
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				files: null,
			}),
			userId: 'user-1',
			source: packageSource(),
			operation: 'package_publish_external_push force publish',
		}),
	).rejects.toThrow('the published source snapshot is missing or malformed')

	await expect(
		assertRestorablePackageSourceSnapshot({
			env: createEnvWithSnapshot({
				'package.json': '{"name":"@user/demo"}',
				'src/index.ts': 'export {}',
			}),
			userId: 'user-1',
			source: packageSource(),
			operation: 'package_get_git_remote write access',
		}),
	).resolves.toEqual({
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		fileCount: 2,
	})
})
