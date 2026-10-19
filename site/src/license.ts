import { Array, Option, pipe } from 'effect'
import { type Html, inertHtml as ih } from 'foldkit/html'
import { broadSeam, type Carpet, carpetMark, loomMark } from './components'
import licenseFile from '../../LICENSE?raw'

const NAVY = '#14204A'

type LicenseParts = {
  readonly title: string
  readonly notice: string
  readonly terms: ReadonlyArray<string>
}

const licenseParts = (text: string): LicenseParts => {
  const paragraphs = pipe(
    text.split(/\n\s*\n/),
    Array.map((paragraph) =>
      pipe(
        paragraph.split('\n'),
        Array.map((line) => line.trim()),
        Array.join(' '),
      ).trim(),
    ),
    Array.filter((paragraph) => paragraph !== ''),
  )
  return {
    title: Option.getOrElse(Array.get(paragraphs, 0), () => 'License'),
    notice: Option.getOrElse(Array.get(paragraphs, 1), () => ''),
    terms: Array.drop(paragraphs, 2),
  }
}

const licenseCarpet: Carpet = {
  rows: ['.ppppp.', '.paaap.', '.ppppp.', '.paaap.', '.ppppp.', '.paap..', '.ppp...'],
  threads: { '.': NAVY, p: '#F2EFE6', a: '#FFC53D' },
}

const licenseText = (): Html => {
  const parts = licenseParts(licenseFile)
  return ih.div(
    [ih.Class('section'), ih.Id('license-text')],
    [
      ih.div(
        [ih.Class('license-column')],
        [
          ih.div(
            [ih.Class('section-head')],
            [
              carpetMark(licenseCarpet, '42px', broadSeam),
              ih.div(
                [ih.Class('lines')],
                [ih.span([ih.Class('eyebrow')], ['The terms']), ih.h2([], [parts.title])],
              ),
            ],
          ),
          ih.div(
            [ih.Class('license-body')],
            [
              ih.p([ih.Class('prose license-notice')], [parts.notice]),
              ...Array.map(parts.terms, (term) => ih.p([ih.Class('prose')], [term])),
            ],
          ),
        ],
      ),
    ],
  )
}

export const license = (): ReadonlyArray<Html> => [licenseHead(), licenseText()]

const licenseHead = (): Html =>
  ih.div(
    [ih.Class('section section-hero page-hero'), ih.Id('license-top')],
    [
      ih.div(
        [ih.Class('license-column')],
        [
          ih.div([ih.Class('page-title')], [loomMark('paper', 0.8), ih.h1([], ['License'])]),
          ih.div(
            [ih.Class('license-plain')],
            Array.map(plainly, (paragraph) => ih.p([ih.Class('prose')], [paragraph])),
          ),
        ],
      ),
    ],
  )

const plainly: ReadonlyArray<string> = [
  'Loom is free software under the MIT licence. You may use it, copy it, change it and share it, in any project, open or closed, paid or free.',
  'The one condition is that the copyright notice and the permission below travel with every copy. Loom comes with no warranty: if it breaks, the licence holds nobody liable.',
  'The licence covers Loom: this repository and every package it publishes.',
]
