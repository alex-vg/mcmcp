/**
 * OAuth 2.0 / PKCE provider for SSE upstreams.
 *
 * The SDK's {@link OAuthClientProvider} interface drives the entire flow.
 * Because mcmcp is a server-side proxy with no browser, the workable
 * grants are:
 *
 *  - Pre-supplied refresh token  → automatic refresh on first connect.
 *  - Out-of-band authorization   → operator runs the device/auth flow
 *    once externally, drops the resulting refresh token into the
 *    `tokens.json` store referenced by `tokenStorePath`.
 *
 * Tokens are persisted via {@link atomicWriteFile} (mode 0600 so they
 * never end up world-readable).
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { atomicWriteFile } from "./atomic-write.js";
import type { OAuthConfig } from "./config.js";

interface TokenStoreFile {
  client?: OAuthClientInformation;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

async function readStore(path: string): Promise<TokenStoreFile> {
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as TokenStoreFile;
  } catch (err) {
    process.stderr.write(`[mcmcp] oauth token store unreadable (${path}): ${(err as Error).message}\n`);
    return {};
  }
}

async function writeStore(path: string, data: TokenStoreFile): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(data, null, 2));
}

/** Build a SDK-compatible {@link OAuthClientProvider} from config. */
export async function buildOAuthProvider(
  cfg: OAuthConfig,
  serverUrl: string,
): Promise<OAuthClientProvider> {
  const store = await readStore(cfg.tokenStorePath);
  // Seed the store with an initial refresh token if provided and the
  // store is empty. Preserves the operator's hand-acquired token across
  // mcmcp restarts.
  if (cfg.initialRefreshToken && !store.tokens?.refresh_token) {
    store.tokens = {
      access_token: store.tokens?.access_token ?? "",
      token_type: store.tokens?.token_type ?? "Bearer",
      refresh_token: cfg.initialRefreshToken,
    } as OAuthTokens;
    await writeStore(cfg.tokenStorePath, store);
  }

  const clientMetadata: OAuthClientMetadata = {
    client_name: "mcmcp-proxy",
    redirect_uris: [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: cfg.clientSecret ? "client_secret_post" : "none",
    ...(cfg.scope ? { scope: cfg.scope } : {}),
  };

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      // Headless: no browser redirect. SDK accepts undefined for
      // non-interactive flows.
      return undefined;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    clientInformation: () => {
      if (store.client) return store.client;
      // Static registration via config — the server may also support
      // dynamic registration which the SDK will then invoke.
      return {
        client_id: cfg.clientId,
        ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
      } as OAuthClientInformation;
    },
    saveClientInformation: async (info) => {
      store.client = info;
      await writeStore(cfg.tokenStorePath, store);
    },
    tokens: () => store.tokens,
    saveTokens: async (tokens) => {
      store.tokens = tokens;
      await writeStore(cfg.tokenStorePath, store);
    },
    redirectToAuthorization: async (authUrl) => {
      // Headless mode: surface the URL on stderr so the operator can
      // complete the flow out-of-band, then re-seed the store.
      process.stderr.write(
        `[mcmcp] oauth: please visit ${authUrl.toString()} to authorize upstream ${serverUrl}\n`,
      );
    },
    saveCodeVerifier: async (verifier) => {
      store.codeVerifier = verifier;
      await writeStore(cfg.tokenStorePath, store);
    },
    codeVerifier: () => {
      if (!store.codeVerifier) {
        throw new Error("No PKCE code verifier saved (oauth flow not yet started).");
      }
      return store.codeVerifier;
    },
  };
  return provider;
}
