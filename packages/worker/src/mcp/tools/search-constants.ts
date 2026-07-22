export const charsPerToken = 4
export const maxTokens = 6_000
export const maxChars = maxTokens * charsPerToken
export const defaultSearchLimit = 15
export const defaultMaxResponseSize = 4_000
export const topCapabilityInlineCallShapeCount = 3
export const maxRelatedCapabilityOperations = 20
export const maxBatchEntityRefs = 10
export const maxFusedPackageCandidates = 100
export const SEARCH_MEMORY_ENRICHMENT_BUDGET_MS = 1_000
/** Bound wait for post-retrieval D1 acknowledgement; does not cover retrieval. */
export const SEARCH_MEMORY_ACKNOWLEDGEMENT_BUDGET_MS = 250
export const memoryEnrichmentSkippedWarning =
	'Memory enrichment was skipped; returning core results without memory context.'
export const memoryAcknowledgementWarning =
	'Memory acknowledgement did not complete; surfaced memories may repeat in this conversation.'
