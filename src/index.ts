// Backward-compatibility re-export. Prefer `audiofile/browser` for SPA
// bundles (no Node imports) and `audiofile/node` for Node-side code. This
// bare-name entry stays for callers that import from `audiofile` without
// a subpath; it includes the full Node surface so existing Node consumers
// (lib manager, audio pipeline) keep working without an import-path change.

export * from './index.node';
