# Agent Note: Bundled coomi badge skill

Status: implemented

English | [中文](2026-08-06-bundled-coomi-badge-skill.zh.md)

## Problem

The [Cordis tutorial](../../../../docs/cordis-tutorial/index.md) uses an official “powered by coomi” badge across its pages, but the shipped CLI has no reusable instructions or explicit opt-in provider for applying the same attribution elsewhere.

## Decision

`@coomi/coomi-skill-badge` is a native Cordis plugin that registers one immutable bundled provider on `ctx.skills`. The provider owns the `coomi-badge` summary, instruction body, and PNG resource base; `coomi-tool-skill` remains the sole owner of model-facing catalog and loader rendering.

The shipped CLI composition declares `skill-badge` as disabled. Enabling that existing row is the explicit opt-in; disabled installations advertise no badge skill and gain no model-visible content.

The provider uses the bundled rank after project, custom, and user filesystem sources, so a user-owned `coomi-badge` definition can override it through the ordinary registry precedence contract. Provider disposal removes the contribution through the registry-owned effect.

## Alternatives considered

**Mount packaged files through `coomi-skill-filesystem`.** Rejected because filesystem discovery, parsing, and watching add lifecycle machinery that an immutable single-skill provider does not need.

## Consequences

The badge instructions and source PNG are versioned with coomi and resolve through a packaged directory resource base. The provider has no configuration surface. Package tests pin provider lifecycle and the official PNG bytes, while a keyless assembled-application snapshot pins the enabled catalog and loaded skill body.
