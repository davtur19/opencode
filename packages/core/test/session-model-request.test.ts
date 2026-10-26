import { beforeEach, describe, expect, test } from "bun:test"
import { LLM, LanguageModel, Message, SystemPart, ToolResultPart, Media } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Provider } from "@opencode/schema/provider"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionEgress } from "@opencode/core/session/egress"
import { SessionEnvironmentStamp } from "@opencode/core/session/environment-stamp"
import { boundImages, refresh, stampEnvironment, unsupportedParts, wireIdentity } from "@opencode/core/session/model-request"
import { SessionSchema } from "@opencode/core/session/schema"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", media: Media.base64("aGVsbG8=", "image/png"), filename: "logo.png" },
          { type: "media", media: Media.base64("JVBERg==", "application/pdf"), filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("replaces images xAI cannot decode and keeps png, jpeg and webp", () => {
    const image = (mime: string, name: string) => ({
      type: "media" as const,
      media: Media.base64("aGVsbG8=", mime),
      filename: name,
    })
    const user = [image("image/png", "a.png"), image("image/jpeg", "b.jpg"), image("image/webp", "c.webp")]
    const messages = [
      Message.user([...user, image("image/gif", "d.gif")]),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: "data:image/gif;base64,R0lGODlh", mime: "image/gif", name: "e.gif" },
            ],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]), "xai")

    expect(result[0]?.content).toEqual([
      ...user,
      Message.text('ERROR: Cannot read "d.gif" (this model does not support image/gif input). Inform the user.'),
    ])
    expect(result[1]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "e.gif" (this model does not support image/gif input). Inform the user.',
          },
        ],
      },
    })
    expect(unsupportedParts(messages, capabilities(["text", "image"]), "openai")).toEqual(messages)
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })

  test("returns the same messages when nothing is unsupported", () => {
    const messages = [
      Message.user([Message.text("hi"), { type: "media", media: Media.base64("aGVsbG8=", "image/png") }]),
      Message.assistant("hello"),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" }],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]))
    expect(result).toHaveLength(messages.length)
    result.forEach((message, index) => expect(message).toBe(messages[index]))
  })

  test("rebuilds only messages with unsupported media", () => {
    const text = Message.user("plain")
    const supported = Message.tool(
      ToolResultPart.make({
        id: "call_1",
        name: "read",
        result: { type: "content", value: [{ type: "text", text: "no files" }] },
      }),
    )
    const tool = ToolResultPart.make({
      id: "call_2",
      name: "read",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "file", uri: "data:application/pdf;base64,JVBERg==", mime: "application/pdf" },
        ],
      },
    })
    const unsupported = Message.make({ role: "tool", content: [tool, Message.text("caption")] })
    const result = unsupportedParts([text, supported, unsupported], capabilities(["text"]))

    expect(result[0]).toBe(text)
    expect(result[1]).toBe(supported)
    expect(result[2]).not.toBe(unsupported)
    expect(result[2]).toBeInstanceOf(Message)
    expect(result[2]?.content[1]).toEqual(Message.text("caption"))
    expect(result[2]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "text", text: "ERROR: Cannot read pdf (this model does not support pdf input). Inform the user." },
        ],
      },
    })
    expect(tool.result).toMatchObject({
      type: "content",
      value: [
        { type: "text", text: "Read" },
        { type: "file", mime: "application/pdf" },
      ],
    })
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const text = Message.user("plain")
    const third = Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "third.png" })
    const messages = [
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "first.png" }),
      text,
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "second.png" }),
      third,
    ]
    const result = boundImages(messages)

    expect(result[0]).toBeInstanceOf(Message)
    expect(result[0]?.content).toEqual([Message.text(expect.stringContaining("image was removed"))])
    expect(result[1]).toBe(text)
    expect(result[2]).not.toBe(messages[2])
    expect(result[2]?.content[0]).toMatchObject({ type: "text" })
    expect(result[3]).toBe(third)
  })

  test("keeps the replaced prefix stable as new images arrive, so the prompt cache survives", () => {
    const image = (name: string) =>
      Message.user({ type: "media", media: Media.base64("a".repeat(3 * 1024 * 1024), "image/png"), filename: name })
    const removed = (messages: ReturnType<typeof boundImages>) =>
      messages.filter((message) => message.content[0]?.type === "text").length
    const history = Array.from({ length: 9 }, (_, i) => image(`${i}.png`))

    // 27 MiB passes the 25 MiB trigger: the oldest four go, leaving 15 MiB.
    expect(removed(boundImages(history))).toBe(4)
    // Each later image used to move the cut by one; now the cut holds until the kept payload passes the trigger again.
    expect(removed(boundImages([...history, image("9.png")]))).toBe(4)
    expect(removed(boundImages([...history, image("9.png"), image("10.png"), image("11.png")]))).toBe(4)
    expect(removed(boundImages([...history, ...Array.from({ length: 4 }, (_, i) => image(`${9 + i}.png`))]))).toBe(8)
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})

const native = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const model = LanguageModel.make({ id: "model", provider: "opencode", route: OpenAIChat.route })

describe("SessionModelRequest.wireIdentity", () => {
  beforeEach(() => SessionEgress.clear())

  test("uses a stable native alias for the opencode gateway", () => {
    const input = { id: SessionSchema.ID.make("ses_chat") }
    const first = wireIdentity(input, Provider.ID.opencode)
    const second = wireIdentity(input, Provider.ID.opencode)

    expect(first.session).toBe(first.affinity)
    expect(first.session).toBe(second.session)
    expect(first.session).not.toBe(input.id)
    expect(first.session).toMatch(native)
    expect(first.parent).toBeUndefined()
  })

  test("keeps the real session and affinity for other providers", () => {
    const parent = SessionSchema.ID.make("ses_parent")
    const input = { id: SessionSchema.ID.make("ses_chat"), parentID: parent }
    const identity = wireIdentity(input, Provider.ID.anthropic)

    expect(identity.session).toBe(input.id)
    expect(identity.affinity).toBe(parent)
    expect(identity.parent).toBe(parent)
  })

  test("gives a parent its own alias on the opencode gateway", () => {
    const parent = SessionSchema.ID.make("ses_parent")
    const input = { id: SessionSchema.ID.make("ses_chat"), parentID: parent }
    const identity = wireIdentity(input, Provider.ID.opencode)

    expect(identity.parent).toBeDefined()
    expect(identity.parent).not.toBe(parent)
    expect(identity.parent).toMatch(native)
  })

  test("replaces a fork source affinity with the alias on the opencode gateway", () => {
    const source = SessionSchema.ID.make("ses_imported")
    const input = {
      id: SessionSchema.ID.make("ses_chat"),
      fork: { sessionID: source, boundary: { type: "before" as const, messageID: SessionMessage.ID.make("msg_1") } },
    }
    const identity = wireIdentity(input, Provider.ID.opencode)

    expect(identity.affinity).toBe(identity.session)
    expect(identity.affinity).not.toBe(source)
  })

  test("refreshes an already prepared request after a rotation", () => {
    const input = { id: SessionSchema.ID.make("ses_chat") }
    const first = wireIdentity(input, Provider.ID.opencode).session
    const request = LLM.request({
      model,
      prompt: "hello",
      http: { headers: { "x-opencode-session-id": first, "x-keep": "yes" } },
      promptCacheKey: first,
    })
    const next = SessionEgress.rotate(input.id)
    const refreshed = refresh(request, input, Provider.ID.opencode)

    expect(refreshed.http?.headers?.["x-opencode-session-id"]).toBe(next)
    expect(refreshed.http?.headers?.["x-session-affinity"]).toBe(next)
    expect(refreshed.http?.headers?.["x-keep"]).toBe("yes")
    expect(refreshed.promptCacheKey).toBe(next)
  })
})

describe("SessionModelRequest.stampEnvironment", () => {
  const environment = SystemPart.make(
    "<env>\n  Working directory: /project\n  Workspace root folder: /project\n</env>",
  )
  const session = (id: string) => SessionSchema.ID.make(id)

  beforeEach(() => SessionEnvironmentStamp.clear())

  test("adds a stable session id inside the environment block", () => {
    const first = stampEnvironment([environment], session("ses_a"))
    const second = stampEnvironment([environment], session("ses_a"))

    expect(first).toEqual(second)
    expect(first[0]?.text).toContain("Working directory: /project")
    expect(first[0]?.text).toMatch(/  Environment id: [0-9a-f]{12}\n<\/env>/)
    expect(environment.text).not.toContain("Environment id:")
  })

  test("rotates the id after every completed compaction", () => {
    const target = session("ses_rotate")
    const first = stampEnvironment([environment], target)[0]?.text

    SessionEnvironmentStamp.compacted(target)
    expect(stampEnvironment([environment], target)[0]?.text).not.toBe(first)
  })

  test("uses a different id for another session", () => {
    expect(stampEnvironment([environment], session("ses_a"))).not.toEqual(
      stampEnvironment([environment], session("ses_b")),
    )
  })

  test("leaves system parts without an environment block unchanged", () => {
    const plain = SystemPart.make("plain instructions")

    expect(stampEnvironment([plain], session("ses_a"))[0]).toBe(plain)
  })
})
