import { z } from 'zod'

/**
 * How a scaffolded client or a saved OpenAPI provider binding authenticates.
 * All variants reference Kody-side names (integration/provider names and
 * secret names) — never raw credential material. Outbound host approval is
 * always enforced by the integration host allowlist and/or the secret's
 * `allowedHosts` policy; nothing in an OpenAPI spec can widen it.
 */
export const openApiBoundAuthSchema = z.discriminatedUnion('kind', [
	z
		.object({
			kind: z.literal('integration'),
			provider: z
				.string()
				.min(1)
				.describe('Saved integration name (see integration_save).'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('bearerSecret'),
			secretName: z
				.string()
				.min(1)
				.describe('Secret holding a bearer token; sent as Authorization.'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('headerSecret'),
			headerName: z.string().min(1),
			secretName: z
				.string()
				.min(1)
				.describe('Secret sent as the named request header.'),
		})
		.strict(),
	z
		.object({
			kind: z.literal('basicSecrets'),
			usernameSecret: z.string().min(1),
			passwordSecret: z.string().min(1),
		})
		.strict(),
	z.object({ kind: z.literal('none') }).strict(),
])

export type OpenApiBoundAuth = z.infer<typeof openApiBoundAuthSchema>
