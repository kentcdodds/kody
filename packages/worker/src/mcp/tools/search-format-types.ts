import { type IntegrationConfig } from '#mcp/capabilities/integrations/integration-shared.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { type PackageReferencedTypeProjection } from '#worker/package-registry/manifest.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'

export type SearchEntityType =
	| 'capability'
	| 'package'
	| 'secret'
	| 'value'
	| 'integration'

type SearchMatchType =
	| 'capability'
	| 'package'
	| 'value'
	| 'integration'
	| 'secret'
	| 'retriever_result'
	| 'domain'

export type PackageActionMatch = {
	subpath: string
	description: string | null
	typeDefinition: string | null
	functions: Array<{
		name: string
		description: string | null
		typeDefinition: string | null
	}>
	score: number
	matchedTerms: Array<string>
}

export type SearchResultStructuredContent = {
	matches: Array<SlimSearchMatch>
	offline: boolean
	warnings: Array<string>
	guidance?: string
	telemetry?: {
		intent: {
			task: string
			confidence: number
			entityCount: number
			actionCount: number
			constraintCount: number
			topEntities: Array<{
				type: string
				id: string
				confidence: number
			}>
		}
		candidateCounts: Partial<Record<SearchMatchType, number>>
		topResultTypes: Array<SearchMatchType>
		trimmedMatchCount?: number
		responseTrimmed?: boolean
	}
	phaseTimings?: {
		queryUnderstandingMs: number
		candidateGenerationMs: number
		rerankingMs: number
		formattingMs?: number
		rowAndRegistryLoadMs?: number
		retrieversMs?: number
		queryEmbeddingMs?: number
		capabilityCandidatesMs?: number
		packageCandidatesMs?: number
		remoteConnectorStatusMs?: number
		memoryEnrichmentMs?: number
		memoryEnrichmentWaitMs?: number
		memoryAcknowledgementMs?: number
		memoryEnrichmentTimedOut?: boolean
		memoryAcknowledgementTimedOut?: boolean
		memoryEnrichmentFailed?: boolean
		memoryAcknowledgementFailed?: boolean
	}
	memories?: {
		surfaced: Array<{
			id: string
			category: string | null
			status: string
			subject: string
			summary: string
			details: string
			tags: Array<string>
			updatedAt: string
		}>
		suppressedCount: number
		retrievalQuery: string
		retrieverResults?: Array<PackageRetrieverSurfaceResult>
		retrieverWarnings?: Array<string>
	}
	remoteConnectorStatuses?: Array<{
		connectorId: string
		state: string
		connected: boolean
		toolCount: number
	}>
}

export type RelatedCapabilityOperation = {
	name: string
	entityRef: string
	description: string
	method?: string
	path?: string
}

export type RelatedIntegrationPackageSuggestion =
	| {
			source: 'user'
			kodyId: string
			name: string
			description: string
			entityRef: string
	  }
	| {
			source: 'community'
			kodyId: string
			name: string
			description: string
			listingId: string
			publicUrl: string
			trusted: boolean
	  }

export type SlimSearchMatch =
	| {
			type: 'domain'
			id: string
			name: string
			title: string
			description: string
			capabilityCount: number
			sampleCapabilities: Array<string>
			usage: string
	  }
	| {
			type: 'capability'
			id: string
			entityRef: string
			title: string
			description: string
			domain: string
			usage: string
			source?: CapabilitySpec['source']
			remoteConnector?: CapabilitySpec['remoteConnector']
			mcpServer?: CapabilitySpec['mcpServer']
			openApi?: CapabilitySpec['openApi']
			inputTypeDefinition?: string
			inputTypeDefinitionTruncated?: boolean
	  }
	| {
			type: 'package'
			id: string
			entityRef: string
			packageId: string
			kodyId: string
			title: string
			description: string
			usage: string
			rootImportUsage: string
			tags: Array<string>
			hasApp: boolean
			hidden: boolean
			hostedUrl: string | null
			readmeSnippet: {
				path: string
				snippet: string
				truncated: boolean
			} | null
			actionMatches: Array<{
				subpath: string
				importSpecifier: string
				description: string | null
				typeDefinition: string | null
				functions: Array<{
					name: string
					description: string | null
					typeDefinition: string | null
					usage: string
				}>
				score: number
				matchedTerms: Array<string>
			}>
			nextStep?: string
	  }
	| {
			type: 'secret'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
	  }
	| {
			type: 'value'
			id: string
			entityRef: string
			name: string
			title: string
			description: string
			usage: string
			scope: string
			appId: string | null
	  }
	| {
			type: 'integration'
			id: string
			entityRef: string
			name: string
			title: string
			description: string
			usage: string
			flow: string
			tokenUrl: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
			clientIdValueName: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
			authorization: IntegrationConfig['authorization'] | null
			nextStep?: string
	  }
	| {
			type: 'retriever_result'
			id: string
			title: string
			summary: string
			details: string | null
			source: string
			url: string | null
			score: number | null
			packageId: string
			kodyId: string
			retrieverKey: string
			retrieverName: string
	  }

export type SearchEntityDetailStructured =
	| {
			kind: 'entity'
			type: 'capability'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			executeExample: string
			requiredInputFields: Array<string>
			readOnly: boolean
			idempotent: boolean
			destructive: boolean
			source: CapabilitySpec['source']
			remoteConnector?: CapabilitySpec['remoteConnector']
			mcpServer?: CapabilitySpec['mcpServer']
			openApi?: CapabilitySpec['openApi']
			inputTypeDefinition: string
			outputTypeDefinition?: string
			relatedOperations?: Array<RelatedCapabilityOperation>
	  }
	| {
			kind: 'entity'
			type: 'package'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			packageId: string
			kodyId: string
			name: string
			tags: Array<string>
			hasApp: boolean
			hidden: boolean
			hostedUrl: string | null
			appEntry: string | null
			maintain: {
				gitLane: string
				publish: string
			}
			exports: Array<{
				subpath: string
				importSpecifier: string
				runtimeTarget: string | null
				typesPath: string | null
				description: string | null
				typeDefinition: string | null
				functions: Array<{
					name: string
					description: string | null
					typeDefinition: string | null
					referencedTypes: Array<PackageReferencedTypeProjection>
				}>
				referencedTypes: Array<PackageReferencedTypeProjection>
				// Full type source is no longer emitted by default; keep the nullable
				// field for structured-output compatibility with existing clients.
				typesSource: string | null
				externalInvocation: {
					method: 'POST'
					url: string
					path: string
					ownerUsername: string
					kodyId: string
					routeExportName: string
					normalizedExportName: string
					tokenSetupUrl: string
					sourceGuidance: string
				} | null
			}>
			jobs: Array<{
				name: string
				entry: string
				scheduleSummary: string
				enabled: boolean
			}>
			retrievers: Array<{
				key: string
				exportName: string
				name: string
				description: string
				scopes: Array<string>
				timeoutMs: number | null
				maxResults: number | null
			}>
			readme: {
				path: string
				content: string
				truncated: boolean
			} | null
	  }
	| {
			kind: 'entity'
			type: 'secret'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			scope: string
			updatedAt: string
	  }
	| {
			kind: 'entity'
			type: 'value'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			scope: string
			appId: string | null
			value: string
			updatedAt: string
			ttlMs: number | null
	  }
	| {
			kind: 'entity'
			type: 'integration'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			flow: IntegrationConfig['flow']
			tokenUrl: string
			apiBaseUrl: string | null
			clientIdValueName: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
			requiredHosts: Array<string>
			authorization: IntegrationConfig['authorization'] | null
			relatedPackageSuggestions?: Array<RelatedIntegrationPackageSuggestion>
	  }

export type SearchEntityDetail =
	| {
			type: 'capability'
			id: string
			title: string
			description: string
			spec: CapabilitySpec
			relatedOperations?: Array<RelatedCapabilityOperation>
	  }
	| {
			type: 'package'
			id: string
			title: string
			description: string
			record: SavedPackageRecord
			manifest: AuthoredPackageJson
			files: Record<string, string>
			baseUrl: string
			hostedUrl: string | null
			ownerUsername?: string | null
	  }
	| {
			type: 'secret'
			id: string
			title: string
			description: string
			row: SecretSearchRow
	  }
	| {
			type: 'value'
			id: string
			title: string
			description: string
			row: ValueMetadata
	  }
	| {
			type: 'integration'
			id: string
			title: string
			description: string
			row: ValueMetadata
			config: IntegrationConfig
			relatedPackageSuggestions?: Array<RelatedIntegrationPackageSuggestion>
	  }

export type SearchMatch =
	| {
			type: 'domain'
			name: string
			title: string
			description: string
			capabilityCount: number
			sampleCapabilities: Array<string>
	  }
	| {
			type: 'capability'
			name: string
			description: string
			domain: string
			source?: CapabilitySpec['source']
			remoteConnector?: CapabilitySpec['remoteConnector']
			mcpServer?: CapabilitySpec['mcpServer']
			openApi?: CapabilitySpec['openApi']
			inputTypeDefinition?: string
			inputTypeDefinitionTruncated?: boolean
	  }
	| {
			type: 'package'
			packageId: string
			kodyId: string
			name: string
			title: string
			description: string
			tags: Array<string>
			hasApp: boolean
			hidden: boolean
			readmeSnippet?: {
				path: string
				snippet: string
				truncated: boolean
			} | null
			actionMatches?: Array<PackageActionMatch>
	  }
	| {
			type: 'value'
			valueId: string
			name: string
			description: string
			scope: string
			appId: string | null
	  }
	| {
			type: 'integration'
			integrationName: string
			title: string
			description: string
			flow: string
			tokenUrl: string
			apiBaseUrl: string | null
			requiredHosts: Array<string>
			clientIdValueName: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
			authorization?: IntegrationConfig['authorization'] | null
	  }
	| {
			type: 'secret'
			name: string
			description: string
	  }
	| (PackageRetrieverSurfaceResult & {
			type: 'retriever_result'
	  })
