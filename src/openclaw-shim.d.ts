/**
 * Loose ambient declaration for the OpenClaw plugin SDK entry subpath.
 *
 * The `openclaw` package is a peerDependency (optional) — it is provided by
 * the host gateway at runtime. When this plugin is built or unit-tested in
 * isolation, the package is not installed, and TypeScript would otherwise
 * fail to resolve the module specifier. We declare it loosely here so the
 * build stays green; the runtime narrows the actual shape defensively.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function definePluginEntry<T extends Record<string, unknown>>(def: T): T;
}
