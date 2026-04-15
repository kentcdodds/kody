import { appsDomain } from './apps/domain.ts'
import { codingDomain } from './coding/domain.ts'
import { jobsDomain } from './jobs/domain.ts'
import { metaDomain } from './meta/domain.ts'
import { secretsDomain } from './secrets/domain.ts'
import { storageDomain } from './storage/domain.ts'
import { valuesDomain } from './values/domain.ts'

/**
 * Builtin domains merged by `buildCapabilityRegistry` in `registry.ts`.
 *
 * For optional dynamic additions later: call
 * `buildCapabilityRegistry([...builtinDomains, ...extraDomains])` where each
 * extra domain is a real `DomainSpec` with bundled `Capability` handlers
 * (Workers typically snapshot capabilities at deploy time).
 */
export const builtinDomains = [
	appsDomain,
	codingDomain,
	jobsDomain,
	metaDomain,
	secretsDomain,
	storageDomain,
	valuesDomain,
] as const
