import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { repoApplyPatchCapability } from './repo-apply-patch.ts'
import { repoDiscardSessionCapability } from './repo-discard-session.ts'
import { repoGetSessionCapability } from './repo-get-session.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'
import { repoReadFileCapability } from './repo-read-file.ts'
import { repoRunChecksCapability } from './repo-run-checks.ts'
import { repoSearchCapability } from './repo-search.ts'
import { repoTreeCapability } from './repo-tree.ts'
import { repoWriteFileCapability } from './repo-write-file.ts'

export const repoDomain = defineDomain({
	name: capabilityDomainNames.repo,
	description:
		'Repo-backed source sessions for opening entity workspaces, reading files, applying edits, and searching code inside live session overlays.',
	keywords: ['repo', 'artifact', 'session', 'workspace', 'edit', 'search'],
	capabilities: [
		repoOpenSessionCapability,
		repoGetSessionCapability,
		repoTreeCapability,
		repoReadFileCapability,
		repoWriteFileCapability,
		repoApplyPatchCapability,
		repoSearchCapability,
		repoRunChecksCapability,
		repoDiscardSessionCapability,
	],
})
