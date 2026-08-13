import { expect, test } from 'vitest'
import {
	gitAuthorIdentityFromUser,
	gitAuthorSetupCommands,
	shellQuote,
} from './git-author-identity.ts'

test('git author identity uses the Kody account and quotes setup commands', () => {
	expect(
		gitAuthorIdentityFromUser({
			email: 'alex@example.com',
			displayName: 'Alex Rivera',
		}),
	).toEqual({ name: 'Alex Rivera', email: 'alex@example.com' })
	expect(
		gitAuthorIdentityFromUser({
			email: '  casey@example.com  ',
			displayName: '  ',
		}),
	).toEqual({ name: 'casey', email: 'casey@example.com' })
	expect(
		gitAuthorIdentityFromUser({
			email: 'newline@example.com',
			displayName: 'Casey\nQuote',
		}),
	).toEqual({ name: 'Casey Quote', email: 'newline@example.com' })
	expect(() =>
		gitAuthorIdentityFromUser({ email: '  ', displayName: 'Casey' }),
	).toThrow('Signed-in Kody account email is required')

	const quoted = gitAuthorSetupCommands({
		name: "O'Brien",
		email: "o'brien@example.com",
	})
	expect(quoted).toEqual([
		`git config --local user.email -- ${shellQuote("o'brien@example.com")}`,
		`git config --local user.name -- ${shellQuote("O'Brien")}`,
	])
	expect(quoted[0]).toContain(`'"'"'`)
	expect(quoted[1]).toContain(`'"'"'`)

	const dashed = gitAuthorSetupCommands({
		name: '-dash-name',
		email: 'dash@example.com',
	})
	expect(dashed).toEqual([
		`git config --local user.email -- 'dash@example.com'`,
		`git config --local user.name -- '-dash-name'`,
	])
})
