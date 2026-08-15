import { createContext, type Accessor, type JSX, useContext } from "solid-js"
import { resolveLocale, translate, type Key, type Locale, type Params, type Translator } from "../i18n"

type Value = {
  readonly locale: Accessor<Locale>
  readonly t: Translator
}

const I18nContext = createContext<Value>()

export function I18nProvider(props: { locale: Locale | Accessor<Locale>; children: JSX.Element }) {
  const locale = () => resolveLocale(typeof props.locale === "function" ? props.locale() : props.locale)
  const value: Value = {
    locale,
    t: (key: Key, params?: Params) => translate(locale(), key, params),
  }
  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>
}

export function useI18n() {
  const value = useContext(I18nContext)
  if (!value) throw new Error("I18nProvider is missing")
  return value
}
