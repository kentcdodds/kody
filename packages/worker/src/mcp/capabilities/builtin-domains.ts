import { appsDomain } from './apps/domain.ts'
import { codingDomain } from './coding/domain.ts'
import { emailDomain } from './email/domain.ts'
import { jobsDomain } from './jobs/domain.ts'
import { metaDomain } from './meta/domain.ts'
import { packagesDomain } from './packages/domain.ts'
import { repoDomain } from './repo/domain.ts'
import { secretsDomain } from './secrets/domain.ts'
import { servicesDomain } from './services/domain.ts'
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
	emailDomain,
	jobsDomain,
	metaDomain,
	packagesDomain,
	repoDomain,
	secretsDomain,
	servicesDomain,
	storageDomain,
	valuesDomain,
] as const
