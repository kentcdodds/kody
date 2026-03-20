import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { metaDeleteSkillCapability } from './meta-delete-skill.ts'
import { metaGetSkillCapability } from './meta-get-skill.ts'
import { metaRunSkillCapability } from './meta-run-skill.ts'
import { metaSaveSkillCapability } from './meta-save-skill.ts'
import { metaUpdateSkillCapability } from './meta-update-skill.ts'

export const metaDomain = defineDomain({
	name: capabilityDomainNames.meta,
	description:
		'Save, update, list via search, load, run, and delete user-scoped codemode skills. Save skills only for reasonably repeatable workflows (reusable patterns), not one-off or highly bespoke tasks.',
	keywords: ['skill', 'meta', 'save', 'recipe', 'codemode'],
	capabilities: [
		metaSaveSkillCapability,
		metaUpdateSkillCapability,
		metaDeleteSkillCapability,
		metaGetSkillCapability,
		metaRunSkillCapability,
	],
})
