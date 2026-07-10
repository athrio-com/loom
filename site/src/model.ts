import { Array, Option, pipe, Schema as S } from 'effect'
import { Navigation } from '@athrio/foldkit'
import { html } from '@athrio/foldkit/html'
import { m } from '@athrio/foldkit/message'
import { WovenCorpusSchema } from '@athrio/loom-lang/weave/WovenCorpus'
import siteData from './data/site.json'
import './styles.css'

export const site = S.decodeUnknownSync(WovenCorpusSchema)(siteData)

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
})
export type Model = typeof Model.Type

export const ChangedUrl = m('ChangedUrl', { route: RouteSchema })
export const ClickedLink = m('ClickedLink', { request: Navigation.UrlRequest })
export const CompletedNavigation = m('CompletedNavigation')
export const ToggledTheme = m('ToggledTheme')
export const ToggledNav = m('ToggledNav')
export const ToggledToc = m('ToggledToc')
export const Copy = m('Copy', { text: S.String })

export const Message = S.Union([
  ChangedUrl,
  ClickedLink,
  CompletedNavigation,
  ToggledTheme,
  ToggledNav,
  ToggledToc,
  Copy,
])
export type Message = typeof Message.Type

export const h = html<Message>()

const stripOrder = (segment: string): string => segment.replace(/^\d+-/, '')

export const pathForSlug = (slug: string): string =>
  `/${pipe(slug.split('/'), Array.map(stripOrder), Array.join('/'))}`

export const firstSlug = pipe(
  Array.flatMap(site.nav, (part) => part.chapters),
  Array.head,
  Option.map((chapter) => chapter.slug),
  Option.getOrElse(() => ''),
)

const pathIndex = new Map(
  Array.map(site.pages, (page) => [pathForSlug(page.slug), page.slug] as const),
)

const slugForPath = (pathname: string): string =>
  Option.getOrElse(Option.fromNullishOr(pathIndex.get(pathname)), () => firstSlug)

export const routeForPath = (pathname: string): Route =>
  pathname === '/' ? { _tag: 'Landing' } : { _tag: 'Docs', slug: slugForPath(pathname) }
