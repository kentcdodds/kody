const heavyWorkOffloadGuideId = 'heavy_work_offload'

/**
 * Shared advice appended when a throwaway check/rebuild isolate hits a
 * Durable Object memory or CPU reset. The usual cause is the npm graph
 * (PDF.js-class libraries), not the author's source files.
 */
export function isolatedRunnerResourceLimitAdvice() {
	return (
		'This usually means the npm dependency graph — not just the package ' +
		'source — is too large to bundle inside a Worker isolate. Shrink the ' +
		'graph, or keep the Kody package as a thin orchestrator and offload ' +
		'the heavy work to a process you operate. Load ' +
		`\`coding_guide_get({ guide: "${heavyWorkOffloadGuideId}" })\`.`
	)
}
