import { experimentalGithubRestCapability } from './experimental-github-rest.ts'
import { getNextWorkItemsCapability } from './get-next-work-items.ts'
import { getReviewQueueCapability } from './get-review-queue.ts'
import { summarizePrStatusCapability } from './summarize-pr-status.ts'

export const workTriageCapabilities = [
	summarizePrStatusCapability,
	getReviewQueueCapability,
	getNextWorkItemsCapability,
	experimentalGithubRestCapability,
]
