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
import { repoSearchCapability } from './repo-search.ts'
import { repoTreeCapability } from './repo-tree.ts'

export const repoDomain = defineDomain({
	name: capabilityDomainNames.repo,
	description:
		'Repo-backed source sessions for inspecting, validating, publishing, rebasing, and discarding live source overlays. For saved package authoring, use package_shell_open and package_shell_exec.',
	keywords: ['repo', 'artifact', 'session', 'workspace', 'search', 'publish'],
	capabilities: [
		repoOpenSessionCapability,
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
