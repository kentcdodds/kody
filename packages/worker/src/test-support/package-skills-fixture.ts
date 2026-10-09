export const packageSkillsFixtureSkillName = 'hello-skill'

export const packageSkillsFixtureSkillMd = `---
name: hello-skill
description: Greets the user by name. Use when the user asks for a friendly hello or wants to see how package skills work.
---

# Hello skill

1. Ask for the person's name if you do not have it.
2. Reply with a short greeting.
3. Read \`references/checklist.md\` before sending anything longer than a sentence.
`

export const packageSkillsFixtureChecklistMd = `# Greeting checklist

- Use the person's name once.
- Keep it under two sentences.
`

/** Package-relative paths for a valid package that ships one skill. */
export function createPackageSkillsFixtureFiles(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		[`skills/${packageSkillsFixtureSkillName}/SKILL.md`]:
			packageSkillsFixtureSkillMd,
		[`skills/${packageSkillsFixtureSkillName}/references/checklist.md`]:
			packageSkillsFixtureChecklistMd,
		...overrides,
	}
}

export function createMalformedPackageSkillsFixtureFiles(): Record<
	string,
	string
> {
	return createPackageSkillsFixtureFiles({
		[`skills/${packageSkillsFixtureSkillName}/SKILL.md`]:
			'---\ndescription: Missing the name field.\n---\n\n# Broken\n',
	})
}
