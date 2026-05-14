# Package authoring guide

Use this guide when creating a new Kody package or materially changing an
existing one.

## README Intent section

Package intent is human-authored guidance, not a Kody primitive. Keep it in the
root `README.md` so agents see it during package creation, updates, and search
detail review.

When you create or materially change a package:

1. Include or maintain a `## Intent` section in `README.md`.
2. Capture the user's goal in a few concrete sentences.
3. Ask the user when the intent is unclear or underspecified.
4. Update the intent only when you are confident the goal changed.
5. If the user expands the package scope, update the section with the new scope.

Do not add a package manifest field, runtime object, saved value, or other Kody
primitive solely to track intent.

## Minimal shape

```md
# Package Name

## Intent

This package exists to ...
```

Keep the section concise. It should explain why the package exists and what
success means for the user, not duplicate every implementation detail.
