import { z } from 'zod'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { type ConnectorConfig } from './connector-shared.ts'

const connectorReadinessStatusValues = [
	'ready',
	'missing_prerequisites',
] as const

const connectorReadinessRequirementValues = [
	'client_id',
	'refresh_token',
	'client_secret',
] as const

const connectorReadinessMissingKindValues = [
	'value',
	'secret',
	'config',
] as const

export const connectorReadinessMissingPrerequisiteSchema = z.object({
	kind: z.enum(connectorReadinessMissingKindValues),
	requirement: z.enum(connectorReadinessRequirementValues),
	name: z.string().nullable(),
})

export const connectorReadinessSchema = z.object({
	status: z.enum(connectorReadinessStatusValues),
	authenticatedRequestsReady: z.boolean(),
	available: z.object({
		clientIdValue: z.boolean(),
		accessTokenSecret: z.boolean(),
		refreshTokenSecret: z.boolean().nullable(),
		clientSecretSecret: z.boolean().nullable(),
	}),
	missingPrerequisites: z.array(connectorReadinessMissingPrerequisiteSchema),
})

export type ConnectorReadiness = z.infer<typeof connectorReadinessSchema>
export type ConnectorReadinessMissingPrerequisite = z.infer<
	typeof connectorReadinessMissingPrerequisiteSchema
>

export function getConnectorReadiness(input: {
	connector: ConnectorConfig
	values: Array<Pick<ValueMetadata, 'name' | 'value'>>
	userSecrets: Array<Pick<SecretSearchRow, 'name'>>
}): ConnectorReadiness {
	const userSecretNames = new Set(
		input.userSecrets.map((secret) => secret.name.trim()).filter(Boolean),
	)
	const clientIdValuePresent = input.values.some(
		(value) =>
			value.name === input.connector.clientIdValueName &&
			value.value.trim().length > 0,
	)
	const accessTokenSecretPresent = userSecretNames.has(
		input.connector.accessTokenSecretName,
	)
	const refreshTokenSecretName =
		input.connector.refreshTokenSecretName?.trim() ?? ''
	const refreshTokenSecretPresent =
		refreshTokenSecretName.length > 0
			? userSecretNames.has(refreshTokenSecretName)
			: null
	const clientSecretSecretName =
		input.connector.clientSecretSecretName?.trim() ?? ''
	const clientSecretSecretPresent =
		input.connector.flow === 'confidential'
			? clientSecretSecretName.length > 0
				? userSecretNames.has(clientSecretSecretName)
				: null
			: null
	const missingPrerequisites: Array<ConnectorReadinessMissingPrerequisite> = []

	if (!clientIdValuePresent) {
		missingPrerequisites.push({
			kind: 'value',
			requirement: 'client_id',
			name: input.connector.clientIdValueName,
		})
	}

	if (!refreshTokenSecretName) {
		missingPrerequisites.push({
			kind: 'config',
			requirement: 'refresh_token',
			name: null,
		})
	} else if (!refreshTokenSecretPresent) {
		missingPrerequisites.push({
			kind: 'secret',
			requirement: 'refresh_token',
			name: refreshTokenSecretName,
		})
	}

	if (input.connector.flow === 'confidential') {
		if (!clientSecretSecretName) {
			missingPrerequisites.push({
				kind: 'config',
				requirement: 'client_secret',
				name: null,
			})
		} else if (!clientSecretSecretPresent) {
			missingPrerequisites.push({
				kind: 'secret',
				requirement: 'client_secret',
				name: clientSecretSecretName,
			})
		}
	}

	const authenticatedRequestsReady = missingPrerequisites.length === 0

	return {
		status: authenticatedRequestsReady ? 'ready' : 'missing_prerequisites',
		authenticatedRequestsReady,
		available: {
			clientIdValue: clientIdValuePresent,
			accessTokenSecret: accessTokenSecretPresent,
			refreshTokenSecret: refreshTokenSecretPresent,
			clientSecretSecret: clientSecretSecretPresent,
		},
		missingPrerequisites,
	}
}

export function formatConnectorMissingPrerequisite(
	prerequisite: ConnectorReadinessMissingPrerequisite,
) {
	if (prerequisite.requirement === 'client_id') {
		return `client ID value \`${prerequisite.name ?? 'unknown'}\` is missing`
	}
	if (prerequisite.requirement === 'refresh_token') {
		if (prerequisite.kind === 'config') {
			return 'connector config does not define a refresh token secret name'
		}
		return `user refresh token secret \`${prerequisite.name ?? 'unknown'}\` is missing`
	}
	if (prerequisite.kind === 'config') {
		return 'connector config does not define a client secret secret name'
	}
	return `user client secret \`${prerequisite.name ?? 'unknown'}\` is missing`
}

export function formatConnectorReadinessSummary(
	readiness: ConnectorReadiness,
) {
	if (readiness.authenticatedRequestsReady) {
		return 'Ready for authenticated requests via connector execute helpers.'
	}

	return `Missing prerequisites for authenticated requests: ${readiness.missingPrerequisites
		.map(formatConnectorMissingPrerequisite)
		.join('; ')}.`
}
