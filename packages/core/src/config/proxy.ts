export * as ConfigProxy from "./proxy"

import { Schema } from "effect"

export class Info extends Schema.Class<Info>("Config.Proxy")({
  url: Schema.String.annotate({
    description:
      "HTTP/HTTPS proxy URL used for requests to the configured domains. The OPENCODE_CLOUD_PROXY env var overrides this.",
  }),
  domains: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description:
      "Hostnames routed through the proxy. A leading `*.` matches subdomains. Defaults to opencode's domains (opencode.ai and its subdomains, zenmux.ai, gateway.opencode.ai). The OPENCODE_CLOUD_PROXY_DOMAINS env var (comma-separated) overrides this.",
  }),
}) {}
