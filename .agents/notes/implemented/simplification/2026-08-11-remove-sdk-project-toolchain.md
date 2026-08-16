# Agent Note: Remove the SDK project toolchain

Status: implemented

English | [中文](2026-08-11-remove-sdk-project-toolchain.zh.md)

## Problem

The repository carried an unreleased developer-project product with no consumers. `@coomi/create-sdk` generated an editable Cordis project, `@coomi/coomi-scripts` supplied its `coomi-sdk` development, build, start, configuration, and plugin-install commands, `@coomi/coomi-helper` coordinated feature definitions and multi-file project edits, and `@coomi/coomi-telemetry` reported launcher activity. The design aimed to keep generated projects editable while giving creation and later configuration one definition of dependencies, Cordis entries, environment placeholders, and owned files.

No project was created through a public release, and no current repository or external consumer requires that lifecycle. Keeping it meant maintaining four packages, two interactive command products, project templates, package-manager adapters, configuration reconciliation, launcher telemetry, a repository skill, and their tests and documentation without evidence that the product boundary should exist.

The same `scaffold/` group also contained the independently used SDK protocol, TypeScript client, and JSON-RPC server. Those packages serve the Python SDK, the `coomi-sdk` subagent provider, and the JSON-RPC example; their runtime protocol does not depend on generated projects or the removed launcher.

## Decision

The SDK project toolchain is deleted. The `@coomi/create-sdk`, `@coomi/coomi-scripts`, `@coomi/coomi-helper`, and `@coomi/coomi-telemetry` packages, their binaries, tests, templates, feature catalog, project-editing model, package-manager support, launcher telemetry, and repository creation skill have no replacement or compatibility layer. Their workspace, build, test, packaging, documentation-generator, vendoring-rescope, and dependency records are removed with them.

The runtime SDK remains. `@coomi/coomi-sdk-client`, `@coomi/coomi-sdk-protocol`, and `@coomi/coomi-sdk-jsonrpc-server` move unchanged from `packages/scaffold/` to `packages/sdk/`; their npm names and wire behavior do not change. Consumers continue to provide an executable plus an external `cordis.yml`, and the JSON-RPC server remains an ordinary plugin selected by that configuration. The [repository naming contract](../architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) owns this one repository meaning of `SDK` and the surviving package names; this note owns the deleted toolchain.

The canceled developer-project, project-editing, and follow-up-capabilities proposals are deleted rather than retained as active or rejected records. This note preserves the motivation they shared, the decision not to ship that product, the capability given up, and the condition for reconsideration. Frozen archived Agent Notes remain historical snapshots and are not edited.

## Verification

The workspace contains none of the four deleted package names or either removed command product. Package aggregates, source path maps, package metadata, test collection, publication constraints, generated catalogs, dependency notices, and the lockfile resolve only the three runtime SDK packages under `packages/sdk/`. The runtime SDK package tests, its built server smoke, TypeScript consumers, repository documentation gates, build, and hygiene checks pin the surviving behavior and the absence of stale package paths.

## Alternatives considered

**Delete only the initializer.** Rejected because `coomi-sdk`, the shared project model, and launcher telemetry existed to operate projects created by that initializer, and there are no existing projects that need them.

**Keep error-only packages or command aliases.** Rejected because none of the commands shipped publicly. A tombstone would preserve package and executable surface area without a compatibility obligation.

**Delete the runtime SDK stack too.** Rejected because the Python SDK, the out-of-process Harness subagent provider, and the JSON-RPC example are current consumers of the protocol, client, and server.

**Leave the runtime stack under `packages/scaffold/`.** Rejected because nothing left in that group scaffolds a project. `packages/sdk/` states the surviving role directly because `SDK` has one repository meaning: the JSON-RPC client/server protocol used by the supported Python and TypeScript SDKs. Coomi itself is not an SDK project.

## Consequences

Coomi no longer creates or manages standalone developer SDK projects. Automatic project generation, feature-tree configuration, local-plugin scaffolding, project-local development/build/start commands, and developer-cycle launcher telemetry are intentionally unavailable; ordinary applications and runtime distributions continue to compose plugins through their owning packages and `cordis.yml` files.

The repository loses the complete support graph rather than carrying dormant abstractions. Reintroducing a project toolchain requires a real consumer and a new proposal grounded in that consumer's workflow; it does not revive these packages or their deleted compatibility-free formats by default.
