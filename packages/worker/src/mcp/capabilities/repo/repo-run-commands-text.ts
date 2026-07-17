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
	'Run a parsed git-only workflow in a Kody-managed repo session for MCP-native edits.',
	'Use this for tool-only agents without local filesystem/git access; coding agents that can clone locally should prefer `package_get_git_remote` (saved packages only) plus `package_publish_external_push`.',
	'Commands are newline-separated and parsed, not shell-executed.',
	'Only supported git command forms are accepted; unsupported syntax returns line-specific parse errors.',
	'`git apply` requires heredoc form and a standard unified diff body with `--- a/<path>` / `+++ b/<path>` headers and `@@ ... @@` hunk markers; one heredoc may contain multiple file patches stacked back-to-back, and `/dev/null` on either side creates or deletes a file.',
	'For exact whole-file replacements (especially single-file job sources, freshly generated files, or any edit where you have the full new content), prefer `repo_write_file` over `git apply`; it avoids unified-diff context drift entirely.',
	'For one-file edits to non-package repo-backed scheduled job source, prefer `job_update` with a replacement `code` string; it republishes the job module without needing a repo session.',
	'If the task needs binary assets, many-file refactors, or local build/test loops, tell the user it fits a coding-capable agent (clone via `package_get_git_remote`) better and confirm before proceeding tool-only.',
].join(' ')

export const repoRunCommandsUnsupportedSyntaxDescription = [
	'Only git commands are accepted.',
	'Non-git commands and shell syntax such as pipes (`|`), command substitution (`$()` or backticks), `&&`, or tools like `npm`, `cat`, and `sed` are not supported.',
	'`git clone` is intentionally unsupported because Kody opens and clones repo sessions for you.',
].join(' ')

export const repoRunCommandsSupportedFormsDescription = [
	'Supported command forms exactly:',
	...repoRunCommandsSupportedForms.map((form) => `- \`${form}\``),
	"`git apply` requires heredoc form (e.g. `<<'PATCH' ... PATCH`) and a standard unified diff body. Each file patch needs `--- a/<path>` and `+++ b/<path>` headers plus `@@ -<old>,<n> +<new>,<n> @@` hunk markers; multiple file patches can be stacked back-to-back inside one heredoc, and `/dev/null` on either side creates or deletes a file.",
].join('\n')

export const repoRunCommandsCommandsFieldDescription = [
	'Newline-separated commands parsed by Kody; this field is not shell-executed.',
	repoRunCommandsUnsupportedSyntaxDescription,
	repoRunCommandsSupportedFormsDescription,
].join('\n')
