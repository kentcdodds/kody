import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { metaDeleteSkillCapability } from './meta-delete-skill.ts'
import { metaGetHomeConnectorStatusCapability } from './meta-get-home-connector-status.ts'
import { metaGetSkillCapability } from './meta-get-skill.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'
import { metaListSkillCollectionsCapability } from './meta-list-skill-collections.ts'
import { metaRunSkillCapability } from './meta-run-skill.ts'
import { metaSaveSkillCapability } from './meta-save-skill.ts'

export const metaDomain = defineDomain({
	name: capabilityDomainNames.meta,
	description:
		'Save, list via search, load, run, and delete user-scoped codemode skills. Skill saves upsert by unique name per user. Inspect the current runtime capability registry when search results seem incomplete. Save skills only for reasonably repeatable workflows (reusable patterns), not one-off or highly bespoke tasks.',
	keywords: ['skill', 'meta', 'save', 'recipe', 'codemode', 'capabilities'],
	capabilities: [
		metaListCapabilitiesCapability,
		metaGetHomeConnectorStatusCapability,
		metaListSkillCollectionsCapability,
		metaSaveSkillCapability,
		metaDeleteSkillCapability,
		metaGetSkillCapability,
		metaRunSkillCapability,
	],
})
