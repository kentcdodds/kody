# 0023: Progressive search disclosure

- **Status:** accepted
- **Date:** 2026-08-19

## Context

Search discovery must teach every user what exists without spending most of the
context window on registry internals. Package and synthesized-provider detail
previously expanded types, URLs, README content, and sibling operations before
the caller knew which part it needed. Empty or broad discovery could also push
callers toward an unbounded registry listing or force them to guess a domain.

## Decision

Search uses progressive disclosure. A package entity defaults to an index:
summary, an export table of subpath plus one-line purpose, job and retriever
names, and the README `Intent` section. Structured content has the same slim
shape. Types, token URLs, and the full README require a follow-up. OpenAPI
capability titles use `METHOD path`; the stable operation slug remains in the
entity reference. Synthesized capability detail reports a related-operation
count rather than expanding up to 20 siblings.

Empty discovery, over-broad search, and `meta_list_capabilities()` without a
domain return a domain index: id, capability count, one-line description, and
two or three samples. `meta_list_capabilities({ domain })` still lists that
domain. Task-specific zero-hit results may suggest the closest domains. Repeated
detail calls with the same `conversationId` may omit boilerplate already taught
earlier in the conversation.

## Consequences

Discovery stays bounded and callers use explicit follow-ups for expensive
detail. Clients must treat entity references, not display titles, as stable
identifiers. We reject returning the full SDK for every entity, an unbounded
`meta_list_capabilities`, and guessing a domain on the caller's behalf.
