import { spawnSync } from 'node:child_process'
import { resolveLocalBinary } from '../tools/node-runtime.ts'

function quoteSql(value: string) {
	return `'${value.replace(/'/g, "''")}'`
}

export function executeE2eD1Command(sql: string) {
	const wranglerBin = resolveLocalBinary('wrangler')
	const result = spawnSync(
		wranglerBin,
		[
			'd1',
			'execute',
			'APP_DB',
			'--local',
			'--persist-to',
			'.wrangler/state/e2e',
			'--command',
			sql,
		],
		{
			encoding: 'utf8',
			stdio: 'pipe',
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
			},
		},
	)

	if (result.status !== 0) {
		throw new Error(
			`Failed to execute E2E D1 command:\n${result.stdout}\n${result.stderr}`,
		)
	}
}

export function assignRoleInE2eDatabase(email: string, role: string) {
	const sql = `
INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ${quoteSql(email)} AND r.name = ${quoteSql(role)};`.trim()
	executeE2eD1Command(sql)
}
