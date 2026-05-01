export function buildPackageEventWorkflowId(input: {
	packageId: string
	workflowName: string
	planDate: string
	eventKey: string
}) {
	const packageId = normalizeWorkflowIdSegment(input.packageId, 'packageId')
	const workflowName = normalizeWorkflowIdSegment(
		input.workflowName,
		'workflowName',
	)
	const planDate = normalizeWorkflowIdSegment(input.planDate, 'planDate')
	const eventKey = normalizeWorkflowIdSegment(input.eventKey, 'eventKey')
	return `package-event:${packageId}:${workflowName}:${planDate}:${eventKey}`
}

function normalizeWorkflowIdSegment(value: string, field: string) {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new Error(`Package event workflow ${field} must not be empty.`)
	}
	return encodeURIComponent(trimmed)
}
