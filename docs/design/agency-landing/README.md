# Agency landing page design

Interactive pre-sale design for discussion. The copy assumes the finished
Teams experience: client organizations, shared workflows, permissions,
ownership, and handoff. Client names and workflow data are illustrative.

Serve the repository root:

```sh
python3 -m http.server 8768 --bind 127.0.0.1
```

Open <http://127.0.0.1:8768/docs/design/agency-landing/>.
The page uses the repository's existing fonts and logo.

Switch between monthly invoicing, nightly audits, and client onboarding.
Each example has an app view and an AI-agent view. The demo buttons open a
placeholder dialog; a real booking destination is required before publishing.
No workflows execute, permissions change, or leads are collected.

The [research notes](./research.md) explain the competitor and adjacent-product
patterns behind the revised design. Production routing and booking integration
are outside this draft.

The current positioning is “The agent cloud for your business.” It targets
business teams and agencies with shared tools, organization ownership, and
controlled access. Agency examples show delivery across client organizations.
It makes no enterprise compliance or certification claims.

The hero illustration uses Kody's existing lantern character as a reference.
Three separate lantern-lit workspaces connect through a shared cloud, showing
shared infrastructure with distinct team or client spaces. The generated PNG
is stored locally in `assets/agent-cloud-lanterns.png` and includes transparency.
