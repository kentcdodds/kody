/**
 * Activation milestones — public surface-filtering helper and types.
 *
 * Durable success counts and milestones are recorded atomically inside the
 * RunLog Durable Object on genuine terminal successes. Signup, verification,
 * agent connection, and first fork remain derivable from other durable tables;
 * only run-derived milestones need capture at finish time because run history
 * is retention-pruned.
 *
 * Like other observability helpers, callers that touch RunLog for reads must
 * not throw into the paths they observe.
 */

export {
	type ActivationMilestone,
	type ActivationMilestoneRecord,
	activationMilestoneValues,
	countsTowardPackageActivation,
	type PackageRunSuccessRecord,
} from '#worker/run-records/package-activation-state.ts'
