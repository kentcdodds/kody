import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { pythonExecuteFlagKey } from '#universal/feature-flags/registry.ts'
import { pythonExecuteFlagOffMessage } from '#mcp/python-execute/language.ts'
import {
	pythonPackageMaxExports,
	pythonPackageMaxSourceChars,
	readPythonPackageExport,
	type PythonPackageManifest,
} from '#mcp/python-execute/package-sketch.ts'
import { runPythonExecute } from '#mcp/python-execute/run-python-execute.ts'

const exportNameSchema = z
	.string()
	.regex(/^[a-z][a-z0-9_]{0,63}$/)
	.describe(
		'Export name on the manifest. Each export is a Python module that defines main(params).',
	)

const manifestSchema = z.object({
	name: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,63}$/)
		.describe('Lowercase kebab-case package name. In-memory only.'),
	language: z.literal('python'),
	exports: z
		.record(
			z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
			z.string().min(1).max(pythonPackageMaxSourceChars),
		)
		.refine((exports) => {
			const count = Object.keys(exports).length
			return count > 0 && count <= pythonPackageMaxExports
		}, `Include 1 to ${pythonPackageMaxExports} export modules.`),
})

export const pythonPackageInvokeCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'pythonPackageInvoke',
		description:
			'Run one export from an in-memory experimental Python package. Each export is a module with async def main(params) or def main(params), and it calls capabilities with await kody.call(name, args). Saved-package publish, search, jobs, and entitlements stay on TypeScript packages. Requires the python-execute experiment.',
		keywords: ['python', 'package', 'experiment', 'execute'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		featureFlag: pythonExecuteFlagKey,
		inputSchema: z.object({
			manifest: manifestSchema.describe(
				'In-memory Python package. The manifest is the request body; nothing is stored.',
			),
			export: exportNameSchema,
			params: z
				.record(z.string(), z.unknown())
				.optional()
				.describe('JSON object passed to main(params).'),
		}),
		outputSchema: z.object({
			ok: z.boolean(),
			exportName: z.string(),
			result: z.unknown().optional(),
			error: z.string().optional(),
			taxonomy: z.string().nullable().optional(),
			logs: z.array(z.string()),
			metrics: z.unknown().optional(),
		}),
		async handler(args, ctx) {
			const flags = await resolveCallerFeatureFlags(ctx.env, ctx.callerContext)
			if (flags[pythonExecuteFlagKey] !== true) {
				return {
					ok: false,
					exportName: args.export,
					error: pythonExecuteFlagOffMessage,
					taxonomy: 'contract' as const,
					logs: [],
				}
			}
			let source: string
			try {
				source = readPythonPackageExport(
					args.manifest as PythonPackageManifest,
					args.export,
				)
			} catch (cause) {
				return {
					ok: false,
					exportName: args.export,
					error: getErrorMessage(cause),
					taxonomy: 'contract' as const,
					logs: [],
				}
			}
			// registry.ts imports this capability's domain. Load it after the
			// module graph has finished initializing.
			const { getCapabilityRegistryForContext } =
				await import('#mcp/capabilities/registry.ts')
			const registry = await getCapabilityRegistryForContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
			})
			const run = await runPythonExecute({
				env: ctx.env,
				callerContext: ctx.callerContext,
				code: source,
				params: args.params,
				capabilityRegistry: registry,
				waitUntil: ctx.waitUntil,
			})
			if (run.error) {
				return {
					ok: false,
					exportName: args.export,
					error: run.error,
					taxonomy: run.python.taxonomy,
					logs: run.logs,
					metrics: run.python,
				}
			}
			return {
				ok: true,
				exportName: args.export,
				result: run.result,
				taxonomy: null,
				logs: run.logs,
				metrics: run.python,
			}
		},
	},
)
