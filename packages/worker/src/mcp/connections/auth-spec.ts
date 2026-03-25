import { z } from 'zod'

export const providerHttpMethodSchema = z.enum([
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
])

export const providerAuthTransportSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('bearer_header'),
		header_name: z.string().min(1).default('authorization'),
		prefix: z.string().default('Bearer '),
		secret_field: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal('api_key_header'),
		header_name: z.string().min(1),
		prefix: z.string().optional(),
		secret_field: z.string().min(1).optional(),
	}),
	z.object({
		type: z.literal('basic_auth_token'),
		secret_field: z.string().min(1).optional(),
	}),
])

export const providerRequestConfigSchema = z.object({
	base_url: z.string().url(),
	path_prefix: z.string().min(1).optional(),
	graphql_path: z.string().min(1).optional(),
	default_headers: z.record(z.string(), z.string()).optional(),
	auth_transport: providerAuthTransportSchema,
})

export const providerVerificationSchema = z.object({
	method: providerHttpMethodSchema.default('GET'),
	path: z
		.string()
		.min(1)
		.describe('Relative provider path used to verify the stored credentials.'),
	query: z.record(z.string(), z.string()).optional(),
	body: z.unknown().optional(),
})

export const secretFieldSchema = z.object({
	name: z.string().min(1),
	label: z.string().min(1),
	description: z.string().optional(),
	input_type: z.enum(['text', 'password']).default('password'),
})

const manualTokenBaseAuthSpecSchema = z.object({
	instructions: z.array(z.string()).default([]),
	secret_fields: z.array(secretFieldSchema).min(1),
	request: providerRequestConfigSchema,
	verification: providerVerificationSchema.optional(),
})

const manualTokenAuthSpecSchema = manualTokenBaseAuthSpecSchema.extend({
	strategy: z.literal('manual_token'),
})

const apiKeyAuthSpecSchema = manualTokenBaseAuthSpecSchema.extend({
	strategy: z.literal('api_key'),
})

const oauthBaseAuthSpecSchema = z.object({
	authorize_url: z.string().url(),
	token_url: z.string().url(),
	scopes: z.array(z.string()).default([]),
	request: providerRequestConfigSchema,
	verification: providerVerificationSchema.optional(),
	use_pkce: z.boolean().default(true),
	token_auth_method: z
		.enum(['client_secret_post', 'client_secret_basic'])
		.default('client_secret_post'),
})

const oauthPreRegisteredAuthSpecSchema = oauthBaseAuthSpecSchema.extend({
	strategy: z.literal('oauth2_pre_registered_client'),
	secret_fields: z.array(secretFieldSchema).default([
		{
			name: 'client_id',
			label: 'Client ID',
			input_type: 'password',
		},
		{
			name: 'client_secret',
			label: 'Client Secret',
			input_type: 'password',
		},
	]),
})

const oauthDynamicClientAuthSpecSchema = oauthBaseAuthSpecSchema.extend({
	strategy: z.literal('oauth2_dynamic_client'),
	registration_endpoint: z.string().url(),
	client_metadata: z.record(z.string(), z.unknown()).default({}),
	secret_fields: z.array(secretFieldSchema).default([]),
})

export const connectionAuthSpecSchema = z.discriminatedUnion('strategy', [
	manualTokenAuthSpecSchema,
	apiKeyAuthSpecSchema,
	oauthPreRegisteredAuthSpecSchema,
	oauthDynamicClientAuthSpecSchema,
])

export type ConnectionAuthSpec = z.infer<typeof connectionAuthSpecSchema>
export type ProviderRequestConfig = z.infer<typeof providerRequestConfigSchema>
export type ProviderAuthTransport = z.infer<typeof providerAuthTransportSchema>
export type ProviderVerification = z.infer<typeof providerVerificationSchema>
export type SecretField = z.infer<typeof secretFieldSchema>

export const connectionSelectionSchema = z.discriminatedUnion('strategy', [
	z.object({
		strategy: z.literal('default'),
	}),
	z.object({
		strategy: z.literal('label'),
		label: z.string().min(1),
	}),
	z.object({
		strategy: z.literal('id'),
		connection_id: z.string().min(1),
	}),
])

export type ConnectionSelection = z.infer<typeof connectionSelectionSchema>

export function parseConnectionAuthSpec(
	raw: string | unknown,
): ConnectionAuthSpec {
	const value = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
	return connectionAuthSpecSchema.parse(value)
}

export function getAuthSpecSecretFields(spec: ConnectionAuthSpec) {
	return spec.secret_fields
}

export function getPrimarySecretFieldName(spec: ConnectionAuthSpec) {
	if (spec.strategy === 'oauth2_pre_registered_client') {
		return 'access_token'
	}
	if (spec.strategy === 'oauth2_dynamic_client') {
		return 'access_token'
	}
	return spec.secret_fields[0]?.name ?? null
}
