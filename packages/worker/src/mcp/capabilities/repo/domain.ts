import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { repoDiscardSessionCapability } from './repo-discard-session.ts'
import { repoGetCheckStatusCapability } from './repo-get-check-status.ts'
import { repoGetSessionCapability } from './repo-get-session.ts'
import { repoOpenSessionCapability } from './repo-open-session.ts'
import { repoPublishSessionCapability } from './repo-publish-session.ts'
import { repoReadFileCapability } from './repo-read-file.ts'
import { repoRebaseSessionCapability } from './repo-rebase-session.ts'
import { repoRunChecksCapability } from './repo-run-checks.ts'
import { repoRunCommandsCapability } from './repo-run-commands.ts'
import { repoSearchCapability } from './repo-search.ts'
import { repoTreeCapability } from './repo-tree.ts'

export const repoDomain = defineDomain({
	name: capabilityDomainNames.repo,
	description:
		'Repo-backed source sessions for opening entity workspaces, running constrained git command workflows, and searching code inside live session overlays.',
	keywords: ['repo', 'artifact', 'session', 'workspace', 'git', 'search'],
	capabilities: [
		repoOpenSessionCapability,
		repoRunCommandsCapability,
		repoGetSessionCapability,
		repoTreeCapability,
		repoReadFileCapability,
		repoSearchCapability,
		repoRunChecksCapability,
		repoGetCheckStatusCapability,
		repoPublishSessionCapability,
		repoRebaseSessionCapability,
		repoDiscardSessionCapability,
	],
})
