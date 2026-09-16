import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { jwtSignCapability } from './jwt-sign.ts'
import { secretDeleteCapability } from './secret-delete.ts'
import { secretListCapability } from './secret-list.ts'
import { secretLockCapability } from './secret-lock.ts'
import { secretProviderBindCapability } from './secret-provider-bind.ts'
import { secretProviderListCapability } from './secret-provider-list.ts'
import { secretProviderLockCapability } from './secret-provider-lock.ts'
import { secretProviderUnbindCapability } from './secret-provider-unbind.ts'
import { secretSetCapability } from './secret-set.ts'
import { secretSetManyCapability } from './secret-set-many.ts'

export const secretsDomain = defineDomain({
	name: capabilityDomainNames.secrets,
	description:
		'Server-side secret references (never paste secret values into chat).',
	keywords: [
		'secret',
		'credentials',
		'reference',
		'secure input',
		'lock',
		'usage',
	],
	capabilities: [
		secretListCapability,
		secretSetCapability,
		secretSetManyCapability,
		secretLockCapability,
		secretProviderListCapability,
		secretProviderBindCapability,
		secretProviderUnbindCapability,
		secretProviderLockCapability,
		secretDeleteCapability,
		jwtSignCapability,
	],
})
