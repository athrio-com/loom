import { Array, Option, pipe, Schema as S } from 'effect'
import { Navigation } from '@athrio/foldkit'
import { html } from '@athrio/foldkit/html'
import { m } from '@athrio/foldkit/message'
import {
  type WovenNavEntry,
  type WovenPage,
  type WovenPart,
  WovenPageSchema,
  WovenPartSchema,
} from '@athrio/loom-lang/weave/WovenCorpus'
import './styles.css'

export const Flags = S.Struct({
  nav: S.Array(WovenPartSchema),
  page: S.optional(WovenPageSchema),
})
export type Flags = typeof Flags.Type

export const RouteSchema = S.Union([
  S.Struct({ _tag: S.tag('Landing') }),
  S.Struct({ _tag: S.tag('Docs'), slug: S.String }),
])
export type Route = typeof RouteSchema.Type

export const Model = S.Struct({
  route: RouteSchema,
  theme: S.Literals(['light', 'dark']),
  navClosed: S.Boolean,
  tocClosed: S.Boolean,
  nav: S.Array(WovenPartSchema),
  pages: S.Array(WovenPageSchema),
})
export type Model = typeof Model.Type

export const ChangedUrl = m('ChangedUrl', { pathname: S.String })
export const ClickedLink = m('ClickedLink', { request: Navigation.UrlRequest })
export const GotPage = m('GotPage', { slug: S.String, page: WovenPageSchema })
export const CompletedNavigation = m('CompletedNavigation')
export const ToggledTheme = m('ToggledTheme')
export const ToggledNav = m('ToggledNav')
export const ToggledToc = m('ToggledToc')
export const ClickedCopy = m('ClickedCopy', { text: S.String })

export const Message = S.Union([
  ChangedUrl,
  ClickedLink,
  GotPage,
  CompletedNavigation,
  ToggledTheme,
  ToggledNav,
  ToggledToc,
  ClickedCopy,
])
export type Message = typeof Message.Type

export const h = html<Message>()

const stripOrder = (segment: string): string => segment.replace(/^\d+-/, '')

export const pathForSlug = (slug: string): string =>
  `/${pipe(slug.split('/'), Array.map(stripOrder), Array.join('/'))}`

const chaptersOf = (
  nav: ReadonlyArray<WovenPart>,
): ReadonlyArray<WovenNavEntry> => Array.flatMap(nav, (part) => part.chapters)

export const firstSlugOf = (nav: ReadonlyArray<WovenPart>): string =>
  pipe(
    chaptersOf(nav),
    Array.head,
    Option.map((chapter) => chapter.slug),
    Option.getOrElse(() => ''),
  )

const slugForPath = (
  nav: ReadonlyArray<WovenPart>,
  pathname: string,
): string =>
  pipe(
    chaptersOf(nav),
    Array.findFirst((chapter) => pathForSlug(chapter.slug) === pathname),
    Option.map((chapter) => chapter.slug),
    Option.getOrElse(() => firstSlugOf(nav)),
  )

export const routeForPath = (
  nav: ReadonlyArray<WovenPart>,
  pathname: string,
): Route =>
  pathname === '/'
    ? { _tag: 'Landing' }
    : { _tag: 'Docs', slug: slugForPath(nav, pathname) }

export const pageOf = (
  pages: ReadonlyArray<WovenPage>,
  slug: string,
): Option.Option<WovenPage> =>
  Array.findFirst(pages, (page) => page.slug === slug)
