import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { FetchProxy } from "../../src/util/proxy"

const PROXY_URL = "http://192.168.1.6:3128"
const ENV_PROXY_URL = "http://env-proxy:8080"
const CLOUD_PROXY_ENV = "OPENCODE_CLOUD_PROXY"
const CLOUD_PROXY_DOMAINS_ENV = "OPENCODE_CLOUD_PROXY_DOMAINS"

describe("util.proxy", () => {
  beforeEach(() => {
    delete process.env[CLOUD_PROXY_ENV]
    delete process.env[CLOUD_PROXY_DOMAINS_ENV]
    FetchProxy.setConfig({ url: PROXY_URL, domains: [] })
  })

  afterEach(() => {
    FetchProxy.setConfig(undefined)
    delete process.env[CLOUD_PROXY_ENV]
    delete process.env[CLOUD_PROXY_DOMAINS_ENV]
  })

  test("routes opencode domains through the default list", () => {
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
    expect(FetchProxy.getProxyForHostname("api.anthropic.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("api.openai.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("github.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("evilopencode.ai")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("opencode.ai.evil.com")).toBeUndefined()
  })

  test("uses custom domains when configured", () => {
    FetchProxy.setConfig({ url: PROXY_URL, domains: ["*.example.com"] })
    expect(FetchProxy.getProxyForHostname("api.example.com")).toBe(PROXY_URL)
    expect(FetchProxy.getProxyForHostname("example.com")).toBeUndefined()
    expect(FetchProxy.getProxyForHostname("api.opencode.ai")).toBeUndefined()
  })

  test("is a no-op without config", () => {
    FetchProxy.setConfig(undefined)
    expect(FetchProxy.getProxyForHostname("opencode.ai")).toBeUndefined()
    expect(FetchProxy.proxiedInit("https://opencode.ai/install")).toBeUndefined()
  })

  test("routes cloud model hostnames via OPENCODE_CLOUD_PROXY without config", () => {
    process.env[CLOUD_PROXY_ENV] = ENV_PROXY_URL
    FetchProxy.setConfig(undefined)
    expect(FetchProxy.getProxyForHostname("opencode.ai")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("zenmux.ai")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("gateway.opencode.ai")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.anthropic.com")).toBeUndefined()
  })

  test("OPENCODE_CLOUD_PROXY takes precedence over the config file", () => {
    process.env[CLOUD_PROXY_ENV] = ENV_PROXY_URL
    FetchProxy.setConfig({ url: PROXY_URL, domains: ["*.example.com"] })
    expect(FetchProxy.getProxyForHostname("zenmux.ai")).toBe(ENV_PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.example.com")).toBeUndefined()
  })

  test("OPENCODE_CLOUD_PROXY_DOMAINS overrides the config file domains", () => {
    process.env[CLOUD_PROXY_DOMAINS_ENV] = "example.com,*.example.org"
    FetchProxy.setConfig({ url: PROXY_URL, domains: ["*.example.com"] })
    expect(FetchProxy.getProxyForHostname("example.com")).toBe(PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.example.org")).toBe(PROXY_URL)
    expect(FetchProxy.getProxyForHostname("api.example.com")).toBeUndefined()
  })

  test("OPENCODE_CLOUD_PROXY_DOMAINS narrows the proxy when only the env URL is set", () => {
    process.env[CLOUD_PROXY_ENV] = ENV_PROXY_URL
    process.env[CLOUD_PROXY_DOMAINS_ENV] = "example.com"
    FetchProxy.setConfig(undefined)
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
    const init: RequestInit & { proxy?: string } = { proxy: "http://other-proxy:8080" }
    expect(FetchProxy.proxiedInit("https://zenmux.ai/chat/completions", init)).toBeUndefined()
  })

  test("install is idempotent and does not replace an already-installed wrapper", () => {
    FetchProxy.install()
    const first = globalThis.fetch
    FetchProxy.install()
    expect(globalThis.fetch).toBe(first)
  })
})