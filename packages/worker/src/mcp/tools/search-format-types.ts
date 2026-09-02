import { type IntegrationConfig } from '#mcp/capabilities/integrations/integration-shared.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'

export const searchEntityRefTypes = [
	'capability',
	'guide',
	'integration',
	'package',
	'secret',
] as const

export type SearchEntityType = (typeof searchEntityRefTypes)[number]

type SearchMatchType =
	| 'capability'
	| 'guide'
	| 'package'
	| 'integration'
	| 'secret'
	| 'retriever_result'
	| 'domain'
	| 'provider'

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
	waiting?: {
		count: number
		items: Array<{
			id: string
			kind: string
			title: string
			why: string
			doLabel: string
			href: string
			severity: string
		}>
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
			subject: string
			summary: string
		}>
		suppressedCount: number
		retrievalQuery: string
		retrieverResults?: Array<PackageRetrieverSurfaceResult>
		retrieverWarnings?: Array<string>
	}
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
			type: 'provider'
			id: string
			title: string
			description: string
			domain: string
			source: 'mcp-server'
			capabilityCount: number
			sampleCapabilities: Array<string>
			usage: string
			wrappingPackage: {
				kodyId: string
				name: string
				entityRef: string
			} | null
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
			mcpServer?: CapabilitySpec['mcpServer']
			inputTypeDefinition?: string
			inputTypeDefinitionTruncated?: boolean
	  }
	| {
			type: 'guide'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			category: 'platform' | 'provider'
			slug: string
			provider: string | null
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
			/** Platform (built-in) scope username; live for execute and platform-account packages. Person-account saved packages must fork. */
			platformScope?: string | null
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
			listingAhead?: true
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
			clientId: string
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
			mcpServer?: CapabilitySpec['mcpServer']
			inputTypeDefinition: string
			outputTypeDefinition?: string
			relatedOperations?: Array<RelatedCapabilityOperation>
			relatedOperationCount?: number
	  }
	| {
			kind: 'entity'
			type: 'guide'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			category: 'platform' | 'provider'
			slug: string
			body: string
			provider: string | null
			lastVerified: string | null
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
			/** Platform (built-in) scope username; live for execute and platform-account packages. Person-account saved packages must fork. */
			platformScope?: string | null
			hostedUrl: string | null
			appEntry: string | null
			maintain: {
				gitLane: string
				publish: string
			}
			exports: Array<{
				subpath: string
				description: string | null
			}>
			jobs: Array<{
				name: string
			}>
			retrievers: Array<{
				key: string
				name: string
			}>
			webhooks: Array<{
				name: string
				exportName: string
				responseMode: 'ack' | 'sync'
				replay: {
					timestampHeader?: string
					timestampFormat?:
						| 'unix-seconds'
						| 'unix-millis'
						| 'iso-8601'
						| 'stripe-signature'
					toleranceSeconds?: number
					deliveryIdHeader?: string
				} | null
				signedPayload: 'body' | 'timestamp.body' | null
			}>
			readmeIntent: {
				path: string
				content: string
				truncated: boolean
			} | null
			followUp: string
			listingAhead: boolean | null
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
			type: 'integration'
			id: string
			entityRef: string
			title: string
			description: string
			usage: string
			flow: IntegrationConfig['flow']
			tokenUrl: string
			apiBaseUrl: string | null
			clientId: string
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
			relatedOperationCount?: number
	  }
	| {
			type: 'guide'
			id: string
			title: string
			description: string
			body: string
			slug: string
			category: 'platform' | 'provider'
			provider: string | null
			lastVerified: string | null
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
			/** Platform (built-in) scope username when owned by a platform account. */
			platformScope?: string | null
			listingAhead: boolean | null
	  }
	| {
			type: 'secret'
			id: string
			title: string
			description: string
			row: SecretSearchRow
	  }
	| {
			type: 'integration'
			id: string
			title: string
			description: string
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
			type: 'provider'
			id: string
			title: string
			description: string
			domain: string
			source: 'mcp-server'
			capabilityCount: number
			sampleCapabilities: Array<string>
			usage: string
			wrappingPackage: {
				kodyId: string
				name: string
				entityRef: string
			} | null
	  }
	| {
			type: 'capability'
			name: string
			title?: string
			description: string
			domain: string
			source?: CapabilitySpec['source']
			mcpServer?: CapabilitySpec['mcpServer']
			inputTypeDefinition?: string
			inputTypeDefinitionTruncated?: boolean
	  }
	| {
			type: 'guide'
			id: string
			title: string
			description: string
			category: 'platform' | 'provider'
			slug: string
			provider: string | null
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
			/** Platform (built-in) scope username when owned by a platform account. */
			platformScope?: string | null
			readmeSnippet?: {
				path: string
				snippet: string
				truncated: boolean
			} | null
			actionMatches?: Array<PackageActionMatch>
			/** Present only when the source community listing pin moved past this fork. */
			listingAhead?: true
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
			clientId: string
			clientSecretSecretName: string | null
			accessTokenSecretName: string
			refreshTokenSecretName: string | null
			authorization?: IntegrationConfig['authorization'] | null
			lastAuthFailure?: IntegrationConfig['lastAuthFailure']
	  }
	| {
			type: 'secret'
			name: string
			description: string
	  }
	| (PackageRetrieverSurfaceResult & {
			type: 'retriever_result'
	  })
