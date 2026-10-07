// Loads .env before Next starts, so PORT is read by `next dev` / `next start`.
// `node --env-file` can't be used: Next re-launches itself and rejects it in NODE_OPTIONS.
process.loadEnvFile(".env");
await import("next/dist/bin/next");
