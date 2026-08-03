import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { repoDiscardSessionCapability } from './repo-discard-session.ts'
import { repoGetCheckStatusCapability } from './repo-get-check-status.ts'
import { repoGetSessionCapability } from './repo-get-session.ts'
import { repoListSessionsCapability } from './repo-list-sessions.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'
import { repoPublishSessionCapability } from './repo-publish-session.ts'
import { repoReadFileCapability } from './repo-read-file.ts'
import { repoRebaseSessionCapability } from './repo-rebase-session.ts'
import { repoRunChecksCapability } from './repo-run-checks.ts'
import { repoRunCommandsCapability } from './repo-run-commands.ts'
import { repoShowPublishNoteCapability } from './repo-show-publish-note.ts'
import { repoSearchCapability } from './repo-search.ts'
import { repoTreeCapability } from './repo-tree.ts'
import { repoWriteFileCapability } from './repo-write-file.ts'

export const repoDomain = defineDomain({
	name: capabilityDomainNames.repo,
	description:
		'MCP-native repo sessions for edit, git, validate, and publish overlays.',
	keywords: ['repo', 'artifact', 'session', 'workspace', 'git', 'search'],
	capabilities: [
		repoListSessionsCapability,
		repoOpenSessionCapability,
		repoRunCommandsCapability,
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
