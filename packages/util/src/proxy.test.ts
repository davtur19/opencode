import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FetchProxy } from "./proxy.js"

const PROXY_URL = "http://192.168.1.6:3128"
const ENV_PROXY_URL = "http://env-proxy:8080"
const CLOUD_PROXY_ENV = "OPENCODE_CLOUD_PROXY"
const CLOUD_PROXY_DOMAINS_ENV = "OPENCODE_CLOUD_PROXY_DOMAINS"

describe("util.proxy", () => {
  beforeEach(() => {
    delete process.env[CLOUD_PROXY_ENV]
    delete process.env[CLOUD_PROXY_DOMAINS_ENV]
  })

  afterEach(() => {
    delete process.env[CLOUD_PROXY_ENV]
    delete process.env[CLOUD_PROXY_DOMAINS_ENV]
  })

  test("routes opencode domains through the default list", () => {
    process.env[CLOUD_PROXY_ENV] = PROXY_URL
    for (const hostname of [
      "opencode.ai",
      "www.opencode.ai",
      "models.opencode.ai",
      "zenmux.ai",
      "gateway.opencode.ai",
      "api.opencode.ai",
      "app.opencode.ai",
      "console.opencode.ai",
      "dev.opencode.ai",
    ]) {
      expect(FetchProxy.getProxyForHostname(hostname)).toBe(PROXY_URL)
    }
  })

  test("does not route unrelated hostnames", () => {
    process.env[CLOUD_PROXY_ENV] = PROXY_URL
    expect(FetchProxy.getProxyForHostname("api.anthropic.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("api.openai.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("github.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("evilopencode.ai")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("opencode.ai.evil.com")).toBeUndefined()
  })

  test("is a no-op without OPENCODE_CLOUD_PROXY", () => {
    expect(FetchProxy.getProxyForHostname("opencode.ai")).toBeUndefined()
    expect(FetchProxy.proxiedInit("https://opencode.ai/install")).toBeUndefined()
  })

  test("routes cloud model hostnames via OPENCODE_CLOUD_PROXY using the default domain list", () => {
    process.env[CLOUD_PROXY_ENV] = ENV_PROXY_URL
    expect(FetchProxy.getProxyForHostname("opencode.ai")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("zenmux.ai")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("gateway.opencode.ai")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.anthropic.com")).toBeUndefined()
  })

  test("OPENCODE_CLOUD_PROXY_DOMAINS overrides the default domain list", () => {
    process.env[CLOUD_PROXY_ENV] = PROXY_URL
    process.env[CLOUD_PROXY_DOMAINS_ENV] = "example.com,*.example.org"
    expect(FetchProxy.getProxyForHostname("example.com")).toBe(PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.example.org")).toBe(PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.example.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("opencode.ai")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("zenmux.ai")).toBeUndefined()
  })

  test("OPENCODE_CLOUD_PROXY_DOMAINS narrows the proxy when only the env URL is set", () => {
    process.env[CLOUD_PROXY_ENV] = ENV_PROXY_URL
    process.env[CLOUD_PROXY_DOMAINS_ENV] = "example.com"
    expect(FetchProxy.getProxyForHostname("example.com")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("zenmux.ai")).toBeUndefined()
  })

  test("OPENCODE_CLOUD_PROXY_DOMAINS parses whitespace and empty entries", () => {
    process.env[CLOUD_PROXY_ENV] = ENV_PROXY_URL
    process.env[CLOUD_PROXY_DOMAINS_ENV] = " example.com ,,  *.example.org ,"
    expect(FetchProxy.getProxyForHostname("example.com")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.example.org")).toBe(ENV_PROXY_URL)
  })

  test("proxiedInit adds the proxy for matching string, URL, and Request inputs", () => {
    process.env[CLOUD_PROXY_ENV] = PROXY_URL
    const init = { headers: { "user-agent": "test" } }
    expect(FetchProxy.proxiedInit("https://zenmux.ai/api/v1", init)).toEqual({
      headers: init.headers,
      proxy: PROXY_URL,
    })
    expect(FetchProxy.proxiedInit(new URL("https://gateway.opencode.ai/api/v1"), init)).toEqual({
      headers: init.headers,
      proxy: PROXY_URL,
    })
    expect(FetchProxy.proxiedInit(new Request("https://zenmux.ai/chat/completions"), init)).toEqual({
      headers: init.headers,
      proxy: PROXY_URL,
    })
    expect(FetchProxy.proxiedInit("https://api.anthropic.com/v1/messages", init)).toBeUndefined()
  })

  test("proxiedInit keeps an explicit proxy on the init", () => {
    process.env[CLOUD_PROXY_ENV] = PROXY_URL
    const init: RequestInit & { proxy?: string } = { proxy: "http://other-proxy:8080" }
    expect(FetchProxy.proxiedInit("https://zenmux.ai/chat/completions", init)).toBeUndefined()
  })

  test("proxiedInit is undefined without OPENCODE_CLOUD_PROXY", () => {
    expect(FetchProxy.proxiedInit("https://zenmux.ai/chat/completions", { headers: {} })).toBeUndefined()
  })

  describe("encrypted_content scrubbing", () => {
    test("removes include entries and encrypted content keys from cloud chat bodies", () => {
      const body = JSON.stringify({
        model: "gpt-5",
        include: ["reasoning.encrypted_content", "something.else"],
        messages: [
          {
            role: "assistant",
            reasoning: { encrypted_content: "secret" },
            encryptedContent: "also-secret",
          },
        ],
      })
      const sanitized = FetchProxy.sanitizeBody(body)
      expect(sanitized).toBeDefined()
      if (sanitized === undefined) throw new Error("expected sanitized body")
      const parsed = JSON.parse(sanitized)
      expect(parsed.include).toEqual(["something.else"])
      expect(parsed.messages[0].reasoning).toEqual({})
      expect(parsed.messages[0].encryptedContent).toBeUndefined()
      expect(sanitized).not.toContain("encrypted_content")
      expect(sanitized).not.toContain("secret")
    })

    test("drops include entirely when no entries remain", () => {
      const body = JSON.stringify({ include: ["reasoning.encrypted_content"], input: [] })
      const sanitized = FetchProxy.sanitizeBody(body)
      expect(sanitized).toBeDefined()
      if (sanitized === undefined) throw new Error("expected sanitized body")
      const parsed = JSON.parse(sanitized)
      expect("include" in parsed).toBe(false)
    })

    test("returns undefined for bodies without encrypted content", () => {
      expect(FetchProxy.sanitizeBody(JSON.stringify({ model: "gpt-5", input: [] }))).toBeUndefined()
      expect(FetchProxy.sanitizeBody("not-json")).toBeUndefined()
      expect(FetchProxy.sanitizeBody("")).toBeUndefined()
    })

    test("scrubInit scrubs cloud chat/completions string bodies regardless of proxy URL", () => {
      const init = {
        method: "POST",
        body: JSON.stringify({
          include: ["reasoning.encrypted_content"],
          model: "gpt-5",
        }),
      }
      const scrubbed = FetchProxy.scrubInit("https://models.opencode.ai/zen/v1/chat/completions", init)
      expect(scrubbed).toBeDefined()
      if (scrubbed === undefined || scrubbed.body === undefined || scrubbed.body === null) {
        throw new Error("expected scrubbed body")
      }
      expect(String(scrubbed.body)).not.toContain("encrypted_content")
      expect(FetchProxy.scrubInit("https://opencode.ai/console/v1/responses", init)).toBeDefined()
    })

    test("scrubInit leaves non-cloud and non-completion URLs alone", () => {
      const init = {
        method: "POST",
        body: JSON.stringify({ include: ["reasoning.encrypted_content"] }),
      }
      // Non-cloud host: OpenAI/copilot must keep include replay intact.
      expect(
        FetchProxy.scrubInit("https://api.openai.com/v1/chat/completions", init),
      ).toBeUndefined()
      expect(
        FetchProxy.scrubInit("https://githubcopilot.com/agents/v1/responses", init),
      ).toBeUndefined()
      // Cloud host but unrelated path.
      expect(FetchProxy.scrubInit("https://models.opencode.ai/zen/v1/models", init)).toBeUndefined()
      expect(FetchProxy.scrubInit("https://models.opencode.ai/zen/v1/chat/completions", undefined)).toBeUndefined()
    })

    test("scrubInit honors OPENCODE_CLOUD_PROXY_DOMAINS for the scrub hostname gate", () => {
      process.env[CLOUD_PROXY_DOMAINS_ENV] = "only.example"
      const init = {
        method: "POST",
        body: JSON.stringify({ include: ["reasoning.encrypted_content"] }),
      }
      expect(
        FetchProxy.scrubInit("https://only.example/v1/chat/completions", init),
      ).toBeDefined()
      expect(
        FetchProxy.scrubInit("https://models.opencode.ai/zen/v1/chat/completions", init),
      ).toBeUndefined()
    })

    test("scrubInit rewrites Uint8Array bodies for cloud completions", () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ include: ["reasoning.encrypted_content"], model: "gpt-5" }),
      )
      const scrubbed = FetchProxy.scrubInit("https://zenmux.ai/api/v1/chat/completions", {
        method: "POST",
        body: bytes,
      })
      expect(scrubbed).toBeDefined()
      if (scrubbed === undefined || !(scrubbed.body instanceof Uint8Array)) {
        throw new Error("expected Uint8Array body")
      }
      const text = new TextDecoder().decode(scrubbed.body)
      expect(text).not.toContain("encrypted_content")
    })
  })

  test("install is idempotent and does not replace an already-installed wrapper", () => {
    FetchProxy.install()
    const first = globalThis.fetch
    FetchProxy.install()
    expect(globalThis.fetch).toBe(first)
  })
})
