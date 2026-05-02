import { createRequire } from "node:module";

// `createRequire` works in both ESM (compiled dist/) and tsx (src/) because
// it resolves relative to the *calling file*, so "../package.json" always
// reaches the project root regardless of whether we're running from src/ or dist/.
const _req = createRequire(import.meta.url);
export const MCMCP_VERSION: string = (
  _req("../package.json") as { version: string }
).version;
