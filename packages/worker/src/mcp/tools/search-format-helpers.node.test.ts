import { expect, test } from 'vitest'
import {
	buildPackageMaintainSnippets,
	buildPackageSourceFollowUp,
} from './search-format-helpers.ts'

test('package source follow-up points at repo reads, not packageGet files', () => {
	const followUp = buildPackageSourceFollowUp('package-123')
	const maintain = buildPackageMaintainSnippets('package-123')

	expect(followUp).toContain(
		'packageGet({ package_id: "package-123" }) first for the exact call shape',
	)
	expect(followUp).toContain('That call does not return files.')
	expect(followUp).toContain(
		'repoOpenSession({ target: { kind: "package", package_id: "package-123" } })',
	)
	expect(followUp).toContain('repoReadFile({ session_id, path: "README.md" })')
	expect(followUp).toContain('repoReadFile({ session_id, path: "AGENTS.md" })')
	expect(followUp).toContain(
		'packageGetGitRemote({ package_id: "package-123" })',
	)
	expect(maintain).toEqual({
		gitLane: 'packageGetGitRemote({ package_id: "package-123" })',
		publish: 'packagePublishExternalPush({ package_id: "package-123" })',
		sourceSession:
			'repoOpenSession({ target: { kind: "package", package_id: "package-123" } })',
	})
})
