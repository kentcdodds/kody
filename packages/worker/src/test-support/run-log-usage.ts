/**
 * Minimal in-memory RUN_LOG stub for node-unit usage-reader coverage of
 * concurrent_workflows (authoritative countActiveWorkflowProjections).
 */
export function createInMemoryRunLogUsageEnv(input?: {
	activeWorkflowCount?: number
}) {
	let activeWorkflowCount = input?.activeWorkflowCount ?? 0
	return {
		env: {
			RUN_LOG: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({
					countActiveWorkflowProjections: async () => ({
						count: activeWorkflowCount,
					}),
				}),
			},
		},
		setActiveWorkflowCount(count: number) {
			activeWorkflowCount = Math.max(0, Math.trunc(count) || 0)
		},
	}
}
