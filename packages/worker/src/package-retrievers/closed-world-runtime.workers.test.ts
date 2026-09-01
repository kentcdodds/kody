import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { retrieverOutboundFetchDeniedMessage } from '#mcp/executor.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import {
	packageStorageRetrieverReadOnlyMessage,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'

test(
	'closed-world retriever runtime can read packageStorage but cannot write, fetch, or bind write helpers',
	{ timeout: 90_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		await ensureEntitlementTestSchema(env.APP_DB)
		const userId = `user-${crypto.randomUUID()}`
		const packageId = crypto.randomUUID()
		await storageRunnerRpc({
			env,
			userId,
			storageId: buildPackageStorageId(packageId),
		}).setValue({
			key: 'seed',
			value: 'hello',
		})
		const callerContext = createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId,
				email: 'retriever@example.com',
				displayName: 'Retriever',
			},
		})
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					"import { packageStorage, packages, events, workflows } from 'kody:runtime'",
					'export default async function main() {',
					'\tconst bucket = packageStorage()',
					"\tconst read = await bucket.get('seed')",
					'\tlet writeError = null',
					'\ttry {',
					"\t\tawait bucket.set('next', 'nope')",
					'\t} catch (error) {',
					'\t\twriteError = error instanceof Error ? error.message : String(error)',
					'\t}',
					'\tlet sqlError = null',
					'\ttry {',
					"\t\tawait bucket.sql('create table if not exists notes (name text)')",
					'\t} catch (error) {',
					'\t\tsqlError = error instanceof Error ? error.message : String(error)',
					'\t}',
					'\tlet fetchError = null',
					'\ttry {',
					"\t\tawait fetch('https://example.com')",
					'\t} catch (error) {',
					'\t\tfetchError = error instanceof Error ? error.message : String(error)',
					'\t}',
					'\treturn {',
					'\t\tread,',
					'\t\twriteError,',
					'\t\tsqlError,',
					'\t\tfetchError,',
					'\t\tpackagesBound: packages != null,',
					'\t\teventsBound: events != null,',
					'\t\tworkflowsBound: workflows != null,',
					'\t}',
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				closedWorldRetrieverRuntime: true,
				packageContext: {
					packageId,
					kodyId: 'notes',
					sourceId: 'source-notes',
				},
			},
		)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			read: 'hello',
			writeError: packageStorageRetrieverReadOnlyMessage,
			sqlError: expect.stringMatching(/Read-only storage\.sql/i),
			fetchError: retrieverOutboundFetchDeniedMessage,
			packagesBound: false,
			eventsBound: false,
			workflowsBound: false,
		})
		expect(
			await storageRunnerRpc({
				env,
				userId,
				storageId: buildPackageStorageId(packageId),
			}).getValue({ key: 'next' }),
		).toMatchObject({ value: null })
	},
)
