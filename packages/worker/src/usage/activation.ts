/**
 * Activation milestones.
 *
 * Activation is "a package that ran successfully at least twice" — the point
 * where a user has something durable working unattended, rather than something
 * they got running once during setup.
 *
 * Only run-derived milestones live here. Signup, verification, agent
 * connection, and first fork are all derivable from durable tables and are
 * read directly by the insights dashboard; storing them again would create two
 * sources of truth. Run history is different: `package_runtime_runs` is
 * retention-pruned, so a milestone that is not captured when it happens cannot
 * be recovered.
 *
 * Like `recordUsage`, these writes never throw. Instrumentation must not break
 * the paths it observes.
 */

export type ActivationMilestone = 'package_run_succeeded' | 'package_activated'

export type ActivationEnv = { APP_DB?: D1Database }

const insertMilestoneStatement = `
INSERT OR IGNORE INTO user_activation_milestones (
	user_id, milestone, reached_at, package_id
) VALUES (?1, ?2, ?3, ?4)
`.trim()

const countSuccessfulRunsStatement = `
SELECT COUNT(*) AS n
FROM package_runtime_runs
WHERE user_id = ?1 AND package_id = ?2 AND status = 'success'
`.trim()

const hasMilestoneStatement = `
SELECT 1 AS n
FROM user_activation_milestones
WHERE user_id = ?1 AND milestone = ?2
`.trim()

/**
 * Record one milestone for one user. Idempotent: the first write wins, so
 * `reached_at` always reflects when the user first got there.
 */
export async function recordActivationMilestone(
	env: ActivationEnv,
	input: {
		userId: string
		milestone: ActivationMilestone
		packageId?: string | null
		reachedAt?: string
	},
): Promise<void> {
	if (!env.APP_DB || !input.userId) return
	try {
		await env.APP_DB.prepare(insertMilestoneStatement)
			.bind(
				input.userId,
				input.milestone,
				input.reachedAt ?? new Date().toISOString(),
				input.packageId ?? null,
			)
			.run()
	} catch (error) {
		console.warn('activation-milestone-failed', error)
	}
}

/**
 * Called after a package run finishes successfully.
 *
 * Records the first successful run, and promotes the user to activated once
 * any single package has succeeded twice. Both milestones are terminal, so
 * once a user is activated this costs one indexed lookup that returns a row
 * and nothing else runs.
 */
export async function recordSuccessfulPackageRun(
	env: ActivationEnv,
	input: { userId: string; packageId: string },
): Promise<void> {
	if (!env.APP_DB || !input.userId || !input.packageId) return
	try {
		if (await hasMilestone(env, input.userId, 'package_activated')) return

		await recordActivationMilestone(env, {
			userId: input.userId,
			milestone: 'package_run_succeeded',
			packageId: input.packageId,
		})

		// Counted per package rather than per user: two different packages that
		// each ran once is a user still in setup, not a user with something
		// working.
		const row = await env.APP_DB.prepare(countSuccessfulRunsStatement)
			.bind(input.userId, input.packageId)
			.first<{ n: number }>()
		if (Number(row?.n ?? 0) < 2) return

		await recordActivationMilestone(env, {
			userId: input.userId,
			milestone: 'package_activated',
			packageId: input.packageId,
		})
	} catch (error) {
		console.warn('activation-run-record-failed', error)
	}
}

async function hasMilestone(
	env: ActivationEnv,
	userId: string,
	milestone: ActivationMilestone,
) {
	if (!env.APP_DB) return false
	const row = await env.APP_DB.prepare(hasMilestoneStatement)
		.bind(userId, milestone)
		.first<{ n: number }>()
	return row != null
}
