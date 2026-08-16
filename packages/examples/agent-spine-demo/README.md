# @coomi/coomi-agent-spine-demo

English | [中文](README.zh.md)

The **default executor-less, UI-less agent spine** as ONE Cordis bundle plugin. It loads the fixed set of services every harness agent needs, including the local skill provider, and forwards the loop's `agents` list as its own config — so an app package composes a working agent by adding only an entry point and the swappable backends.

Read this package for the whole plugin tree and its composition order.

## The tree it loads

`apply(ctx, config)` mounts each of these as a child of the bundle fiber:

```
@coomi/cordis-plugin-timer  timer service (writes nothing to stdout)
@coomi/coomi-llm              abstract LLM service + content-block vocabulary
@coomi/coomi-session          event-sourced session log + store
@coomi/coomi-session-title    log-backed title service + deterministic fallback
@coomi/coomi-system-prompt    prompt-section + tool-schema assembly
@coomi/coomi-tools            registry + guarded pre/around/post/final-result pipeline
@coomi/coomi-skill            skill provider registry
@coomi/coomi-skill-filesystem      local filesystem skill provider
@coomi/coomi-agent            agent registry + initiator scope + agent/* events
@coomi/coomi-goal             optional persisted same-session goal domain
@coomi/coomi-tool-goal        optional model-facing goal controls
@coomi/coomi-goal-round-driver     optional same-session goal-round driver
@coomi/coomi-llm-retry        provider-routed request retry policy
@coomi/coomi-jobs-local      generic background-job registry
@coomi/coomi-invariants       configurable invariant registry service
@coomi/coomi-session/invariant
@coomi/coomi-agent/invariant
@coomi/coomi-scope/invariant
@coomi/coomi-agent-loop/invariant
                                  package-owned relational checks
@coomi/coomi-tool-bash        the model-facing bash schema (unless toolBash=false)
@coomi/coomi-agent-instructions  AGENTS.md/CLAUDE.md workspace context loader
@coomi/coomi-tool-skill       session-prefix skill catalog + model-facing loader schema
@coomi/coomi-tool-jobs       job_output/job_list/job_kill schemas + completion notices
@coomi/coomi-agent-loop       THE concrete loop (gets the forwarded `agents`)
                                  (coomi-system-prompt gets the forwarded `persona`)
```

## What it deliberately leaves OUTSIDE the bundle

The spine is everything COMMON to every entry point. The swappable and entry-point-coupled pieces stay out, picked by whatever loads the bundle:

- **the LLM adapter** — the bundle ships the abstract `llm` service; the leaf registers a concrete adapter on `ctx.llm` (`llm-deepseek`, `llm-pi-ai`, `llm-replay`).
- **model-backed session-title providers** — the bundle mounts the fallback service with overridable example limits (5 words, 40 fallback bytes, 80 accepted-title bytes); a leaf may opt into exactly one first-prompt or all-messages LLM provider.
- **the bash executor** — the bundle ships `tool-bash` (the consumer schema); the leaf provides `ctx.shell` (`bash-local` or a sandboxed impl).
- **non-local skill providers** — the bundle ships the skill registry, the local filesystem provider, and the `skill` tool; deployments can add other providers such as embedded or remote catalogs as siblings.
- **entry point + per-app infrastructure** — headless, ACP, and JSON-RPC app packages own transport, stdout, and reload choices. `timer` stays in the spine because it is common and stdout-silent.

This applies the [Service Definition / Service Provider / Consumer separation](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md) at the composition level: the bundle owns the shared spine, the leaf owns the backends, the app package owns the entry point.

## Config

```ts
import type { Config } from '@coomi/coomi-agent-spine-demo'
// { agents?, maxParallelToolCalls?, includeHarnessIdentity?, includeRuntimeContext?, persona?, toolOrder?, tools?, coomiHome?, sessionTitle?, skills?, workspaceContext, toolBash?, jobs?, toolJobs?, goals?, invariants? }
// workspaceContext requires { maxBytes } or false; the other owner schemas supply defaults.
```

The bundle forwards each field to the child that owns it. App packages supply any pre-created agents: headless and JSON-RPC compositions create `main`, while the ACP app creates agents on demand at `session/new`. `includeRuntimeContext: false` is forwarded to `coomi-system-prompt` and suppresses all dynamic context snapshots for fresh sessions without disabling their policy services. Prompt, tool, title, skill, agent-instructions, invariant, goal, and task settings retain the schemas and defaults documented by their owning packages; `jobs.maxConcurrentJobsPerOwner` configures the local provider independently of the model-facing `toolJobs` controls. `pickSpineConfig()` copies only fields owned by this bundle, and conflicting `coomiHome` values fail during composition.

For example, `{ invariants: { enabled: true, package_allowlist: ['^@coomi/coomi-'], package_blocklist: ['agent-loop$'] } }` keeps the package-owned companions mounted but suppresses the blocked owner. Blocklist matches override allowlist matches; see [`coomi-invariants`](../../runtime-diagnostics/invariants/README.md) for regex and lifecycle rules.

## Why a code bundle, not a shared YAML include

A YAML include can deduplicate config but cannot own a bin or provide entry-point defaults. The ACP app package makes protocol-pure stdout wiring the default, though a leaf can still add an unsafe logger. Bundle children register services in the root isolate-keyed store, so injected leaf siblings see them without load-order coupling.

The retry policy may repeat a failed request in a new numbered step. Retry status, provider errors, and failed partial chunks stay outside model history; each provider attempt can still incur billing, always mode has no attempt limit, entry points derive usage across every logged step, and the reconstructed request preserves the prior prefix for provider cache reuse.

## Model Experience

Indirectly, through `coomi-system-prompt`, `coomi-tool-skill`, `coomi-tool-bash`, `coomi-tools`, and `coomi-llm-retry`, plus `coomi-tool-goal` and goal-round prompts when `goals` is enabled. The bundle adds no model-bound wrapper content of its own.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Most of the spine set is fixed in code** — `apply()` always mounts the core services; config can omit bundled goals, skills, bash, and task-control tools, but swapping the loop or dropping another spine member means composing a different bundle.
- **The invariant service and companions remain fixed members** — `invariants.enabled: false` or package filters suppress checks but do not remove the service or companion registrations; Session's always-on validation and freezing are separate.
