import { describe, expect, test } from "bun:test"
import { highlightCommand, parseAnsi } from "./ansi"

describe("parseAnsi", () => {
  test("returns plain text unchanged", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world" }])
  })

  test("merges adjacent segments with the same style", () => {
    expect(parseAnsi("\x1b[32mgreen\x1b[0mrest")).toEqual([
      { text: "green", color: "#9ece6a" },
      { text: "rest" },
    ])
  })

  test("parses foreground colors, bright variants, and bold", () => {
    const segments = parseAnsi("\x1b[1;31mbold red\x1b[0m \x1b[96mcyan\x1b[0m")
    expect(segments).toEqual([
      { text: "bold red", color: "#f7768e", bold: true },
      { text: " " },
      { text: "cyan", color: "#8fd4f5" },
    ])
  })

  test("reset clears color and bold", () => {
    const segments = parseAnsi("\x1b[31mred\x1b[0mplain\x1b[1mbold\x1b[22mnormal")
    expect(segments).toEqual([
      { text: "red", color: "#f7768e" },
      { text: "plain" },
      { text: "bold", bold: true },
      { text: "normal" },
    ])
  })

  test("bare ESC [ m acts as reset", () => {
    expect(parseAnsi("\x1b[31mx\x1b[my")).toEqual([{ text: "x", color: "#f7768e" }, { text: "y" }])
  })

  test("drops non-SGR CSI sequences like clear-screen and cursor moves", () => {
    expect(parseAnsi("a\x1b[2Jb\x1b[Hc\x1b[Kd")).toEqual([{ text: "abcd" }])
  })

  test("ignores extended 38;5;N color params without leaking the index", () => {
    expect(parseAnsi("\x1b[38;5;31mindex\x1b[0m")).toEqual([{ text: "index" }])
  })

  test("normalizes nothing itself — callers handle \\r / \\r\\n", () => {
    expect(parseAnsi("a\r\nb\rc").map((s) => s.text).join("")).toBe("a\r\nb\rc")
  })

  test("drops OSC sequences like terminal title changes (ESC ] ... BEL)", () => {
    expect(parseAnsi("a\x1b]0;my-terminal\x07b")).toEqual([{ text: "ab" }])
  })

  test("drops OSC sequences terminated with ST (ESC ] ... ESC \\)", () => {
    expect(parseAnsi("a\x1b]0;my-terminal\x1b\\b")).toEqual([{ text: "ab" }])
  })

  test("drops an OSC sequence with no trailing BEL at end of input", () => {
    expect(parseAnsi("a\x1b]0;truncated-title")).toEqual([{ text: "a" }])
  })

  test("drops an incomplete CSI sequence at end of input without leaking or crashing", () => {
    expect(parseAnsi("red \x1b[31")).toEqual([{ text: "red " }])
  })
})

describe("highlightCommand", () => {
  test("marks the first token as a command", () => {
    expect(highlightCommand("git status --short")).toEqual([
      { text: "git", type: "command" },
      { text: " status ", type: "text" },
      { text: "--short", type: "flag" },
    ])
  })

  test("flags, strings, and keywords get their own types", () => {
    const segments = highlightCommand("echo \"hello world\" && ls -la")
    expect(segments).toEqual([
      { text: "echo", type: "command" },
      { text: " ", type: "text" },
      { text: '"hello world"', type: "string" },
      { text: " ", type: "text" },
      { text: "&&", type: "operator" },
      { text: " ", type: "text" },
      { text: "ls", type: "command" },
      { text: " ", type: "text" },
      { text: "-la", type: "flag" },
    ])
  })

  test("env assignments are marked, comments run to end of line", () => {
    const segments = highlightCommand("FOO=bar npm install # bootstrap")
    expect(segments[0]).toEqual({ text: "FOO=bar", type: "env" })
    expect(segments[segments.length - 1]).toEqual({ text: "# bootstrap", type: "comment" })
    expect(segments[2]).toEqual({ text: "npm", type: "command" })
  })

  test("commands after operators restart the command position", () => {
    const segments = highlightCommand("cat a.txt | grep -n x ; rm -f y")
    const commands = segments.filter((s) => s.type === "command").map((s) => s.text)
    expect(commands).toEqual(["cat", "grep", "rm"])
  })

  test("shell keywords keep their own type even at the start", () => {
    const segments = highlightCommand("if [ -f x ]; then echo yes; fi")
    expect(segments[0]).toEqual({ text: "if", type: "keyword" })
  })
})
