/**
 * JSON Schema for `mcmcp.config.json`. Used by Ajv at startup and on every
 * hot-reload to validate user input.
 */
export const MCMCP_CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["upstreams"],
  properties: {
    callTimeoutMs: { type: "integer", exclusiveMinimum: 0 },
    maxBatchSize: { type: "integer", minimum: 1 },
    shutdownTimeoutMs: { type: "integer", exclusiveMinimum: 0 },
    hotReload: { type: "boolean" },
    readonly: { type: "boolean" },
    security: {
      type: "object",
      additionalProperties: false,
      properties: {
        scanForInjection: { type: "boolean" },
        blockOnInjection: { type: "boolean" },
        customPatterns: { type: "array", items: { type: "string", minLength: 1 } },
      },
    },
    otel: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        serviceName: { type: "string", minLength: 1 },
        otlpEndpoint: { type: "string", pattern: "^https?://" },
      },
    },
    directory: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        tierOneMaxTools: { type: "integer", minimum: 1 },
        tierTwoMaxServers: { type: "integer", minimum: 1 },
      },
    },
    logging: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        path: { type: "string", minLength: 1 },
        maxSizeMb: { type: "number", exclusiveMinimum: 0 },
      },
    },
    upstreams: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "transport"],
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^\\S+$", minLength: 1 },
          label: { type: "string" },
          transport: { type: "string", enum: ["stdio", "sse"] },
          command: { type: "string", minLength: 1 },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object", additionalProperties: { type: "string" } },
          cwd: { type: "string" },
          url: { type: "string", pattern: "^https?://" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          auth: {
            oneOf: [
              {
                type: "object",
                required: ["type", "token"],
                additionalProperties: false,
                properties: {
                  type: { const: "bearer" },
                  token: { type: "string", minLength: 1 },
                },
              },
              {
                type: "object",
                required: ["type", "headers"],
                additionalProperties: false,
                properties: {
                  type: { const: "header" },
                  headers: {
                    type: "object",
                    minProperties: 1,
                    additionalProperties: { type: "string" },
                  },
                },
              },
            ],
          },
          retry: {
            type: "object",
            additionalProperties: false,
            properties: {
              maxAttempts: { type: "integer", minimum: 1 },
              initialDelayMs: { type: "integer", minimum: 0 },
              backoffFactor: { type: "number", minimum: 1 },
              retryOn: {
                type: "array",
                items: { type: "string", enum: ["timeout", "transport_error"] },
              },
            },
          },
          rateLimit: {
            type: "object",
            additionalProperties: false,
            required: ["requestsPerMinute"],
            properties: {
              requestsPerMinute: { type: "number", exclusiveMinimum: 0 },
            },
          },
          cache: {
            type: "object",
            additionalProperties: false,
            required: ["enabled"],
            properties: {
              enabled: { type: "boolean" },
              ttlMs: { type: "integer", exclusiveMinimum: 0 },
              maxEntries: { type: "integer", minimum: 1 },
            },
          },
          aliases: {
            type: "object",
            additionalProperties: { type: "string", minLength: 1 },
          },
          oauth: {
            type: "object",
            additionalProperties: false,
            required: ["issuer", "clientId", "tokenStorePath"],
            properties: {
              issuer: { type: "string", pattern: "^https?://" },
              clientId: { type: "string", minLength: 1 },
              clientSecret: { type: "string", minLength: 1 },
              scope: { type: "string" },
              tokenStorePath: { type: "string", minLength: 1 },
              initialRefreshToken: { type: "string", minLength: 1 },
            },
          },
        },
        allOf: [
          {
            if: { properties: { transport: { const: "stdio" } } },
            then: { required: ["command"], not: { required: ["url"] } },
          },
          {
            if: { properties: { transport: { const: "sse" } } },
            then: { required: ["url"], not: { required: ["command"] } },
          },
        ],
      },
    },
  },
} as const;
