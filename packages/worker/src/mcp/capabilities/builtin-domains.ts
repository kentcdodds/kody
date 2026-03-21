import { codingDomain } from './coding/domain.ts'
import { mathDomain } from './math/domain.ts'
import { metaDomain } from './meta/domain.ts'

/**
 * Builtin domains merged by `buildCapabilityRegistry` in `registry.ts`.
 *
 * For optional dynamic additions later: call
 * `buildCapabilityRegistry([...builtinDomains, ...extraDomains])` where each
 * extra domain is a real `DomainSpec` with bundled `Capability` handlers
 * (Workers typically snapshot capabilities at deploy time).
 */
export const builtinDomains = [mathDomain, codingDomain, metaDomain] as const
