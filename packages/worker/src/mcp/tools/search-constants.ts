export const charsPerToken = 4
export const maxTokens = 6_000
/** Official-guide heading sections must stay under this budget (`kody-custom/no-oversized-guide-section`). */
export const maxChars = maxTokens * charsPerToken
export const defaultSearchLimit = 15
export const domainBrowseDefaultLimit = 100
export const defaultMaxResponseSize = 4_000
export const topCapabilityInlineCallShapeCount = 3
export const maxRelatedCapabilityOperations = 20
export const maxBatchEntityRefs = 10
export const maxFusedPackageCandidates = 100
/**
 * Max first-class package-export candidates promoted per package into the
 * ranked pool (widen-then-narrow). Nested `actionMatches` on package index
 * hits stay capped separately.
 */
export const maxPackageExportCandidatesPerPackage = 1
/**
 * Lexical action-match score at or above which a package export may enter the
 * first-pass candidate pool even with a single matched term. Nested
 * actionMatches use a lower floor (0.35); promotion is stricter to avoid
 * flooding non-export queries.
 */
export const packageExportCandidateMinScore = 0.45
export const SEARCH_MEMORY_ENRICHMENT_BUDGET_MS = 1_000
/** Bound wait for post-retrieval D1 acknowledgement; does not cover retrieval. */
export const SEARCH_MEMORY_ACKNOWLEDGEMENT_BUDGET_MS = 250
export const memoryEnrichmentSkippedWarning =
	'Memory enrichment was skipped; returning core results without memory context.'
export const memoryAcknowledgementWarning =
	'Memory acknowledgement did not complete; surfaced memories may repeat in this conversation.'
