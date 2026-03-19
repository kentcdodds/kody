# Local agent bridge direction

This document describes an intended direction for connecting `kody` to systems
that live on a private local network, such as devices reachable from a Synology
NAS.

It does **not** describe behavior that exists in the repository today. Treat
this as planning guidance for the shape of a future architecture, not as a
description of the current runtime.

## Goal

Provide a secure, always-on bridge between cloud-hosted MCP tools and devices on
a local network without exposing the local network to inbound public traffic.

## Core idea

The working direction is to run a local agent on the NAS that keeps a persistent
outbound WebSocket connection to the cloud-hosted Worker. Tool calls from
MCP-capable hosts would be translated into command messages, routed through the
cloud layer, executed locally by the agent, and returned over the same
connection.

In other words, the local network would not host a public API. Instead, it
would participate as a connected runtime behind an outbound session.

## Proposed architecture

### Cloud layer

The cloud layer would remain the public MCP-facing surface.

Its role would be to:

- expose a compact MCP tool surface to upstream AI hosts
- translate tool invocations into internal commands
- route commands to the right connected local agent
- manage authentication, session identity, timeouts, and reliability concerns

Durable Objects are the likely coordination point for connection ownership,
message routing, and request/response correlation.

### Local layer

The local layer would be a Bun-based agent running in Docker on the NAS.

Its role would be to:

- initiate and maintain the outbound session to the cloud layer
- authenticate itself and declare what it can do
- receive structured commands and execute them locally
- return results and, when useful, publish state updates upstream

This keeps the network posture simple: the NAS only needs outbound access.

### Device adapters

Device-specific integrations would stay inside the local agent rather than being
spread across the public MCP surface.

Each adapter would own the details for one local system, such as home
automation, audio, or scene control. The adapter boundary is intended to absorb
protocol quirks, connection handling, and local state concerns while presenting
a consistent command-oriented interface to the rest of the agent.

## Communication model

The intended transport is a persistent WebSocket session initiated by the local
agent. Over that connection, the protocol is message-oriented rather than
endpoint-oriented.

At a high level, the flow looks like this:

1. The local agent opens an outbound WebSocket connection to the cloud layer.
2. The agent authenticates and announces its capabilities.
3. The cloud layer routes commands to that connected agent.
4. The agent executes the command locally and sends back a correlated result.
5. The agent may also push state updates when local context changes.

The important design property is that all command traffic moves through that
single WebSocket session using a shared command schema with explicit IDs for
correlation, instead of separate REST endpoints per device or action.

## Design constraints

This direction assumes the following constraints:

- no inbound public connections to the NAS
- a single long-lived connection per local agent
- a unified command schema across all device categories
- strict request/response correlation for every command
- cloud-managed timeout and retry behavior
- reconnect and heartbeat behavior in the local agent

## Responsibility split

The intended responsibility boundary is:

Cloud layer:

- MCP tool exposure
- routing and session ownership
- authentication and trust decisions
- reliability policies such as timeout handling and retries

Local agent:

- local command execution
- device integration
- local state tracking
- capability declaration

## Why this direction fits the project

This direction fits the current project intent well because it keeps the public
MCP surface compact while allowing richer real-world capabilities to sit behind
that surface.

It also has several practical advantages:

- avoids exposing the local network to inbound traffic
- centralizes the cloud-facing control plane in one place
- keeps device-specific complexity close to the devices themselves
- maps naturally to MCP-style tool calling
- creates a path to support multiple agents or sites over time

## What this is not

This direction should not be thought of as "run a REST server on the NAS."

The better mental model is a remote-controlled local runtime:

- the cloud layer sends structured commands
- the agent performs local work
- results and state flow back upstream over the existing session

## Open planning questions

The detailed implementation is intentionally left open, but future design work
will likely need to answer questions such as:

- how agents are provisioned, identified, and rotated securely
- how capabilities should be declared and discovered over time
- which commands should support retries or idempotent replays
- how much local state should be cached versus fetched live
- how multiple agents should be named, targeted, and supervised
