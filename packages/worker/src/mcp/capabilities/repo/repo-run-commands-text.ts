export const repoRunCommandsSupportedForms = [
	'git status [--short]',
	'git diff',
	"git apply <<'PATCH' ... PATCH",
	'git add <path>',
	'git rm <path>',
	'git commit -m "message"',
	'git log [--depth N]',
	'git branch [name] / git branch -d <name>',
	'git checkout <ref> / git checkout -b <branch> [--force]',
	'git fetch [remote] [ref]',
	'git pull [remote] [ref]',
	'git push [remote] [ref] [--force]',
	'git remote, git remote -v, git remote add <name> <url>, git remote remove <name>',
] as const

export const repoRunCommandsCapabilityDescription = [
	'Run a parsed git-only workflow in a repo session.',
	'Commands are newline-separated and parsed, not shell-executed.',
	'Only supported git command forms are accepted; unsupported syntax returns line-specific parse errors.',
].join(' ')

export const repoRunCommandsUnsupportedSyntaxDescription = [
	'Only git commands are accepted.',
	'Non-git commands and shell syntax such as pipes (`|`), command substitution (`$()` or backticks), `&&`, or tools like `npm`, `cat`, and `sed` are not supported.',
	'`git clone` is intentionally unsupported because Kody opens and clones repo sessions for you.',
].join(' ')

export const repoRunCommandsSupportedFormsDescription = [
	'Supported command forms exactly:',
	...repoRunCommandsSupportedForms.map((form) => `- \`${form}\``),
].join('\n')

export const repoRunCommandsCommandsFieldDescription = [
	'Newline-separated commands parsed by Kody; this field is not shell-executed.',
	repoRunCommandsUnsupportedSyntaxDescription,
	repoRunCommandsSupportedFormsDescription,
].join('\n')

export const repoRunCommandsExecuteSummary = [
	'commands are newline-separated, parsed, git-only workflows, not shell execution',
].join(' ')
