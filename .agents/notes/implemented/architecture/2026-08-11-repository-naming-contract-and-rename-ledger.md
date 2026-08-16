# Agent Note: Repository naming contract and pre-release rename ledger

Status: implemented

English | [中文](2026-08-11-repository-naming-contract-and-rename-ledger.zh.md)

## Problem

The repository had grown faster than some names. Several package names described the first implementation instead of the capability. Several classes used `Service` even when they were registries, runtimes, engines, controllers, or resolvers. Some `ctx` keys were singular for registries and plural for one engine. Some provider names said `local` even though they used replaceable filesystem or subprocess services and could run in another execution world.

These names are not harmless. A name tells a contributor where a responsibility starts and stops. `Store` suggests data access. `Registry` suggests registrations and lookup. `Runtime` suggests live execution and lifecycle. When one word is used for all three, callers cannot tell which object owns policy, work, or state without reading the implementation.

The repository also used `SDK` in two meanings. The supported Python and TypeScript clients use the JSON-RPC SDK protocol. The project as a whole is Coomi, not an SDK project. The removed SDK project toolchain made the broad meaning obsolete, but prose and names preserved parts of it.

The last pre-release window made repository-wide renames cheap. Keeping weak names would have turned accidental vocabulary into a compatibility contract.

## Decision

The repository uses every current name in this ledger. This decision changes names only; package responsibilities, service boundaries, behavior, defaults, and data models stay the same. A name that exposes a bad boundary requires a separate proposed Agent Note for that boundary change.

Each renamed family has one vocabulary. Its directory, npm package name, imports, Cordis plugin name, `ctx` key, public types, directly coupled event or tool identifiers, configuration, tests, fixtures, examples, generated references, and current documentation use the current name where the ledger names those interfaces. No alias, compatibility package, duplicate service key, dual event name, or fallback parser remains. The repository rejects the old name.

No family exposes two public vocabularies.

### Use `SDK` for one thing

`SDK` means the JSON-RPC-based client/server protocol used by the supported Python and TypeScript SDKs. The repository keeps `@coomi/coomi-sdk-client`, `@coomi/coomi-sdk-protocol`, and the wire identity `coomi-desktop-sdk-runtime`; the JSON-RPC server belongs to the same family. Coomi itself is not an SDK, and the removed project generator, launcher, helper, and launcher telemetry packages stay absent.

This decision partially supersedes three active decisions. It replaces the retained `bash/`, `pty/`, and `self-modification/` group names and both deferred package targets in the [package-regrouping decision](2026-07-29-package-regrouping.md). It replaces only the repository-wide SDK claim in the [SDK project toolchain removal](../simplification/2026-08-11-remove-sdk-project-toolchain.md), which remains the owner of the deletion and the surviving runtime SDK. It replaces only the package-name rationale in the [tool-call timeout policy](2026-07-07-tool-call-timeout-policy.md); the timeout mechanism and its `guard/timeout-policy/` home remain unchanged.

Other implemented notes that use a renamed package, path, or type are not superseded when their boundary and rationale remain intact. They carry the current factual names. The three partially superseded decisions link back to this decision.

### Name the role that exists

Use a common, concrete noun. Name the stable responsibility, not the first implementation, the current folder, or a possible future expansion. Do not add a word that carries no information. Do not shorten a name by deleting the word that distinguishes its scope.

An interface package names the capability. An implementation package adds the mechanism, protocol, environment, or vendor that distinguishes that implementation. Use `local` only when same-host execution is part of the contract. Do not use it for a provider that happens to read local-looking paths through replaceable `ctx.fs` or starts work through replaceable `ctx.subprocess`.

Use a singular `ctx` key for one engine, runtime, policy, controller, resolver, store, or current configuration. Use a plural key for a registry or a service that owns multiple named members. The class role and key number must agree. A plural key does not by itself make an object a registry; its operations and ownership do. Do not reuse one Cordis `Context` key for incompatible host and client declarations. TypeScript declaration merging sees both faces even when they use separate runtime contexts. Add the role suffix when the natural plural already belongs to another face.

Use `Service` only when no sharper role is honest. `GoalService` and `SessionTitleService` are valid retained names because each owns a domain service whose work is not accurately reduced to storage, registration, or one execution mechanism.

### Role words are contracts

| Word | Use it when | Do not use it when |
|---|---|---|
| `Controller` | The object accepts commands or user intent and changes one existing domain or presentation state. It coordinates a bounded state transition. | The object executes arbitrary work, owns a provider fleet, or only converts values for display. |
| `Store` | The object owns one data set and mainly provides create, read, update, delete, snapshot, or subscription operations for that data. | It validates a state machine, arbitrates authority, dispatches work, owns provider precedence, or coordinates several domains. A map inside a class does not make the class a store. |
| `Directory` | The object exposes entries for discovery or selection. Its consumer asks what choices exist and reads their metadata. | Producers register arbitrary implementations into it, or callers execute work through it. A directory can be backed by a registry, but the two faces are not the same. |
| `Presenter` | The object is a pure conversion from domain values or tool arguments to render intent. It has no I/O, subscription, mutation, or lifecycle ownership. | It reads services, changes state, or controls when work runs. Those jobs belong to a controller or runtime. |
| `Registry` | The object owns a dynamic set of named registrations. It defines lookup, duplicate or precedence rules, registration lifetime, and disposal. | The main caller contract is dispatch, execution, cancellation, policy enforcement, or orchestration. A runtime can contain a registry as an internal part. |
| `Runtime` | The object runs live work. It owns dispatch, cancellation, provider coordination, or operation lifecycle across calls. | The object only stores records, returns a catalog, resolves one value, or holds configuration. `Runtime` is not a generic replacement for `Service`. |
| `Resolver` | The object computes or locates one answer from supplied inputs, usually without owning the answer's lifecycle. | It owns a mutable collection or a long-running execution lifecycle. |
| `Binder` | The object attaches one declared interface to the caller's context or lifecycle and returns the bound value. | It owns the bound value as a collection, controls its domain state, or merely converts data. |
| `Engine` | The object implements a domain algorithm or stateful execution model, such as workflow, compaction, or query evaluation. | It only selects a provider or forwards a request across a protocol boundary. |
| `Policy` | The object decides what is allowed, selected, limited, or observed. | It performs the mechanism that the decision permits. Keep policy and executor names separate. |
| `Executor` | The object runs an explicit request or resolved specification in one capability. | It owns a broad application lifecycle or a catalog of providers. |
| `Gateway` | The object adapts a process, network, RPC, or API boundary and translates between the two sides. | It only registers same-process services or stores metadata. |
| `Provider` | The object supplies one implementation of a capability definition. Add a mechanism or vendor qualifier when more than one provider can exist. | It is the capability definition, the registry of providers, or the consumer-facing runtime. |
| `Backend` | The object implements a replaceable lower-level persistence, transport, or execution backend behind a defined interface. | It is a user-facing service or only a returned reference to one live object. |
| `Handle` | The value is a reference to one live resource and controls or observes that resource. | The object creates and manages the whole resource pool. Do not use `Owner` or the vague `Resource` when `Handle` or a sharper manager role fits. |
| `Config` | The object owns one resolved configuration value or one tightly bounded configuration record and its update contract. | It stores a general collection, executes work, or exposes unrelated settings. |
| `Service` | The object owns a cohesive domain service whose authority cannot be stated honestly as one of the sharper roles above. | The name is used only because the class extends Cordis `Service`, or because choosing the real role takes more thought. |

The practical tests are direct. If callers mainly call `register()` and receive a disposer, use `Registry`. If callers mainly call `run()`, `dispatch()`, `cancel()`, or `execute()`, use `Runtime`, `Engine`, or `Executor`. If callers mainly browse choices, use `Directory`. If an object mainly binds one specification to caller-owned context and lifetime, use `Binder`. If the object only maps domain data to UI data, use `Presenter`. If it also changes state, it is not a presenter.

### Use qualifiers that add information

Keep a protocol or dialect name when it distinguishes implementations. Keep `Bash`, `Pwsh`, `JSON-RPC`, `SQLite`, `JSONL`, `OpenTelemetry`, `Claude Code`, and `E2B` where the implementation depends on that mechanism. Do not put `LLM` into a compaction backend name when every current backend already uses the LLM seam; `basic` is the honest neutral name until a more specific algorithm name exists.

Do not invent a `process sandbox` concept. The current `sandbox` family already names its product responsibility. This decision does not change that responsibility.

Use title case for initialisms inside PascalCase identifiers: `Ui`, `Llm`, `JsonRpc`, and `ApiProxy`. Use the conventional uppercase form in prose and package names where applicable: UI, LLM, JSON-RPC, and API. `Typert` is the exact product spelling in identifiers and prose; do not write `TypeRT`, `TypeRt`, or `Typert` with another internal split.

Do not remove an intentional vendor qualifier to avoid repetition. `coomi-subagent-coomi-sdk` names the Coomi SDK provider and avoids confusion with another SDK. Its private class becomes `SdkSubagentProvider` because the class also needs to say what it provides.

### Put the rule in project documentation

The paired package-creation guide at `docs/cookbook/adding-a-package.md` contains the full role-word contract, and `packages/AGENTS.md` links to it. The terminology table and root project description give `SDK` and `Typert` one meaning. This Agent Note owns the rationale and rejected alternatives; the guide owns the rule contributors follow.

## Rename ledger

The tables record public and repository-wide renames. The `Current` column holds the current name. Private local variables use the same vocabulary when they refer to the same role. A retained low-level or product-visible name is stated where a broad replacement would be wrong.

### Runtime SDK

| Former | Current | Reason |
|---|---|---|
| `@coomi/coomi-jsonrpc` | `@coomi/coomi-sdk-jsonrpc-server` | It is the server half of the SDK protocol. `jsonrpc` alone names an encoding; `sdk-jsonrpc-server` gives the family, mechanism, and role. |
| `HarnessSdkServer` | `HarnessSdkJsonRpcServer` | The class is one JSON-RPC server implementation, not every possible SDK server. |

Keep `@coomi/coomi-sdk-client`, `@coomi/coomi-sdk-protocol`, and `coomi-desktop-sdk-runtime`. Exclude `@coomi/create-sdk`, `@coomi/coomi-scripts`, `@coomi/coomi-helper`, and `@coomi/coomi-telemetry`; the separate removal decision deletes them and their support graph.

### Shell and terminal

| Former | Current | Reason |
|---|---|---|
| `packages/bash/` | `packages/shell/` | The group contains the dialect-neutral executor seam, Bash and PowerShell implementations, environment support, and shell tools. |
| `@coomi/coomi-bash`, `ctx.bash` | `@coomi/coomi-shell`, `ctx.shell` | PowerShell already implements this seam. The capability is shell execution, not Bash. |
| Dialect-neutral `BashExecutor`, `BashExecRequest`, `BashExecSpec`, `BashProcess`, `BashRunResult`, `BashSandboxInfo`, `BashProcessRead`, and `BashProcessStatus` names | Corresponding `Shell*` names | These types cross both Bash and PowerShell implementations. Leaf types that describe Bash syntax or behavior keep `Bash`. |
| `BASH_SETTINGS_NAMESPACE`, settings namespace `bash` | `SHELL_SETTINGS_NAMESPACE`, settings namespace `shell` | Both shell providers register this capability-owned settings section. The constant and durable namespace must use the capability name. |
| `@coomi/coomi-bash-env`, `ctx.bashEnv`, `BashEnvRegistry` | `@coomi/coomi-shell-env`, `ctx.shellEnv`, `ShellEnvRegistry` | The environment registry is shared by Bash and PowerShell tools. |
| `docs/subsystems/bash.md` | `docs/subsystems/shell.md` | The subsystem page documents the dialect-neutral capability. |
| `packages/pty/` | `packages/terminal/` | The package family owns persistent terminal sessions. Raw PTY allocation remains in the subprocess layer. |
| `@coomi/coomi-pty`, `ctx.pty`, `PtyService` | `@coomi/coomi-terminal`, `ctx.terminals`, `TerminalSessionService` | Callers manage multiple named terminal sessions. They do not allocate raw PTYs through this service. |
| Public high-level `Pty*` session and backend names | `Terminal*` names | The public abstraction is a terminal session. Keep low-level `SubprocessTerminal*` names because they already name the substrate. |
| `@coomi/coomi-pty-local`, `LocalPtyBackend` | `@coomi/coomi-terminal-bash`, `BashTerminalBackend` | The provider depends on Bash prompt and shell behavior. `local` hides the actual dialect. |
| `@coomi/coomi-tool-pty` | `@coomi/coomi-tool-terminal` | The model-facing tools are already `terminal_*`; the package should use the same product noun. |
| `tool-bash-persistent` in the former PTY family | `shell/tool-bash-persistent/` | The tool is a Bash tool and belongs with shell tools. Keep its npm name: `persistent` distinguishes it from one-shot `bash`, while `bash-terminal` would blur the product tool with the terminal-session family. |
| `docs/subsystems/pty.md` | `docs/subsystems/terminal.md` | The page documents terminal sessions, not raw PTY allocation. |

Keep the Bash- and PowerShell-specific leaf packages, plugin ids, types, and tools. Their dialect names are accurate.

### Language server and jobs

| Former | Current | Reason |
|---|---|---|
| `@coomi/coomi-lsp-local` | `@coomi/coomi-lsp-stdio` | The provider speaks LSP over stdio through replaceable filesystem and subprocess services. It is not necessarily local. |
| `packages/tasks/` | `packages/jobs/` | The family owns detached tool jobs. `jobs` is short and avoids collision with user task or todo concepts. |
| `@coomi/coomi-tasks`, `ctx.tasks`, `TaskService` | `@coomi/coomi-jobs`, `ctx.jobs`, `JobRegistry` | The service registers, owns, observes, waits for, and cancels multiple background jobs. It is a registry, not a general task service. |
| Public `TaskId`, `TaskKindMap`, `TaskStart`, `TaskHooks`, `TaskOutcome`, `TaskSnapshot`, `TaskRead`, and `TaskDoneListener` names | Corresponding `Job*` names | These types belong to the renamed job domain. `JobId` is shorter and clearer than `BackgroundTaskId` or `BgTaskId`. |
| `@coomi/coomi-tasks-local`, `LocalTaskService` | `@coomi/coomi-jobs-local`, `LocalJobRegistry` | This is the process-local provider of the job registry. Here `local` is meaningful because the jobs and callbacks live in one process. |
| `@coomi/coomi-tool-tasks` | `@coomi/coomi-tool-jobs` | The consumer controls the job registry and should use the same domain noun. |
| `ToolTasks`, `toolTasks`, `ToolTasksConfigSchema`, `PublicTaskSnapshot`, `publicTask`, `validateTaskId` | Corresponding `*Jobs`, `*Job*`, and `validateJobId` names | Imports, forwarded config, public tool values, and helpers are part of the same job domain. Keeping `Task` after the package rename would create a second vocabulary for one feature. |
| `task_output`, `task_list`, `task_kill` | `job_output`, `job_list`, `job_kill` | These model tools act on jobs, not user tasks. `run_in_background` returns a `JobId`. |
| `@coomi/coomi-client-ui-task`, `client/ui-task/` | `@coomi/coomi-client-ui-jobs`, `client/ui-jobs/` | The client package presents the background-job collection. It is not one user task. |
| `TaskView`, wire frame `session/tasks`, `tasksBySession` | `JobView`, wire frame `session/jobs`, `jobsBySession` | The browser contract and its mirror expose the same job domain as the registry and tools. |
| `docs/subsystems/tasks.md` | `docs/subsystems/jobs.md` | The subsystem page must use the public job vocabulary. |

Keep the base LSP package, `ctx.lsp`, LSP protocol types, and the LSP tool. The seam deliberately exposes language-server semantics; only its provider qualifier is wrong.

### Input triggers, tool presentation, permission presets, and user questions

| Former | Current | Reason |
|---|---|---|
| `@coomi/coomi-client-ui-slash`, `ui-slash/` | `@coomi/coomi-client-ui-input-trigger`, `ui-input-trigger/` | The client handles `/`, `@`, keyboard arbitration, candidate menus, and programmatic launch. It is not only slash commands. |
| `ctx.slash`, `SlashService`, `SlashController`, `SlashSource` | `ctx.inputTriggers`, `InputTriggerService`, `InputTriggerController`, `InputTriggerSource` | The names cover every supported trigger and keep the existing service, controller, and source roles. Coupled locale and public type names follow `InputTrigger`. |
| `@coomi/coomi-agent-tool-mode`, plugin `tool-mode` | `@coomi/coomi-agent-tool-presentation`, plugin `tool-presentation` | The plugin changes how tools are presented to the model. It does not change execution behavior. Keep local `Config.mode` and `ToolPresentationMode`. |
| `packages/interaction/permission/` | `packages/interaction/permission-presets/` | The package owns named combinations of sandbox and approval settings, not permission enforcement. |
| `@coomi/coomi-permission`, `ctx.permission`, `PermissionService` | `@coomi/coomi-permission-presets`, `ctx.permissionPresets`, `PermissionPresetService` | The service selects and persists presets. Sandbox and approval services enforce the result. |
| `@coomi/coomi-client-ui-permission` | `@coomi/coomi-client-ui-permission-presets` | The UI edits and selects permission presets. |
| `docs/subsystems/permission.md` | `docs/subsystems/permission-presets.md` | The page documents preset selection, not permission enforcement. |
| `@coomi/coomi-user-interaction`, `user-interaction/` | `@coomi/coomi-user-questions`, `user-questions/` | The seam supports question batches and answers only. Approval, commands, and directory picking are separate interaction seams. |
| `ctx.userInteraction`, `UserInteractionService`, `UserInteractionProvider`, `UserInteractionError` | `ctx.userQuestions`, `UserQuestionService`, `UserQuestionProvider`, `UserQuestionError` | These names state the one supported interaction form. Keep `AskUserQuestion*`, the `ask_user_question` tool, and `@coomi/coomi-tool-ask-user`. |
| `docs/subsystems/user-interaction.md` | `docs/subsystems/user-questions.md` | The page documents questions and answers only. |

Keep `/permission`, the `permissions` projection, the `permission` settings namespace, and `permission/preset`; they are accurate product or durable vocabulary. Keep the full `PermissionPresetSettingsController` name. Dropping `Preset` would remove the word that limits its authority. Removal of the `both` tool-presentation mode remains deferred to a separate proposal; this rename does not remove behavior.

### Typert, API gateway, and tools

| Former | Current | Reason |
|---|---|---|
| `packages/typert/type-meta/`, `@coomi/coomi-type-meta` | `typert/protocol/`, `@coomi/coomi-typert-protocol` | The package owns the Typert Remote protocol, decorators, bindings, codecs, lookups, and context contracts. It is not generic type metadata. |
| `GatewayService` in the protocol package | `TypertRemoteService` | The base class marks a same-process service for Remote export. It is not the API gateway. |
| `bindTypeRTGateway`, `typertGateway` binding | `bindTypertRemote`, `typertRemote` | These bindings expose Typert Remote services, not the concrete API gateway service. |
| Public `TypeRT*` and camel-case `typeRT*` identifiers | `Typert*` and `typert*` | `Typert` is the one canonical product spelling. |
| Protocol interface `TypeRTService` | `TypertRegistryContract` | The protocol-owned interface is the dependency-inverted face implemented by the existing concrete `TypertRegistry`. A distinct suffix prevents an import and declaration collision. |
| `ToolRegistry` | `ToolRuntime` | The class owns presentation, approval and guard policy, dispatch, cancellation, validation, finalization, and observation. Registration is only one internal part. |
| `ToolRegistryScheduler`, `TOOL_REGISTRY_SCHEDULER` | `ToolRuntimeScheduler`, `TOOL_RUNTIME_SCHEDULER` | The scheduler controls runtime dispatch, not registration. |

Keep `@coomi/coomi-tools` and `ctx.tools`. Keep `@coomi/coomi-api-gateway`, its `gateway/` folder, `ctx.typertGateway`, and `TypertGatewayService`; that service is a real API gateway. Its internal `TypeRT*` identifiers still follow the `Typert*` spelling rule.

### Workspace instructions, telemetry, identity, and launch environment

| Former | Current | Reason |
|---|---|---|
| Host `ctx.workspace` | Host `ctx.workspaceRegistry` | `WorkspaceRegistry` owns multiple workspaces, but Client `ctx.workspaces` already has an incompatible type. Both declarations merge into the same Cordis `Context` interface at compile time even though their runtime contexts are separate. The role suffix states the host service and avoids that collision. Keep `@coomi/coomi-workspace`, `WorkspaceRegistry`, `Workspace`, and `workspace.*` wire names. |
| `@coomi/coomi-workspace-context`, `context/workspace-context/` | `@coomi/coomi-agent-instructions`, `context/agent-instructions/` | The package loads hierarchical `AGENTS.md` and `CLAUDE.md` files for the agent. It is not general workspace context. |
| Plugin and durable source names `workspace-context` and `workspace-instructions` | `agent-instructions` | The recorded source is a specific class of agent instructions. `AgentInstruction*` replaces public `WorkspaceInstruction*` names. This term does not include system, developer, or user messages. |
| `ctx.telemetry`, abstract `Telemetry` | `ctx.sessionTelemetry`, `SessionTelemetryBackend` | The service captures session-ledger telemetry and hands it to a reporting backend. It is not a repository-wide metrics or tracing service. |
| `TelemetryBackend` | `SessionTelemetrySink` | This lower layer receives emitted records. `Sink` distinguishes it from the coordinating backend service. |
| `TelemetryCoordinator`, `TelemetryRecord`, `TelemetrySeverity`, `TelemetrySharingStatus`, and `TelemetryCapture` | Corresponding `SessionTelemetry*` names | These public types belong only to session telemetry. |
| `telemetry/record` | `session-telemetry/record` | The event name must state its owning domain. |
| `TelemetryOtel`, `TelemetryMode`, plugin `telemetry-otel` | `OpenTelemetrySessionBackend`, `SessionTelemetryMode`, plugin `session-telemetry-otel` | The provider name states both the OpenTelemetry mechanism and session scope. Keep the package names `coomi-session-telemetry` and `coomi-session-telemetry-otel`. |
| `docs/subsystems/telemetry.md` | `docs/subsystems/session-telemetry.md` | The page documents session telemetry, not repository-wide observability. |
| `session/user-id/`, `@coomi/coomi-user-id` | `identity/anonymous-user-id/`, `@coomi/coomi-anonymous-user-id` | The value is a random correlation id shared by telemetry, feedback, and DeepSeek requests. It is neither a Session concern nor an authenticated user identity. |
| `USER_ID_FILE_NAME`, `.userid`, feedback label `User` | `ANONYMOUS_USER_ID_FILE_NAME`, `.anonymous-user-id`, feedback label `Anonymous user` | The file and UI must not imply account identity. Keep the existing `AnonymousUserId` functions and the standard OTel attribute `user.id`. |
| `util/environment/`, `@coomi/coomi-environment` | `util/launch-environment/`, `@coomi/coomi-launch-environment` | The package captures one immutable layered snapshot at launch. It is not a general environment API. |
| Public `Environment*`, `createEnvironmentSnapshot`, `environmentOf`, `COOMI_ENVIRONMENT_KEY` | `LaunchEnvironment*`, `createLaunchEnvironmentSnapshot`, `launchEnvironmentOf`, `COOMI_LAUNCH_ENVIRONMENT_KEY` | The names state the snapshot's lifetime and purpose. |
| `ctx.launcherEnvironment` | `ctx.launchEnvironment` | The value describes the application launch, not only a launcher component. Keep source labels `process`, `project-env`, and `user-env`. |

### Schedule, workflow, goals, and compaction

| Former | Current | Reason |
|---|---|---|
| `@coomi/coomi-tool-schedule`, `schedule/tool-schedule/`, plugin `tool-schedule` | `@coomi/coomi-schedule`, `schedule/schedule/`, plugin `schedule` | The package owns the durable Schedule domain, persistence barriers, management tools, timers, follow-ups, and runtime lifecycle. `tool-` describes only one part. |
| `ScheduleOwner` | `ScheduleRuntime` | The per-agent object runs live timers, durable projection, dispatch, idle waits, and disposal. `Owner` does not state that execution role. Coupled private `owner*` names follow `runtime*`. |
| `WorkflowService`, `ctx.workflows` | `WorkflowEngine`, `ctx.workflowEngine` | One engine parses and executes workflow programs. The plural key wrongly suggests a registry. Keep `@coomi/coomi-workflow` and workflow events and tools. |
| `@coomi/coomi-workflow-workerthread`, `WorkerWorkflowEngine` | `@coomi/coomi-workflow-worker-thread`, `WorkerThreadWorkflowEngine` | `worker thread` is the precise Node mechanism and the repository spelling uses the full words. |
| `@coomi/coomi-goal-session`, `goal/goal-session/` | `@coomi/coomi-goal-round-driver`, `goal/goal-round-driver/` | The plugin drives same-session Goal Rounds. It neither stores goals nor defines sessions. Keep `GoalService`, goal source, events, and contracts. |
| `packages/compact/` | `packages/compaction/` | The group is a noun-domain family. `compact` remains the user command verb. |
| `@coomi/coomi-compact`, `ctx.compact`, `CompactService` | `@coomi/coomi-compaction`, `ctx.compaction`, `CompactionEngine` | The object runs the compaction algorithm and lifecycle. It is an engine, not a generic service. |
| `compact/*` events and public domain prefixes | `compaction/*` | Events and domain types use the noun. Keep verb-shaped operations such as `compactNow`, `compactRegion`, and `compactIfNeeded`. |
| `@coomi/coomi-compact-basic`, `BasicCompactService`, public `BasicCompact*` | `@coomi/coomi-compaction-basic`, `BasicCompactionEngine`, corresponding `BasicCompaction*` | `basic` is plain but honest. `compaction-llm` adds no information because LLM use is already part of the current implementation family. |
| `@coomi/coomi-compact-tool-result-prune`, `ToolResultPruneService`, `ctx.toolResultPrune` | `@coomi/coomi-compaction-tool-result-pruner`, `ToolResultPruner`, `ctx.toolResultPruner` | The plugin is an actor that prunes tool results. The noun `pruner` names that role. |

Keep `/compact`, the command package, and the separate compaction definition and provider packages. Merging those packages remains rejected. The rename changes vocabulary, not that package boundary.

### Settings, credentials, client modules, and small core roles

| Former | Current | Reason |
|---|---|---|
| Abstract `Settings` | `SettingsProvider` | The class supplies settings through a replaceable capability. Keep the package, key, and events. |
| `@coomi/coomi-settings-local`, `SettingsLocal` | `@coomi/coomi-settings-file`, `FileSettingsProvider` | The implementation is file-backed through the filesystem seam. `file` states the mechanism; `local` does not. |
| Abstract `Credentials` | `CredentialProvider` | The class resolves credential references. Keep package names, keys, and events. |
| `CredentialsLocal` | `LocalCredentialProvider` | This provider reads the host process and `.env` state, so local execution is part of its contract. |
| `ClientModuleHostService`, `ctx.clientModuleHost` | `ClientModuleRegistry`, `ctx.clientModules` | The service owns multiple registered client modules. Keep the package and the browser `ClientModuleLoader`. |
| `AgentDefaultModelService` | `AgentDefaultModelConfig` | The object stores one default model selection. It does not run a service or general registry. Keep its package, key, settings namespace, and type. |
| `SessionReferenceService`, `ctx.sessionReferences` | `SessionReferenceResolver`, `ctx.sessionReferenceResolver` | It resolves one session reference from a URI or input. It does not own a reference collection. |
| `SessionQueryService`, `SessionQuerySqlite` | `SessionQueryEngine`, `SqliteSessionQueryEngine` | The classes execute a query model and its SQLite implementation. Keep package names, key, and tool. |
| `@coomi/coomi-session-export`, `session-export/`, Loader id `session-export`, `ctx.sessionExport` | `@coomi/coomi-session-log-export`, `session-log-export/`, Loader id `session-log-download`, `ctx.sessionLogDownload` | The npm package names the Session-log export because npm rejects `download` in package names. The Loader id and browser API retain `download` because they describe the browser side effect. |
| `SessionExportDownloadController`, other `SessionExport*` browser types, `useSessionExport`, `SessionExportHeader` | `SessionLogDownloadController`, corresponding `SessionLogDownload*` types, `useSessionLogDownload`, `SessionLogDownloadHeaderAction` | The controller owns preflight, duplicate-request collapse, modal state, and browser save. `ExportDownload` repeats the action, and the component contributes one Header action rather than the Header. |
| `CommandService` in the host command package | `CommandRuntime` | The object registers and executes host commands across live calls. Keep its package, key, types, and events. |
| `TokenMeterService` | `TokenMeter` | The object measures token use. `Service` adds no scope. |
| `LlmService` | `LlmRuntime` | The object selects providers and runs live model requests. Keep the package, key, adapters, and events. |

### Host web server, session data, and code execution

| Former | Current | Reason |
|---|---|---|
| `HttpServerService`, `ctx.httpServer` | `WebServer`, `ctx.webServer` | The server owns HTTP routes and WebSocket upgrade routes. `Web` leaves room for both; `Http` is too narrow here. Keep `packages/host/webserver`, `@coomi/coomi-host-webserver`, `WebRoute`, and `WebUpgradeRoute`. |
| Documentation subsystem label `http-server` | `web-server` | The subsystem must use the same scope as the service. |
| `SessionPersistenceJsonl` | `JsonlSessionPersistence` | Put the implementation qualifier first and keep the capability role intact. |
| `SessionPersistenceSqlite` | `SqliteSessionPersistence` | Use the same provider naming order as JSONL. |
| `@coomi/coomi-session-title-first-message-llm`, cadence `first-message` | `@coomi/coomi-session-title-first-prompt-llm`, cadence `first-prompt` | The trigger is the first user prompt, not any message in the session log. |
| `@coomi/coomi-session-title-all-messages-llm`, cadence `all-user-messages` | `@coomi/coomi-session-title-all-prompts-llm`, cadence `all-prompts` | The backend refreshes from user prompts. `all messages` wrongly includes assistant and tool events. |
| `@coomi/coomi-code-runtime-worker`, `WorkerCodeRuntime` | `@coomi/coomi-code-runtime-worker-thread`, `WorkerThreadCodeRuntime` | The implementation uses a Node worker thread. `worker` alone is too broad. |
| `SubprocessService` | `SubprocessRuntime` | The service owns live child-process execution and lifecycle. Keep its package and key. |
| `LocalSubprocessService` | `LocalSubprocessRuntime` | The provider runs same-host processes and process trees. |
| `E2BSubprocessService` | `E2BSubprocessRuntime` | The provider runs subprocesses in the E2B runtime. |

Keep the complete session projection family and `SessionProjection*` vocabulary. A projection is a maintained read model; `Reducer` would name only its fold operation and would understate caching and lookup. Keep `SessionTitleService`, checkpoint policy, persistence package names, time context, and tmux context.

### Filesystem, skill, subagent, and web providers

| Former | Current | Reason |
|---|---|---|
| `@coomi/coomi-fs-policy` | `@coomi/coomi-fs-observation-policy` | The package defines which filesystem observations authorize later effects. It is not the complete filesystem or sandbox policy. |
| `FsPolicyExec` | `FsObservationActor` | The value names the actor whose observations and effects the policy relates. It does not execute the policy itself. |
| `SkillService` | `SkillRegistry` | The service registers providers and resolves skills from their catalogs. |
| `@coomi/coomi-skill-local`, `LocalSkillProvider`, provider id `local` | `@coomi/coomi-skill-filesystem`, `FileSystemSkillProvider`, provider id `filesystem` | The provider discovers skill files through `ctx.fs`, which can be local or remote. The mechanism is filesystem access, not locality. |
| `SubagentService` | `SubagentRuntime` | The service selects providers and owns live spawn, resume, follow-up, cancellation, and settlement behavior. |
| `@coomi/coomi-subagent-spawn`, `SpawnProvider` | `@coomi/coomi-subagent-spawn-in-process`, `SpawnInProcessProvider` | This provider starts a child agent in the current process. The configured provider id remains `spawn`. |
| `@coomi/coomi-subagent-fork`, `ForkProvider` | `@coomi/coomi-subagent-fork-in-process`, `ForkInProcessProvider` | This provider forks an agent in the current process. The configured provider id remains `fork`. |
| `@coomi/coomi-subagent-inprocess`, `subagent-inprocess/` | `@coomi/coomi-subagent-in-process-driver`, `subagent-in-process-driver/` | The package contains common in-process driving logic, not a third provider. |
| Private `SdkProvider` in `coomi-subagent-coomi-sdk` | `SdkSubagentProvider` | The repeated package qualifier is intentional, and the class must say that it provides subagents through the SDK. |
| `WebService`, `WebServiceConfig` | `WebRuntime`, `WebRuntimeConfig` | The object selects providers and runs live search and fetch operations. Keep the package, key, provider packages, and model tool. |
| `@coomi/coomi-web-fetch-local`, `LocalFetchProvider`, `LocalFetchLimits`, provider id `local-http` | `@coomi/coomi-web-fetch-http`, `HttpFetchProvider`, `HttpFetchLimits`, provider id `http` | This provider performs direct HTTP fetches. `local` says where code happens to run, not which mechanism it provides. |

Keep `@coomi/coomi-subagent-coomi-sdk`, its provider id `coomi-sdk`, external ACP, Codex, and Claude Code provider families, the subagent tool package names, the main filesystem package and backends, filesystem tools and events, and the skill badge and tool packages.

### Hooks, guards, plan mode, extensions, and diagnostics

| Former | Current | Reason |
|---|---|---|
| `@coomi/coomi-hooks-claude`, `ClaudeHookConfig`, `parseClaudeConfig`, dialect `claude` | `@coomi/coomi-hooks-claude-code`, `ClaudeCodeHookConfig`, `parseClaudeCodeConfig`, dialect `claude-code` | The hook bridge targets Claude Code, not every Anthropic or Claude product. |
| `@coomi/coomi-repeat-tool-guard`, plugin/source `repeat-tool-guard` | `@coomi/coomi-repeat-tool-reminder`, plugin/source `repeat-tool-reminder` | The plugin adds a model reminder. It does not block or enforce a guard decision. |
| `@coomi/coomi-timeout-policy` | `@coomi/coomi-tool-call-timeout-policy` | The full `tool-call` qualifier names what the policy limits without calling the plugin a model-facing tool. Keep its `guard/timeout-policy/` directory and plugin id `timeout-policy`; the `packages/*/tool-*` catalog convention still applies only to packages that register tools. |
| `PlanModeService` | `PlanModeController` | The object controls transitions into and out of plan mode. It is not a general execution runtime. |
| `packages/self-modification/` | `packages/extensions/` | The group contains repository plugin inspection and mounting tools. `extensions` states the stable package role without asserting that the agent modifies itself. Keep the package names `tool-cordis` and repository-plugin names. |
| `packages/support/` | `packages/test-support/` | The group is test-only infrastructure. Its path must say so. |
| `invariants/` in the former support family | `runtime-diagnostics/invariants/` | Invariants can run in production diagnostics even though shipped presets omit them. They are not test support. |
| `InvariantService` | `InvariantRegistry` | The object owns registered invariant checks. Keep `@coomi/coomi-invariants` and `ctx.invariants`. |
| `packages/client/test-runtime/` | `packages/test-support/client-runtime/` | The package is client test infrastructure. Keep its npm name if it already states that contract. |

Keep MCP, Todo, and the Plan Mode package, key, events, and tool names. This decision renames the controller class, not the product feature.

### Utilities, E2B, host, bundles, examples, and applications

| Former | Current | Reason |
|---|---|---|
| `util/paths/`, `@coomi/coomi-paths` | `util/home-paths/`, `@coomi/coomi-home-paths` | The helpers resolve paths under the Harness home. They are not a general path library. Keep the individual function names when they already state the returned path. |
| `util/retention/`, `@coomi/coomi-retention` | `util/output-retention/`, `@coomi/coomi-output-retention` | The policy retains command and tool output. It is not a general data-retention framework. |
| `E2BSandboxService` | `E2BRuntime` | The class creates, reuses, and disposes the E2B execution environment used by filesystem and subprocess adapters. It is broader than one sandbox handle and narrower than a generic owner. Keep `@coomi/coomi-e2b`, `ctx.e2b`, and the `e2b/` group. |
| `@coomi/coomi-frontend-static` | `@coomi/coomi-host-frontend-static` | The package is the Host plugin that serves the frontend assets. The prefix distinguishes it from frontend application code. |
| `PluginInventoryService` | `PluginInventoryGateway` | The class is a Remote-only adapter from the live Loader tree to the `pluginInventory/list` RPC. It owns no same-process service, cache, history, or mutation path. `Gateway` states the role that exists. |
| `@coomi/coomi-jsonrpc-demo` | `@coomi/coomi-sdk-jsonrpc-demo` | The example demonstrates the runtime SDK over JSON-RPC. It belongs to the one SDK meaning. |
| `@coomi/coomi-frontend` | `@coomi/coomi-web-frontend` | The application is the web frontend. Keep its physical `apps/web/` folder. |

Keep atomic-write, brand, native-command, timeout utility, directory-picker, `coomi-base`, `coomi-web-app`, app boot, CLI names, and the `headless` package, bundle, and example identity. `headless` is the intended product essence and may later support more than one-shot execution.

### Client runtime and UI

| Former | Current | Reason |
|---|---|---|
| `SlotsService` | `SlotRegistry` | The object owns named slot declarations and registrations. |
| `SessionsService` | `SessionRuntime` | The object owns live client session coordination, not a passive session list. |
| `WorkspacesService` | `WorkspaceRuntime` | The client object coordinates live workspace selection and operations. Existing `ctx` keys stay where the ledger does not name a key change. |
| `WorkspaceGroupBy`, `WorkspaceOrderBy`, `workspaceExpansion`, `setWorkspaceExpanded`, `expandedProjects`, `projectLabel`, `recentSessionOrder`, `recentSessionUpdatedAt`, `syncRecentSessions`, `setRecentSessionOrder`, `retainWorkspaceKeys`, `workspaceKey` | `SessionGroupBy`, `SessionOrderBy`, `groupExpansion`, `setGroupExpanded`, `expandedGroups`, `workspaceLabel`, `sessionOrderByAccount`, `sessionUpdatedAtByAccount`, `syncSessionOrderAccount`, `setSessionOrder`, `retainAccountKeys`, `accountKey` | These are Session-list viewing names. Their accounts include real Workspaces, Ungrouped, and the flat list. `Workspace`, `project`, and `recent` therefore state the wrong subject or mechanism. Keep `WorkspaceViewState`; the store still belongs to the Workspace browser. |
| `LocaleService` | `LocaleRuntime` | The object coordinates locale definitions, selection, persistence, and change publication. |
| `ThemeService` | `ThemeRuntime` | The object coordinates themes, preference resolution, system sensing, and change publication. |
| `LayoutService` | `LayoutController` | The object controls the current UI layout state. |
| `@coomi/coomi-client-ui-model` | `@coomi/coomi-client-ui-model-selection` | The package controls the model selection for a session. The singular `model` name is too broad. |
| `ModelService`, `ctx.models` | `ModelDirectoryResolver`, `ctx.modelDirectories` | Its only public operation, `directoryFor(sessionId)`, resolves and retains one directory per live session. It has no registration API, so `Registry` would be false. Each `ModelDirectory` remains the consumer-facing catalog of selectable models. |
| `SettingsScopeService` | `SettingsScopeBinder` | Its sole operation binds one namespace specification to the caller's transport and lifecycle and returns a `SettingsScopeController`. Keep `ctx.settingsScope`; it names the singular binding capability, not a collection of scopes. |
| `@coomi/coomi-client-ui-models` | `@coomi/coomi-client-ui-settings-models` | This package owns the Models settings panel. Keep `ModelsSettingsStore`; it holds one settings view model with data operations and subscriptions and is a real store. |
| `@coomi/coomi-client-ui-plugin-config`, `client/ui-plugin-config/` | `@coomi/coomi-client-ui-settings-plugins`, `client/ui-settings-plugins/` | This package owns the Plugins settings section, not a general plugin-configuration system. The target joins the `ui-settings-*` family and uses the section's plural product name. |
| `PluginConfigSection`, `PluginConfigSectionProps`, `PluginConfigSectionInjected`, `PluginSettingsTabRow`, `PluginConfigKey`, `settings.pluginConfig` | `PluginsSettingsSection`, `PluginsSettingsSectionProps`, `PluginsSettingsSectionInjected`, `PluginsSettingsTabEntry`, `PluginsSettingsLocaleKey`, `settings.plugins` | The section owns the Plugins settings presentation and tab ledger. The metadata value is one slot entry, not a rendered row. Each card still edits one plugin's configuration. |
| `@coomi/coomi-client-ui-plugins`, `client/ui-plugins/`, Loader id `ui-plugins`, `client-ui-plugins-invariant` | `@coomi/coomi-client-ui-settings-plugin-inventory`, `client/ui-settings-plugin-inventory/`, Loader id `ui-settings-plugin-inventory`, `client-ui-settings-plugin-inventory-invariant` | This later package owns the read-only Plugin Inventory tab in the Plugins settings section. `ui-plugins` is too broad and does not distinguish the inventory from editable plugin settings. |
| `PluginSettingsSection`, `PluginSettingsSectionProps`, `PluginSettingsSectionInjected`, `PluginsKey`, `settings.plugins` in the former `ui-plugins` package | `PluginInventorySettingsTab`, `PluginInventorySettingsTabProps`, `PluginInventorySettingsTabInjected`, `PluginInventoryLocaleKey`, `settings.pluginInventory` | The component is now a tab contribution, not a settings section. The other names state the inventory subject and avoid colliding with `PluginsSettingsSection` and its `settings.plugins` locale namespace. Keep the shared `settings.plugins.tab` slot name; both tabs contribute to the Plugins section through that slot. |
| `@coomi/coomi-client-ui-feedback`, `client/ui-feedback/`, Loader id `ui-feedback`, `client-ui-feedback-invariant` | `@coomi/coomi-client-ui-message-feedback`, `client/ui-message-feedback/`, Loader id `ui-message-feedback`, `client-ui-message-feedback-invariant` | This package presents ratings and notes for assistant messages through the `messageFeedback` Remote. The old name also appears to cover command feedback and any later feedback UI. It does not. |
| `FeedbackController`, `FeedbackStatus`, `FeedbackView`, `FeedbackActionResult`, `FeedbackInjected`, `FeedbackActionProps`, `FeedbackActions`, `FeedbackKey` in the former `ui-feedback` package | `MessageFeedbackController`, `MessageFeedbackStatus`, `MessageFeedbackView`, `MessageFeedbackActionResult`, `MessageFeedbackInjected`, `MessageFeedbackActionProps`, `MessageFeedbackActions`, `MessageFeedbackKey` | These are exported Client names. The `Message` qualifier prevents them from claiming every feedback domain. Keep `Controller`: the object accepts rating and note actions and coordinates one Session's load, mutation, conflict, reconnect, and disposal state. |
| `agent-loop-store.ts`, `bash-store.ts`, `web-search-store.ts` | `agent-loop-card-controller.ts`, `bash-card-controller.ts`, `web-search-card-controller.ts` | Each module exports a card controller. A private `SnapshotStore` field does not make the module a store. |
| `card-store.ts` | `card-form.ts` | The module owns the staged form, field conversion, and form actions. The snapshot stores it returns are presentation adapters, not the module's main role. |
| `@coomi/coomi-client-ui-question` | `@coomi/coomi-client-ui-user-questions` | The UI presents the user-question seam, not an arbitrary question domain. |
| `@coomi/coomi-client-ui-command`, `ui-command/` | `@coomi/coomi-client-ui-commands`, `ui-commands/` | The package presents and runs a collection of commands. |
| `@coomi/coomi-client-ui-directory-picker`, `client/ui-directory-picker/`, Loader id `ui-directory-picker`, `client-ui-directory-picker-invariant` | `@coomi/coomi-client-ui-directory-picker-browse`, `client/ui-directory-picker-browse/`, Loader id `ui-directory-picker-browse`, `client-ui-directory-picker-browse-invariant` | The Client packages now contain separate `browse` and `native` directory-picker presentations. The unqualified package is the browse implementation, not their shared definition. The target matches the Host backend family and changes no boundary. |
| Client `ctx.command`, `CommandService`, `CommandServiceContract` | `ctx.commandUi`, `CommandUiRuntime`, `CommandUiContract` | The host already owns `ctx.commands`. The client service is the UI runtime for command discovery and execution. Existing `CommandUiSpec` fixes the `Ui` casing. |
| `ConversationService` | `ConversationController` | The object controls the active conversation state and user actions. |
| `InputService` | `SessionInputResolver` | The interface resolves the input facade for one session scope. It is neither a global input registry nor an execution service. Keep `InputHub` as the concrete hub and `ctx.conversation.input` as the published face. |

Use `Ui`, not `UI`, inside PascalCase identifiers. Keep the remaining client package names unless this ledger names them. Keep the deprecated client connection and Host `ApiProxy` vocabulary for now; the API plane will replace them, and a rename would add churn to a surface scheduled for removal.

## Explicit non-renames

The following debated names stay unchanged because the current scope is accurate or a rename would create a false concept:

- Keep the complete sandbox family and `ctx.sandbox`. Do not introduce `processSandbox`.
- Keep `@coomi/coomi-api-gateway`, `ctx.typertGateway`, and `TypertGatewayService`.
- Keep session projection names. A projection is not only a reducer function.
- Keep `@coomi/coomi-session-stats`, `sessionStats`, and `SessionStatsProjection`. They accurately name whole-session statistics and the maintained read model that carries them.
- Keep `GoalService`; it owns the goal state machine, authority, compare-and-set behavior, events, and remote operations. It is not just a store.
- Keep `SessionTitleService`; its role is a domain service shared by title providers.
- Keep `PermissionPresetSettingsController` even though it is long. Every word limits the role.
- Keep `ModelsSettingsStore`; its main contract is one settings data model with store operations.
- Keep `InputHub`; it is the concrete hub that backs `SessionInputResolver`.
- Keep `coomi-subagent-coomi-sdk` and provider id `coomi-sdk`; the repeated qualifier prevents ambiguity.
- Keep `headless`; the product identity is accurate even if the runtime later supports more than one-shot use.
- Keep deprecated Host `ApiProxy` and client connection names until the API replacement removes them.
- Keep `Web` for the Host server and the provider-neutral web capability. Use `HTTP` only for the direct fetch provider.
- Keep `E2B`, not `E2B sandbox`, as the package and context name.
- Keep MCP, Todo, app boot, base bundle, web-app bundle, and CLI names. Keep the directory-picker capability and Host backend names; only the unqualified Client `browse` presentation is renamed.
- Keep `@coomi/coomi-client-ui-directory-picker-native`; its suffix names the native-chooser presentation beside the renamed `-browse` variant. Keep `SURFACE_PACKAGES`; within the directory-picker auto selector it is the package map for the Client presentation half, contrasted with `BACKEND_PACKAGES`.
- Keep `@coomi/coomi-host-plugin-inventory`, `ctx.pluginInventory`, the `pluginInventory/list` Remote, and the `PluginInventory*` payload types. They accurately name the Host-owned read-only inventory; only the adapter class and the overly broad Client presentation names change.
- Keep `ConfigurablePluginsTab`. It is the tab that renders plugins with editable configuration; it does not own the complete Plugins settings section.
- Keep the shared `settings.plugins.tab` slot. It belongs to the Plugins settings section. The inventory package changes its own locale namespace to `settings.pluginInventory`; it does not create a separate tab slot.
- Keep the `@coomi/coomi-message-feedback` capability, `messageFeedback` Remote, assistant-action entry id `feedback`, hook key `feedback`, and locale namespace `feedback`. Their surrounding interfaces already limit them to message feedback or to the local assistant-message slot. Only the broad Client package and exported UI names change.
- Keep `RemoteFailure`, `RemoteResult`, and `SessionRemotes`. The first two are Typert carrier-result values, while the last is the set of Remote namespaces used by the Client Session cluster. None is a store, controller, registry, or runtime.
- Keep the `/export` human command, `/api/session.export` Host route, `DownloadsApi`, and its `sessionLog` operation. The command names the user action, the Host route exports the archive, and the API groups direct HTTP downloads. The renamed Client controller owns the separate browser-download step.
- Keep `.client` and `.host` in test filenames. They identify the compiler face each test enters and do not claim a product role.

## Alternatives considered

**Keep the current names and add a glossary.** Rejected. A glossary cannot make `BashExecutor` truthful when PowerShell implements it, or make `ToolRegistry` disclose that it enforces and executes tools. The identifier must carry the useful distinction.

**Prefix every npm package with its group.** Rejected. Flat npm names do not need a copy of the directory tree. A mechanical prefix adds length without explaining the package role.

**Call the whole repository an SDK.** Rejected. The project is an agent harness. SDK is the supported JSON-RPC client/server stack used by Python and TypeScript clients. Two meanings make package names and product prose ambiguous.

**Use `Service` for every Cordis service class.** Rejected. Cordis inheritance is an implementation fact. The class name must tell callers whether the object registers, stores, resolves, controls, or runs work.

**Use `Runtime` as the standard replacement for `Service`.** Rejected. `Runtime` is correct only when the object owns live execution or lifecycle. Registries, stores, directories, controllers, resolvers, engines, and configuration objects keep their sharper roles.

**Prefer the shortest possible name.** Rejected. Short is useful only after scope is clear. `PermissionPresetSettingsController` keeps `Preset`; `JobId` is short because `Job` already carries the domain; `BgTaskId` is short but cryptic.

**Use broad names for possible future features.** Rejected. Name the stable current role. A future boundary change can rename the object again before release or use a new proposal after release. Vague names charge every current reader for an unbuilt future.

**Rename `coomi-compact-basic` to `coomi-compaction-llm`.** Rejected. `LLM` adds no distinction in the current backend family. `basic` is less ambitious and does not claim an algorithm that does not exist.

**Rename session projections to reducers.** Rejected. Reduction is how a projection is built. The package also owns the read-model value, cache, and lookup contract.

**Rename the persistent Bash tool to `bash-terminal`.** Rejected. That name collides with the terminal-session family. Moving `tool-bash-persistent` under `shell/` fixes its home while its current name continues to distinguish it from the one-shot Bash tool.

**Rename or split boundaries while applying the ledger.** Rejected. Reviewers must be able to see that behavior did not change. A real boundary defect needs its own proposal, tests, and consequences.

**Keep aliases for old names.** Rejected. No released consumer needs them. Aliases would preserve two vocabularies and make the first release carry a migration that never had a user.

## Verification

- Every mapping in the ledger appears in the repository. Each family has one public vocabulary; no compatibility package, re-export alias, duplicate `ctx` key within one Cordis context, dual plugin id, dual event id, old tool alias, or fallback parser remains.
- Runtime behavior, package boundaries, defaults, policy, durable semantics, and model behavior remain equivalent except where an identifier is itself visible.
- Package directories, npm names, imports, manifests, TypeScript references and paths, Cordis config, plugin ids, service keys, events, tools, RPC names, persisted names named by the ledger, fixtures, snapshots, examples, generated catalogs, and current prose use the current vocabulary.
- Current implemented Agent Notes carry the factual name and path changes. The package-regrouping note records the group inventory and package targets, the SDK removal note reserves `SDK` for the runtime protocol, and the timeout-policy note records the package-name rationale.
- The paired package-creation guide contains the role-word contract, `packages/AGENTS.md` links to it, the terminology table records the chosen words and `Typert` spelling, and root project prose calls the product Coomi rather than Coomi SDK.
- The removed SDK project toolchain stays absent.
- `pnpm run check:ci` covers source-plane typecheck, build, package hygiene, generated-reference checks, affected snapshots, translation pairing, `doc-sync`, and lint. Release-shaped Python runtime smokes and required CI cover packaged-runtime and platform paths.

## Consequences

The repository has one vocabulary for each renamed family. Old on-disk names, wire values, tool names, and configuration entries named in the ledger do not work. An owning parser that can identify stale configuration fails clearly instead of accepting both forms.

Some names are longer. The extra word is intentional when it prevents a false claim about authority or mechanism. A long name remains wrong when every word does not constrain the role.

Role suffixes do not replace inspection of behavior. The package guide keeps the direct tests from this decision: inspect what callers do, what lifetime the object owns, and what failure or policy it controls.

Branches based on the former paths and symbols require conflict repair. This is a one-time pre-release cost of removing the old vocabulary without compatibility aliases.
