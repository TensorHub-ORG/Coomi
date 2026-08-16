# Three-role capability design

English | [中文](index.zh.md)

This page has two parts: a concept reference for the three-role capability pattern, followed by an advanced tutorial that builds one capability. Complete the [basic plugin path](../basic/) and [services tutorial](../framework/service.md) first.

## Concept reference

When a capability is general enough to need replaceable providers, such as Bash execution, Harness separates three roles: a **Service Definition**, a **Service Provider**, and a **Consumer**. Put the roles in separate packages when they need to evolve or be replaced independently; a package may otherwise own more than one role. The complete capability is its seam. No individual role is a seam.

## Bash example

The Bash execution capability consists of:

- **Service Definition** (`coomi-shell`) — defines the Cordis service and Bash request and result types
- **Service Provider** (`coomi-bash-local`) — executes commands on the local machine
- **Consumer** (`coomi-tool-bash`) — exposes the capability as a model-callable tool

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│  coomi-shell   │────▶│  coomi-bash-local  │     │ coomi-tool-bash│
│(definition) │     │    (provider)     │     │(consumer/tool)│
└─────────────┘     └──────────────────┘     └──────────────┘
       ▲                                            │
       └────────────────────────────────────────────┘
                    inject: ['shell']
```

## Benefits of the split

### Replace providers

One Service Definition can have multiple providers selected through `cordis.yml`:

```yaml
# Local execution
- name: '@coomi/coomi-bash-local'

# Replace this row with another package that provides the same service.
```

The Service Definition and tool remain unchanged while the provider changes.

### Evolve independently

- The Service Definition changes rarely after callers depend on its contract.
- Service Providers can improve performance and security independently.
- Consumers can change how they present the capability to the model.

### Decouple dependencies

- The Service Provider depends on the Service Definition.
- The Consumer depends on the Service Definition.
- The Service Provider and Consumer **do not depend on each other**.

The [capability-seam reference](../../../capability-seams.md) owns the current built-in families and package links.

## Tutorial: develop a three-role capability

### Step 1: write the Service Definition

```ts ignore-check
// packages/my-cap/my-cap/src/index.ts
import { Service, type Context } from '@coomi/cordis'

declare module '@coomi/cordis' {
  interface Context {
    myCap: MyCapService
  }
}

export abstract class MyCapService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myCap')
  }

  /** Execute the capability. */
  abstract execute(request: MyCapRequest): Promise<MyCapResult>
}

export interface MyCapRequest {
  input: string
}

export interface MyCapResult {
  output: string
}
```

### Step 2: write a Service Provider

```ts ignore-check
// packages/my-cap/my-cap-local/src/index.ts
import type { Context } from '@coomi/cordis'
import { MyCapService, type MyCapRequest, type MyCapResult } from '@coomi/coomi-my-cap'

class MyCapLocal extends MyCapService {
  async execute(request: MyCapRequest): Promise<MyCapResult> {
    // Local provider behavior.
    return { output: request.input.toUpperCase() }
  }
}

export const name = 'my-cap-local'

export function apply(ctx: Context) {
  ctx.plugin(MyCapLocal)
}
```

### Step 3: write a consumer

```ts ignore-check
// packages/my-cap/tool-my-cap/src/index.ts
import type { Context } from '@coomi/cordis'
import { defineTool } from '@coomi/coomi-tools'

export const name = 'tool-my-cap'
export const inject = ['tools', 'myCap']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'my_cap',
    description: 'Execute my capability.',
    parameters: {
      input: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const result = await ctx.myCap.execute({ input: args.input })
      return result.output
    },
  }))
}
```

### Compose them in cordis.yml

```yaml
- name: '@coomi/coomi-my-cap-local'
- name: '@coomi/coomi-tool-my-cap'
```

## Design points

- **Do not split preemptively** — use separate packages only when the roles need to evolve independently. A simple tool plugin does not.
- **The Service Definition owns Request/Result types** — Service Providers and Consumers depend only on the Service Definition package.
- **Explicit > implicit** — resolve defaults in an explicit `resolve(request): Spec` step rather than hiding `?? default` expressions inside `run()`.

## Next steps

- [LLM adapter](./llm-adapter.md) — implement an LLM provider
