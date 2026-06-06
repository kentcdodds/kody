import { expect, test } from 'vitest'
import {
	assertPackageSourceOverwriteAllowed,
	assertRestorablePackageSourceSnapshot,
	destructiveOverwriteConfirmationField,
	productionPackageSourceSafetyPolicy,
} from './source-safety-policy.ts'
import { savePackageCapability } from '#mcp/capabilities/packages/save-package.ts'
import { publishExternalPushCapability } from '#mcp/capabilities/packages/publish-external-push.ts'
import { getGitRemoteCapability } from '#mcp/capabilities/packages/get-git-remote.ts'
import { repoPublishSessionCapability } from '#mcp/capabilities/repo/repo-publish-session.ts'
import { repoRunCommandsCapabilityDescription } from '#mcp/capabilities/repo/repo-run-commands-text.ts'
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

test('restorable package source snapshot verification rejects missing and corrupt snapshots with recovery guidance', async () => {
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
})

test('restorable package source snapshot verification accepts a manifest-bearing snapshot', async () => {
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

test('package mutation capabilities surface the canonical production source safety policy', () => {
	expect(savePackageCapability.description).toContain(
		productionPackageSourceSafetyPolicy,
	)
	expect(publishExternalPushCapability.description).not.toContain(
		productionPackageSourceSafetyPolicy,
	)
	expect(getGitRemoteCapability.description).not.toContain(
		productionPackageSourceSafetyPolicy,
	)
	expect(repoPublishSessionCapability.description).not.toContain(
		productionPackageSourceSafetyPolicy,
	)
	expect(repoRunCommandsCapabilityDescription).not.toContain(
		productionPackageSourceSafetyPolicy,
	)
})
