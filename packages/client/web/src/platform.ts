/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @coomi/coomi-client-web/src/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@coomi/cordis',
  '@coomi/coomi-client-ui-slots',
  '@coomi/coomi-client-web-react',
  '@coomi/coomi-client-ui-primitives',
  '@coomi/coomi-client-ui-attachment',
  '@coomi/coomi-client-schema-form',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
