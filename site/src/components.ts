import { Array, Match, Option, pipe } from 'effect'
import { type Html, inertHtml as ih } from 'foldkit/html'

const NAVY = '#14204A'
const PAPER = '#F2EFE6'

export type Carpet = {
  readonly rows: ReadonlyArray<string>
  readonly threads: Record<string, string>
}

export type Seam = {
  readonly bleed: number
  readonly overlap: number
  readonly inset: number
}

export const fineSeam: Seam = { bleed: 0.5, overlap: 0, inset: 0 }
export const broadSeam: Seam = { bleed: 0.8, overlap: 0.2, inset: 1 }

const pct = (value: number): string => `${Number(value.toFixed(4))}%`

const rowStops = (row: string, threads: Record<string, string>, overlap: number): string =>
  pipe(
    row.split(''),
    Array.map((glyph, cell) => {
      const colour = pipe(
        Option.fromNullishOr(threads[glyph]),
        Option.getOrElse(() => NAVY),
      )
      const from = (cell * 100) / row.length
      const upTo = Math.min(100, ((cell + 1) * 100) / row.length + overlap)
      return `${colour} ${pct(from)} ${pct(upTo)}`
    }),
    Array.join(', '),
  )

const insetBox = (inset: number): Record<string, string> =>
  inset === 0
    ? {}
    : {
        padding: `${inset}px`,
        backgroundOrigin: 'content-box',
        backgroundClip: 'content-box',
      }

export const carpetStyle = (carpet: Carpet, seam: Seam): Record<string, string> => ({
  ...insetBox(seam.inset),
  backgroundRepeat: 'no-repeat',
  backgroundSize: `100% calc(100% / ${carpet.rows.length} + ${seam.bleed}px)`,
  backgroundPosition: pipe(
    carpet.rows,
    Array.map((_, row) => `0 ${pct((row * 100) / (carpet.rows.length - 1))}`),
    Array.join(', '),
  ),
  backgroundImage: pipe(
    carpet.rows,
    Array.map((row) => `linear-gradient(90deg, ${rowStops(row, carpet.threads, seam.overlap)})`),
    Array.join(', '),
  ),
})

export const carpetMark = (carpet: Carpet, size: string, seam: Seam = fineSeam): Html =>
  ih.span(
    [
      ih.AriaHidden(true),
      ih.Style({
        ...carpetStyle(carpet, seam),
        display: 'block',
        flex: 'none',
        width: size,
        height: size,
      }),
    ],
    [],
  )

export const docsCarpet: Carpet = {
  rows: ['.......', '.aaaaa.', '.a...a.', '.aaa.a.', '.a...a.', '.aaaap.', '.......'],
  threads: { '.': NAVY, p: PAPER, a: '#2E6FF2' },
}

export const whyLoomCarpet: Carpet = {
  rows: ['...a...', '..aba..', '.abpba.', 'abpcpba', '.abpba.', '..aba..', '...a...'],
  threads: { '.': NAVY, p: PAPER, a: '#FFC53D', b: '#00B37E', c: '#E8318A' },
}

export const communityCarpet: Carpet = {
  rows: ['.......', '.aaaaa.', '.a.b.a.', '.abpba.', '.a.b.a.', '.aaaaa.', '.......'],
  threads: { '.': NAVY, p: PAPER, a: '#8B5CF6', b: '#2E6FF2' },
}

export const sourceCarpet: Carpet = {
  rows: ['.......', '..a.a..', '.a...a.', 'b.....b', '.a...a.', '..a.a..', '.......'],
  threads: { '.': NAVY, p: PAPER, a: '#2E6FF2', b: '#FF6A3D' },
}

export const exampleCarpet: Carpet = {
  rows: ['....g.g', '...gg..', 'g..g...', '.gooo..', '.goyo.g', '..ooo.v', '.g.....'],
  threads: { '.': NAVY, p: PAPER, g: '#00B37E', o: '#FF6A3D', y: '#FFC53D', v: '#8B5CF6' },
}

export const vocabularyCarpet: Carpet = {
  rows: ['....gg.', '...g...', '..g....', 'mmmggg.', 'mym.gg.', 'mmmg.gg', '...o...'],
  threads: { '.': NAVY, p: PAPER, g: '#00B37E', m: '#E8318A', y: '#FFC53D', o: '#FF6A3D' },
}

export const operationsCarpet: Carpet = {
  rows: ['....g..', 'gg.....', 'g..vvv.', '.g.vpv.', '..gvvv.', '...g...', 'o...g.g'],
  threads: { '.': NAVY, p: PAPER, g: '#00B37E', v: '#8B5CF6', o: '#FF6A3D' },
}

const GREEN = '#00B37E'

const sunflower = ['..aaa..', '.aacaa.', '.ac.ca.', '.aacaa.', '..aaa..', '..gg...', '...g...']
const tulip = ['.a.a.a.', '.aaaaa.', '..aaa..', '...g...', '.gg.g..', '..ggg..', '...g...']
const bells = ['.ggggg.', 'g....g.', 'a.g..a.', '..a..g.', '.....g.', '..b.gg.', '....g..']
const berries = ['a...a..', 'g..aga.', '.g..g..', '..g.g.b', '...gggg', '....g..', '....g..']
const sprout = ['...b...', '...g...', 'gg.g.gg', 'ggggggg', '.g.g.g.', '...g...', '..ggg..']
const fern = ['....b..', '...g.g.', '.g.g...', '..gg.g.', '...gg..', '.g.g...', '...g...']
const bouquet = ['a.....c', '.g.b.g.', '..g.g..', '...g...', '..ggg..', '...g...', '...g...']
const clover = ['.gg.gg.', '.gg.gg.', '...b...', '..ggg..', '..gg...', '...g...', '...g...']
const tuft = ['.....a.', '..a..g.', '..g..g.', 'g.g.g..', '.gg.g.g', '..ggg.g', '...g...']

const flowerShapes: ReadonlyArray<ReadonlyArray<string>> = [
  sunflower,
  tulip,
  bells,
  berries,
  sprout,
  fern,
  bouquet,
  clover,
  tuft,
]

const flowerThreads: ReadonlyArray<string> = [
  '#FF6A3D',
  '#8B5CF6',
  '#E8318A',
  '#2E6FF2',
  '#FFC53D',
  PAPER,
]

const threadAt = (place: number, step: number): string =>
  pipe(
    Array.get(flowerThreads, (place + step) % flowerThreads.length),
    Option.getOrElse(() => PAPER),
  )

const mirrored = (rows: ReadonlyArray<string>): ReadonlyArray<string> =>
  Array.map(rows, (row) => row.split('').reverse().join(''))

export const flowerFor = (place: number): Carpet => {
  const shape = pipe(
    Array.get(flowerShapes, place % flowerShapes.length),
    Option.getOrElse(() => sunflower),
  )
  return {
    rows: place % 2 === 0 ? shape : mirrored(shape),
    threads: {
      '.': NAVY,
      g: GREEN,
      a: threadAt(place, 0),
      b: threadAt(place, 1),
      c: threadAt(place, 2),
    },
  }
}

export type MarkGround = 'paper' | 'dark'

const MARK_WIDTH = 112
const MARK_HEIGHT = 48

export const loomMark = (ground: MarkGround, scale: number): Html =>
  ih.img([
    ih.Class('loom-mark'),
    ih.Src(ground === 'dark' ? '/mark-dark.svg' : '/mark.svg'),
    ih.Alt(''),
    ih.Width(String(Math.round(MARK_WIDTH * scale))),
    ih.Height(String(Math.round(MARK_HEIGHT * scale))),
  ])

import logos from './logos.json'

const strokeIcon = (size: string, paths: ReadonlyArray<Html>): Html =>
  ih.svg(
    [
      ih.Width(size),
      ih.Height(size),
      ih.ViewBox('0 0 24 24'),
      ih.Fill('none'),
      ih.Stroke('currentColor'),
      ih.StrokeWidth('2'),
      ih.StrokeLinecap('round'),
      ih.StrokeLinejoin('round'),
    ],
    paths,
  )

const strokePath = (d: string): Html => ih.path([ih.D(d)], [])

export const copyIcon = (): Html =>
  strokeIcon('13', [
    ih.rect([ih.X('9'), ih.Y('9'), ih.Width('11'), ih.Height('11'), ih.Rx('2')], []),
    strokePath('M5 15V5a2 2 0 0 1 2-2h10'),
  ])

export const bookIcon = (): Html =>
  ih.svg(
    [
      ih.Class('arrow'),
      ih.Width('14'),
      ih.Height('14'),
      ih.ViewBox('0 0 24 24'),
      ih.Fill('none'),
      ih.Stroke('currentColor'),
      ih.StrokeWidth('2'),
      ih.StrokeLinecap('round'),
      ih.StrokeLinejoin('round'),
      ih.AriaHidden(true),
    ],
    [
      strokePath('M12 7v14'),
      strokePath(
        'M3 18a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z',
      ),
    ],
  )

export const externalIcon = (): Html =>
  ih.svg(
    [
      ih.Width('13'),
      ih.Height('13'),
      ih.ViewBox('0 0 24 24'),
      ih.Fill('none'),
      ih.Stroke('currentColor'),
      ih.StrokeWidth('2'),
      ih.StrokeLinecap('round'),
      ih.StrokeLinejoin('round'),
      ih.AriaHidden(true),
    ],
    [
      strokePath('M15 3h6v6'),
      strokePath('M10 14 21 3'),
      strokePath('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6'),
    ],
  )

export const arrowIcon = (): Html =>
  ih.svg(
    [
      ih.Class('arrow'),
      ih.Width('14'),
      ih.Height('14'),
      ih.ViewBox('0 0 14 14'),
      ih.Fill('none'),
      ih.AriaHidden(true),
    ],
    [
      ih.path(
        [
          ih.D('M3 7h8M7 3l4 4-4 4'),
          ih.Stroke('currentColor'),
          ih.StrokeWidth('1.6'),
          ih.StrokeLinecap('round'),
          ih.StrokeLinejoin('round'),
        ],
        [],
      ),
    ],
  )

export const checkIcon = (): Html => strokeIcon('13', [strokePath('M20 6 9 17l-5-5')])

export const burgerIcon = (): Html =>
  strokeIcon('16', [
    ih.line([ih.X1('3'), ih.Y1('6'), ih.X2('21'), ih.Y2('6')], []),
    ih.line([ih.X1('3'), ih.Y1('12'), ih.X2('21'), ih.Y2('12')], []),
    ih.line([ih.X1('3'), ih.Y1('18'), ih.X2('21'), ih.Y2('18')], []),
  ])

const solidIcon = (width: string, height: string, box: string, parts: ReadonlyArray<Html>): Html =>
  ih.svg(
    [
      ih.Width(width),
      ih.Height(height),
      ih.ViewBox(box),
      ih.Fill('currentColor'),
      ih.AriaHidden(true),
    ],
    parts,
  )

export const backIcon = (): Html =>
  solidIcon('14', '12', '0 0 14 12', [
    ih.path(
      [ih.D('M13 1.1v9.8a.6.6 0 0 1-.93.5l-7.2-4.9a.6.6 0 0 1 0-1L12.07.6a.6.6 0 0 1 .93.5z')],
      [],
    ),
    ih.rect([ih.X('0.8'), ih.Y('0.6'), ih.Width('2.2'), ih.Height('10.8'), ih.Rx('1.1')], []),
  ])

export const skipIcon = (): Html =>
  solidIcon('14', '12', '0 0 14 12', [
    ih.path(
      [ih.D('M1 1.1v9.8a.6.6 0 0 0 .93.5l7.2-4.9a.6.6 0 0 0 0-1L1.93.6A.6.6 0 0 0 1 1.1z')],
      [],
    ),
    ih.rect([ih.X('11'), ih.Y('0.6'), ih.Width('2.2'), ih.Height('10.8'), ih.Rx('1.1')], []),
  ])

export const playTriangle = (): Html =>
  solidIcon('13', '15', '0 0 13 15', [
    ih.path(
      [ih.D('M1 1.1v12.8a.7.7 0 0 0 1.08.59l9.6-6.4a.7.7 0 0 0 0-1.17L2.08.52A.7.7 0 0 0 1 1.1z')],
      [],
    ),
  ])

export const pauseIcon = (): Html =>
  solidIcon('12', '14', '0 0 12 14', [
    ih.rect([ih.X('1'), ih.Y('0.5'), ih.Width('3.4'), ih.Height('13'), ih.Rx('1')], []),
    ih.rect([ih.X('7.6'), ih.Y('0.5'), ih.Width('3.4'), ih.Height('13'), ih.Rx('1')], []),
  ])

export const replayIcon = (): Html =>
  ih.svg(
    [
      ih.Width('15'),
      ih.Height('15'),
      ih.ViewBox('0 0 16 16'),
      ih.Fill('none'),
      ih.Stroke('currentColor'),
      ih.StrokeWidth('1.8'),
      ih.StrokeLinecap('round'),
      ih.AriaHidden(true),
    ],
    [
      strokePath('M2.6 8a5.4 5.4 0 1 0 1.9-4.1'),
      ih.polyline([ih.Points('1.4 1.9 1.4 5.4 4.9 5.4')], []),
    ],
  )

const cornerIcon = (corners: ReadonlyArray<string>): Html =>
  ih.svg(
    [
      ih.Width('14'),
      ih.Height('14'),
      ih.ViewBox('0 0 14 14'),
      ih.Fill('none'),
      ih.Stroke('currentColor'),
      ih.StrokeWidth('1.6'),
      ih.StrokeLinecap('square'),
      ih.AriaHidden(true),
    ],
    Array.map(corners, (points) => ih.polyline([ih.Points(points)], [])),
  )

export const expandIcon = (): Html =>
  cornerIcon(['1,5 1,1 5,1', '9,1 13,1 13,5', '13,9 13,13 9,13', '5,13 1,13 1,9'])

export const collapseIcon = (): Html =>
  cornerIcon(['5,1 5,5 1,5', '13,5 9,5 9,1', '9,13 9,9 13,9', '1,9 5,9 5,13'])

export const octocatIcon = (size: string): Html =>
  ih.svg(
    [
      ih.Width(size),
      ih.Height(size),
      ih.ViewBox('0 0 16 16'),
      ih.Fill('currentColor'),
      ih.AriaHidden(true),
    ],
    [
      ih.path(
        [
          ih.D(
            'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.88.51-1.08-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
          ),
        ],
        [],
      ),
    ],
  )

const svgMark = (svg: string): Html => ih.span([ih.Class('rt-logo'), ih.InnerHTML(svg)], [])

export const bunIcon = (): Html => svgMark(logos.bun)
export const npmIcon = (): Html => svgMark(logos.npm)
export const pnpmIcon = (): Html => svgMark(logos.pnpm)
export const nodeIcon = (): Html => svgMark(logos.node)

const editorLogos: ReadonlyMap<string, string> = new Map([
  ['VS Code', logos.vscode],
  ['Zed', logos.zed],
  ['Gram', logos.gram],
  ['Helix', logos.helix],
  ['Neovim', logos.neovim],
])

export const editorMark = (heading: string): Option.Option<Html> =>
  Option.map(Option.fromNullishOr(editorLogos.get(heading)), (svg) =>
    ih.span([ih.Class('editor-logo'), ih.AriaHidden(true), ih.InnerHTML(svg)], []),
  )
