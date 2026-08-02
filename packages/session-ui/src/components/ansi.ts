/**
 * Lightweight terminal output helpers for tool parts.
 *
 * - `parseAnsi` interprets a base set of ANSI SGR sequences (foreground colors
 *   30-37 / 90-97, bold, reset) into styled text segments and silently drops all
 *   other control sequences: non-SGR CSI (cursor movement, clear-screen, ...),
 *   OSC sequences such as `ESC ] 0;title BEL` / `ESC ] ... ESC \` (terminal
 *   title, hyperlinks, ...), and extended 24-bit color modes. Incomplete escape
 *   sequences truncated at the end of the input (e.g. a trailing `ESC [ 31`
 *   with no final byte) are cut off so they never leak control bytes into the
 *   UI. Kept dependency-free on purpose: nothing heavier than a regex is needed
 *   for the output rendered by shell tools.
 * - `highlightCommand` colorizes a shell command line (command, flags, strings,
 *   keywords, env assignments, operators, comments) using a simple regex scanner.
 */

export interface AnsiSegment {
  text: string
  color?: string
  bold?: boolean
}

export interface CommandSegment {
  text: string
  type: "command" | "flag" | "string" | "keyword" | "env" | "operator" | "comment" | "text"
}

// Fixed palette tuned for the dark terminal surface so contrast holds in both
// light and dark app themes.
const ANSI_FG: Record<string, string> = {
  "30": "#565f89",
  "31": "#f7768e",
  "32": "#9ece6a",
  "33": "#e0af68",
  "34": "#7aa2f7",
  "35": "#bb9af7",
  "36": "#7dcfff",
  "37": "#c0caf5",
  "90": "#565f89",
  "91": "#ff9eac",
  "92": "#b4e59c",
  "93": "#e8c17a",
  "94": "#9db8f9",
  "95": "#c8b1f8",
  "96": "#8fd4f5",
  "97": "#e6eaf2",
}

// Matches CSI sequences: ESC [ params final-byte
const CSI_RE = /\x1b\[([0-9;?]*)([A-Za-z])/g

// Matches OSC sequences: ESC ] ... terminated by BEL or ESC \ (ST). Emitted by
// shells/tmux for terminal titles etc.; stripped from the output entirely.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

// Trailing escape sequence that never received its terminator/final byte
// (truncated stream, e.g. a CSI with only params like "ESC [ 31" or an OSC
// with no BEL/ST like "ESC ] 0;title", both at end of input). Cut from the
// end so no literal control bytes reach the UI.
const TRAILING_ESC_RE = /\x1b\[[0-9;?]*$|\x1b\][^\x07\x1b]*$/

type SgrState = { bold: boolean; color: string | undefined }

function applySgr(params: string, state: SgrState) {
  const codes = params === "" ? ["0"] : params.split(";")
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code === "0") {
      state.bold = false
      state.color = undefined
      continue
    }
    if (code === "1") {
      state.bold = true
      continue
    }
    if (code === "22") {
      state.bold = false
      continue
    }
    if (code === "39") {
      state.color = undefined
      continue
    }
    // Extended color modes carry extra params; skip them so a color index like
    // "31" inside 38;5;31 is not misinterpreted as a base foreground code.
    if (code === "38" || code === "48") {
      const mode = codes[i + 1]
      if (mode === "5") i += 2
      else if (mode === "2") i += 4
      continue
    }
    const color = ANSI_FG[code]
    if (color) state.color = color
  }
}

/**
 * Parse ANSI-colored text into styled segments. Non-SGR CSI sequences (e.g.
 * `\x1b[2J`, `\x1b[H`, `\x1b[?25l`), OSC sequences (`\x1b]0;title\x07`,
 * `\x1b]...\x1b\\`) and incomplete trailing escapes are dropped from the
 * output entirely.
 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const state: SgrState = { bold: false, color: undefined }
  let cursor = 0
  const emit = (text: string) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.color === state.color && (last.bold ?? false) === state.bold) last.text += text
    else {
      const segment: AnsiSegment = { text }
      if (state.color) segment.color = state.color
      if (state.bold) segment.bold = true
      segments.push(segment)
    }
  }

  // Strip OSC payloads and any escape left unterminated at the end of the
  // string before scanning for SGR sequences.
  const cleaned = input.replace(OSC_RE, "").replace(TRAILING_ESC_RE, "")

  CSI_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = CSI_RE.exec(cleaned))) {
    emit(cleaned.slice(cursor, match.index))
    if (match[2] === "m") applySgr(match[1], state)
    cursor = match.index + match[0].length
  }
  emit(cleaned.slice(cursor))
  return segments
}

const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "in",
  "function",
  "select",
  "time",
])

const COMMAND_START_RE = /^[A-Za-z_][A-Za-z0-9_]*/
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\s;&|<>]*/
const FLAG_RE = /^--?[A-Za-z0-9][A-Za-z0-9_-]*/
const TOKEN_RE = /^[^\s"';&|<>]+/

/**
 * Lightweight shell command highlighting: first token after an operator is a
 * command, flags/strings/keywords/env assignments get their own color. Never a
 * real parser — good enough to make a command line readable in the timeline.
 */
export function highlightCommand(input: string): CommandSegment[] {
  const segments: CommandSegment[] = []
  let expectCommand = true
  let i = 0
  const push = (text: string, type: CommandSegment["type"]) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (last && last.type === type) last.text += text
    else segments.push({ text, type })
  }

  while (i < input.length) {
    const rest = input.slice(i)
    const next = rest[0]

    if (next === "#") {
      const end = input.indexOf("\n", i)
      const text = end === -1 ? rest : rest.slice(0, end - i)
      push(text, "comment")
      i += text.length
      continue
    }

    if (next === '"' || next === "'") {
      let j = i + 1
      while (j < input.length) {
        if (input[j] === "\\") {
          j += 2
          continue
        }
        j += 1
        if (input[j - 1] === next) break
      }
      push(input.slice(i, j), "string")
      i = j
      continue
    }

    if (next === "-") {
      const flag = rest.match(FLAG_RE)?.[0]
      if (flag) {
        push(flag, "flag")
        i += flag.length
        continue
      }
    }

    if (rest.startsWith("&&") || rest.startsWith("||")) {
      push(rest.slice(0, 2), "operator")
      i += 2
      expectCommand = true
      continue
    }

    if (next === "|" || next === ";" || next === "&") {
      push(next, "operator")
      i += 1
      expectCommand = true
      continue
    }

    if (/[A-Za-z_]/.test(next)) {
      const word = rest.match(COMMAND_START_RE)?.[0]
      if (word && input[i + word.length] === "=") {
        const env = rest.match(ENV_ASSIGN_RE)?.[0]
        if (env) {
          push(env, "env")
          i += env.length
          continue
        }
      }
      if (word) {
        if (SHELL_KEYWORDS.has(word)) push(word, "keyword")
        else {
          push(word, expectCommand ? "command" : "text")
          expectCommand = false
        }
        i += word.length
        continue
      }
    }

    if (/[A-Za-z0-9_.~/-]/.test(next)) {
      const token = rest.match(TOKEN_RE)?.[0]
      if (token) {
        push(token, expectCommand ? "command" : "text")
        expectCommand = false
        i += token.length
        continue
      }
    }

    push(next, "text")
    i += 1
  }
  return segments
}
