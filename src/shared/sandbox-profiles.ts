/**
 * Sandbox profiles the launcher does not offer yet, even when a profile YAML
 * is bundled, user-created, or listed by a deployment.
 *
 * wasmbox ("Mini computer"): its `python` needs Node plus the pyodide
 * worker's npm packages, which nothing provisions, and it is unverified on
 * Windows. Remove it from this set once both are solved.
 */
export const HIDDEN_SANDBOX_PROFILES: ReadonlySet<string> = new Set(['wasmbox']);
