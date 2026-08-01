/**
 * Minimal in-memory RUN_LOG stub for node-unit usage-reader coverage of
 * concurrent_workflows (authoritative countActiveWorkflowProjections).
 */
export function createInMemoryRunLogUsageEnv() {
	const activeWorkflowCounts = new Map<string, number>()
	return {
		env: {
			RUN_LOG: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: (id: DurableObjectId) => ({
					countActiveWorkflowProjections: async () => ({
						count: activeWorkflowCounts.get(String(id)) ?? 0,
					}),
				}),
			},
		},
		setActiveWorkflowCount(id: string, count: number) {
			activeWorkflowCounts.set(id, Math.max(0, Math.trunc(count) || 0))
		},
	}
}
