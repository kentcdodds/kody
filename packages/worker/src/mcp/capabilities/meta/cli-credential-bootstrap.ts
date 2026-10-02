import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	cliCredentialBootstrapPolicy,
	mintCliCredentialBootstrap,
} from '#worker/api-tokens/cli-credential-bootstrap.ts'
import {
	apiTokenScopeDescriptions,
	apiTokenScopes,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'
import { apiTokenPolicy } from '#worker/api-tokens/service.ts'
import { requireMcpUser } from './require-user.ts'

const scopeSchema = z.enum(
	apiTokenScopes as [ApiTokenScope, ...Array<ApiTokenScope>],
)

const scopeListDescription = Object.entries(apiTokenScopeDescriptions)
	.map(([scope, description]) => `\`${scope}\`: ${description}`)
	.join('\n')

const inputSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(apiTokenPolicy.maxNameLength)
			.optional()
			.describe(
				`Label for the eventual API token (default \`${cliCredentialBootstrapPolicy.defaultName}\`).`,
			),
		scopes: z
			.array(scopeSchema)
			.min(1)
			.optional()
			.describe(
				`Scopes for the eventual \`kody_at_\` (default \`local-execute\` + \`account:read\`). \`<resource>:write\` also grants \`<resource>:read\`.\n${scopeListDescription}`,
			),
		idle_ttl_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxIdleTtlSeconds)
			.optional()
			.describe(
				`Seconds without use before the eventual token expires (default ${apiTokenPolicy.defaultIdleTtlSeconds}).`,
			),
		max_lifetime_seconds: z
			.number()
			.int()
			.min(apiTokenPolicy.minIdleTtlSeconds)
			.max(apiTokenPolicy.maxMaxLifetimeSeconds)
			.optional()
			.describe(
				`Absolute lifetime cap for the eventual token in seconds (default ${apiTokenPolicy.defaultMaxLifetimeSeconds}).`,
			),
		redeem_ttl_seconds: z
			.number()
			.int()
			.min(cliCredentialBootstrapPolicy.minRedeemTtlSeconds)
			.max(cliCredentialBootstrapPolicy.maxRedeemTtlSeconds)
			.optional()
			.describe(
				`How long the one-shot bootstrap code stays redeemable (default ${cliCredentialBootstrapPolicy.defaultRedeemTtlSeconds}).`,
			),
	})
	.strict()

const outputSchema = z.object({
	bootstrap_code: z
		.string()
		.describe(
			'One-shot code for the CLI (`kody_bc_…`). Not an API token. Pass it to `npx @kodycodes/cli auth bootstrap --code …` — do not paste a `kody_at_` into chat.',
		),
	expires_at: z.string().describe('Absolute redeem deadline (ISO-8601).'),
	cli_command: z
		.string()
		.describe(
			'Ready-to-run CLI command that redeems the code into a local `KODY_API_TOKEN` store entry without a second interactive OAuth.',
		),
	name: z.string(),
	scopes: z.array(scopeSchema),
	idle_ttl_seconds: z.number().int(),
	max_lifetime_seconds: z.number().int(),
})

/**
 * Explicit MCP/API-session → CLI credential handoff (ADR 0056). Returns a
 * one-shot bootstrap code, never a `kody_at_`. Dual-exposed as Open API
 * `POST /v1/tokens/bootstrap` and `kody.cliCredentialBootstrap`.
 */
export const cliCredentialBootstrapCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'cliCredentialBootstrap',
		description:
			'Seed CLI `--local` auth from the current Kody session without a second interactive OAuth: returns a one-shot `kody_bc_…` bootstrap code plus a CLI command. The CLI redeems the code over HTTPS for a scoped `kody_at_…` (never returned here). Prefer this over `tokenCreate` for interactive agents already on MCP. Do not paste API tokens into chat. Interactive desktop humans who already ran `kody login` can skip this. CI/headless may still mint `kody_at_` directly.',
		keywords: [
			'cli',
			'local execute',
			'bootstrap',
			'credential',
			'token',
			'login',
			'KODY_API_TOKEN',
			'auth',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const input = inputSchema.parse(args ?? {})
			const parent =
				ctx.openApiPrincipal?.kind === 'token'
					? {
							scopes: ctx.openApiPrincipal.token.scopes,
							maxExpiresAt: ctx.openApiPrincipal.token.max_expires_at,
						}
					: undefined
			return mintCliCredentialBootstrap({
				db: ctx.env.APP_DB,
				userId: user.userId,
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.scopes === undefined ? {} : { scopes: input.scopes }),
				...(input.idle_ttl_seconds === undefined
					? {}
					: { idleTtlSeconds: input.idle_ttl_seconds }),
				...(input.max_lifetime_seconds === undefined
					? {}
					: { maxLifetimeSeconds: input.max_lifetime_seconds }),
				...(input.redeem_ttl_seconds === undefined
					? {}
					: { redeemTtlSeconds: input.redeem_ttl_seconds }),
				...(parent ? { parent } : {}),
			})
		},
	},
)
