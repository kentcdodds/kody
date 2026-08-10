# 0015: Wait on Skills over MCP (SEP-2640); serve skill content via packages

- **Status:** accepted
- **Date:** 2026-08-10

## Context

An early user requested support for
[SEP-2640 "Skills Extension"](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)
(extension id `io.modelcontextprotocol/skills`): serving Agent Skills over MCP
as `skill://` resources with `skills/list` / `skills/get` discovery methods. As
of 2026-08 the SEP is an open draft whose wire format has changed materially
twice, OpenAI's only shipped support is a snapshot importer in the ChatGPT
plugin-submission flow (not live serving from a connected per-user server), and
Claude Code does not consume MCP-served skills end-to-end. Kody's MCP surface is
deliberately two tools (`search` + `execute`) with no Resources primitive,
served across the dual-lane setup in
[0005](./0005-mcp-dual-lane-stateless-migration.md); neither the frozen legacy
SDK v1 lane nor the SDK v2 stateless lane supports registering the extension's
custom JSON-RPC methods today. Packages cannot implement it either: they extend
the capability graph behind search/execute and cannot touch the protocol
surface.

## Decision

Do not implement SEP-2640 now — neither as a platform primitive nor via a
package (the latter is architecturally impossible). Skill-shaped content is
served through the existing compact surface instead: skills authored as package
files, discovered via `search`, read via `execute` (the `coding_guide_get`
progressive-disclosure pattern).

## Consequences

- The MCP surface stays two tools; no Resources support, extension negotiation,
  digest/index machinery, or per-lane custom-method plumbing.
- Hosts that only consume skills via the SEP-2640 wire format will not see
  Kody-hosted skills; hosts that speak search/execute lose nothing.
- Revisit when **all** of: (1) SEP-2640 is merged (leaves draft), (2) a host
  Kody users actually connect from (Claude/Claude Code, Cursor, ChatGPT live
  connections) consumes MCP-served skills live from a connected server rather
  than a submission-time snapshot, and (3) the SDK v2 lane supports the
  extension's custom methods — ideally after the legacy lane retires per 0005.
  The preferred future shape is a thin protocol adapter that projects
  package-backed skill directories as `skill://` resources, keeping packages as
  the source of truth.
