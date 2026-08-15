import { logo } from "../logo"
import { translate, type Translator } from "../i18n"
import { stringWidth } from "./string-width"

const englishTranslator: Translator = (key, params) => translate("en", key, params)

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

function wordmark(pad = "") {
  const draw = (line: string, fg: string, shadow: string, bg: string) =>
    [...line]
      .map((char) => {
        if (char === "_") return `${bg} ${reset}`
        if (char === "^") return `${fg}${bg}▀${reset}`
        if (char === "~") return `${shadow}▀${reset}`
        if (char === " ") return " "
        return `${fg}${char}${reset}`
      })
      .join("")

  return logo.left.map((line, index) => {
    const left = draw(line, dim, "\x1b[38;5;235m", "\x1b[48;5;235m")
    const right = draw(logo.right[index] ?? "", reset, "\x1b[38;5;238m", "\x1b[48;5;238m")
    return `${pad}${left} ${right}`
  })
}

export function sessionEpilogue(input: { title: string; sessionID?: string }, t: Translator = englishTranslator) {
  const weak = (text: string) => `${dim}${text}${" ".repeat(Math.max(0, 10 - stringWidth(text)))}${reset}`
  return [
    ...wordmark("  "),
    "",
    `  ${weak(t("common.session.epilogue.session"))}${bold}${input.title}${reset}`,
    `  ${weak(t("common.session.epilogue.continue"))}${bold}opencode2 -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
