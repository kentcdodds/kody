import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { repoApplyPatchCapability } from './repo-apply-patch.ts'
import { repoCommitCapability } from './repo-commit.ts'
import { repoCreateCapability } from './repo-create.ts'
import { repoDeleteCapability } from './repo-delete.ts'
import { repoDiffCapability } from './repo-diff.ts'
import { repoDiscardSessionCapability } from './repo-discard-session.ts'
import { repoEditFilesCapability } from './repo-edit-files.ts'
import { repoGetCheckStatusCapability } from './repo-get-check-status.ts'
import { repoGetGitRemoteCapability } from './repo-get-git-remote.ts'
import { repoGetCapability } from './repo-get.ts'
import { repoGetSessionCapability } from './repo-get-session.ts'
import { repoListCapability } from './repo-list.ts'
import { repoListSessionsCapability } from './repo-list-sessions.ts'
import { repoLogCapability } from './repo-log.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'
import { repoPublishSessionCapability } from './repo-publish-session.ts'
import { repoPromoteToPackageCapability } from './repo-promote-to-package.ts'
import { repoReadFileCapability } from './repo-read-file.ts'
import { repoRebaseSessionCapability } from './repo-rebase-session.ts'
import { repoRestoreCapability } from './repo-restore.ts'
import { repoRunChecksCapability } from './repo-run-checks.ts'
import { repoShowPublishNoteCapability } from './repo-show-publish-note.ts'
import { repoSearchCapability } from './repo-search.ts'
import { repoStatusCapability } from './repo-status.ts'
import { repoTreeCapability } from './repo-tree.ts'
import { repoWriteFileCapability } from './repo-write-file.ts'

export const repoDomain = defineDomain({
	name: capabilityDomainNames.repo,
	description:
		'MCP-native repo sessions for plain repos and saved packages: file-level edit, validate, publish overlays, and git-remote lanes.',
	keywords: ['repo', 'artifact', 'session', 'workspace', 'file', 'search'],
	capabilities: [
		repoCreateCapability,
		repoListCapability,
		repoGetCapability,
		repoDeleteCapability,
		repoGetGitRemoteCapability,
		repoPromoteToPackageCapability,
		repoListSessionsCapability,
		repoOpenSessionCapability,
		repoEditFilesCapability,
		repoApplyPatchCapability,
		repoStatusCapability,
		repoDiffCapability,
		repoLogCapability,
		repoCommitCapability,
		repoRestoreCapability,
		repoGetSessionCapability,
		repoTreeCapability,
		repoReadFileCapability,
		repoWriteFileCapability,
		repoSearchCapability,
		repoRunChecksCapability,
		repoGetCheckStatusCapability,
		repoShowPublishNoteCapability,
		repoPublishSessionCapability,
		repoRebaseSessionCapability,
		repoDiscardSessionCapability,
	],
})
