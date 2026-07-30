import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { emptyCapabilityInputSchema } from '#mcp/capabilities/types.ts'
import { listPackageCodemods } from '#worker/package-codemods/registry.ts'
import { packageCodemodListOutputSchema } from './package-codemod-shared.ts'

export const packageCodemodListCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_codemod_list',
		description:
			'List registered package codemods available to scan, dry-run, apply, or revert against the signed-in user’s saved packages.',
		keywords: [
			'package',
			'codemod',
			'list',
			'migration',
			'transform',
			'package codemod',
		],
		tags: ['codemod'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema: packageCodemodListOutputSchema,
		async handler(args, ctx) {
			void args
			void ctx
			return { codemods: listPackageCodemods() }
		},
	},
)
