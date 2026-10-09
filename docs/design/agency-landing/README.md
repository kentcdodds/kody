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

The current positioning leads with Kody as the cloud for your AI agents: a
shared home for code, tools, data, and execution, with agency delivery and
client ownership supporting that promise.
