import { defineDomain } from '../define-domain.ts'
import { capabilityDomainNames } from '../domain-metadata.ts'
import { doMathCapability } from './do-math.ts'

export const mathDomain = defineDomain({
	name: capabilityDomainNames.math,
	description:
		'Simple arithmetic and calculator-style operations over numbers.',
	capabilities: [doMathCapability],
})
