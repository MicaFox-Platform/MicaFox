# MicaFox vision

This document outlines the vision and principles of the MicaFox platform.

## Problem

Understanding what applications are doing while they run is often difficult, slow, and expensive.

When an incident happens, engineers frequently lack the runtime information they need. Getting it often requires reproducing issues locally, adding temporary instrumentation, or repeatedly redeploying applications.

Traditional instrumentation is valuable, but it only captures what was anticipated in advance. Missing data often requires code changes and additional deployments before an issue can be investigated.

Commercial runtime tooling exists, but it is often expensive, proprietary, or difficult to adopt for smaller teams and open-source projects.

## Vision

Insight into running applications should be accessible to every team.

Engineers should be able to inspect, understand, and troubleshoot their applications where they actually run, without needing to rely on closed infrastructures or proprietary solutions.

MicaFox aims to provide a simple, open runtime platform that is easy to adopt for any team, and that people and AI agents can work with alike.

## Scope

MicaFox is a platform of SDK modules that run inside the application and share one connection to a hub.

- **Modules.** Runtime debugging comes first: inspecting the state of live applications without changing code or redeploying. Error tracking and logpoints follow as further modules over the same connection, and each module can be adopted on its own.
- **Hub.** One hub application receives what the modules send, controls them, and is where engineers work with the results.
- **Deployment.** The hub runs self-hosted, inside the team's own infrastructure, or as a managed Cloud service.
- **AI agents.** Agents work with the platform through the Model Context Protocol (MCP): they can set breakpoints and logpoints and read what the modules capture, within the same limits and permissions as engineers.

## Open core

The SDK, the protocol and the core of the hub are open source. Features for larger organizations are offered under a commercial license, in a separate part of the repository, on top of the same open core. The open part is complete and useful on its own.

## Principles

- Runtime-first
- Lightweight
- Modular
- Open
- Production-ready
- Safe for the host application
