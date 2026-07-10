type Rect = { x: number; y: number; width: number; height: number }

type Entry = {
  seq: number
  kind: 'annotation' | 'message'
  text: string
  label?: string
  addressed: boolean
}

const post = (path: string, body: unknown): Promise<unknown> =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())

const getFeed = (): Promise<ReadonlyArray<Entry>> =>
  fetch('/__annotate/feed').then((r) => r.json())

const labelFor = (el: Element): string =>
  `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`

const rectFor = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

const selectorFor = (el: Element): string => {
  if (el.id) return `#${el.id}`
  const parts: Array<string> = []
  let node: Element | null = el
  while (node && node !== document.body && parts.length < 5) {
    const tag = node.tagName.toLowerCase()
    const parent: Element | null = node.parentElement
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const twins = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
    const nth = twins.indexOf(node) + 1
    parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${nth})` : tag)
    node = parent
  }
  return parts.join(' > ')
}

const capture = (el: Element) => ({
  selector: selectorFor(el),
  label: labelFor(el),
  rect: rectFor(el),
})

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

const trashIcon =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>'

const controlsRow = (entry: Entry): string =>
  '<span class="controls">' +
  `<button data-action="edit" data-seq="${entry.seq}" title="Edit">&#9998;</button>` +
  (entry.addressed
    ? ''
    : `<button data-action="resolve" data-seq="${entry.seq}" title="Resolve">&#10003;</button>`) +
  `<button data-action="discard" data-seq="${entry.seq}" title="Discard">${trashIcon}</button>` +
  '</span>'

const entryLine = (entry: Entry, editing: number | null): HTMLElement => {
  const line = document.createElement('div')
  if (entry.seq === editing) {
    line.className = 'entry editing'
    line.innerHTML =
      `<textarea class="edit-field" data-seq="${entry.seq}">${escapeHtml(entry.text)}</textarea>` +
      '<span class="controls">' +
      `<button data-action="save" data-seq="${entry.seq}" class="send-btn">Save</button>` +
      `<button data-action="cancel" data-seq="${entry.seq}">Cancel</button>` +
      '</span>'
    return line
  }
  line.className = entry.addressed ? 'entry addressed' : 'entry'
  const glyph = entry.kind === 'annotation' ? '◎' : '›'
  const label = entry.label ? ` <span class="label">${escapeHtml(entry.label)}</span>` : ''
  line.innerHTML =
    `<div class="entry-text">` +
    `<span class="k-${entry.kind}">${glyph}</span> ` +
    `${escapeHtml(entry.text)}${label}</div>` +
    controlsRow(entry)
  return line
}

const css = `
:host { all: initial }
.launcher { position: fixed; right: 16px; bottom: 16px; pointer-events: auto;
  font: 12px ui-monospace, monospace; background: #8FE0B6; color: #0F1014;
  border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer }
.panel { position: fixed; top: 0; right: 0; width: 340px; height: 100vh; pointer-events: auto;
  background: #15171D; color: #E6E6EA; font: 13px ui-monospace, monospace;
  border-left: 1px solid #ffffff1f; display: none; flex-direction: column }
.panel.open { display: flex }
.resize-handle { position: absolute; left: 0; top: 0; bottom: 0; width: 5px; cursor: col-resize; z-index: 1 }
.resize-handle:hover { background: #8FE0B6 }
header { display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-bottom: 1px solid #ffffff12; color: #7A7E8C }
header .title { color: #E6E6EA }
.hide-btn { display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; background: none; border: 1px solid #ffffff1f;
  border-radius: 5px; color: #B6B8C2; cursor: pointer }
.hide-btn:hover { color: #E6E6EA; border-color: #ffffff33 }
.list { flex: 1; overflow: auto; padding: 8px 12px }
.entry { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0;
  border-bottom: 1px solid #ffffff12; line-height: 1.5 }
.entry.addressed { opacity: .5 }
.entry.editing { flex-direction: column; align-items: stretch; gap: 4px }
.entry-text { flex: 1; min-width: 0; word-break: break-word }
.seq { color: #7A7E8C }
.k-annotation { color: #8FE0B6 } .k-message { color: #6CC7E0 } .label { color: #B59BF1 }
.controls { display: inline-flex; gap: 2px; flex-shrink: 0; opacity: 0; transition: opacity .12s }
.entry:hover .controls, .entry.editing .controls { opacity: 1 }
.entry.editing .controls { justify-content: flex-end }
.controls button { background: none; border: none; color: #7A7E8C; cursor: pointer;
  font: 12px ui-monospace, monospace; padding: 2px 6px; border-radius: 3px }
.controls button:hover { color: #E6E6EA; background: #ffffff12 }
.controls button.send-btn { background: #8FE0B6; color: #0F1014 }
.composer { padding: 10px 12px; border-top: 1px solid #ffffff12 }
textarea { width: 100%; box-sizing: border-box; background: #0F1014; color: #E6E6EA;
  border: 1px solid #ffffff1f; border-radius: 4px; padding: 6px; resize: vertical;
  font: 13px ui-monospace, monospace }
.row { display: flex; gap: 6px; margin-top: 6px }
.row button { flex: 1; font: 12px ui-monospace, monospace; background: #1B1E26; color: #B6B8C2;
  border: 1px solid #ffffff1f; border-radius: 4px; padding: 6px; cursor: pointer }
.row button.on { background: #8FE0B620; color: #8FE0B6; border-color: #8FE0B6 }
.row button.send-btn { background: #8FE0B6; color: #0F1014; border-color: #8FE0B6 }
.row button.send-btn:disabled { opacity: .4; cursor: default }
.hl { position: fixed; pointer-events: none; border: 2px solid #8FE0B6;
  background: #8FE0B615; border-radius: 2px; display: none }
.popover { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
  width: 360px; max-width: 86vw; pointer-events: auto; background: #15171D;
  border: 1px solid #8FE0B6; border-radius: 8px; padding: 12px;
  box-shadow: 0 12px 40px rgba(0,0,0,.5); font: 13px ui-monospace, monospace; color: #E6E6EA }
.popover[hidden] { display: none }
.popover-label { color: #8FE0B6; font-size: 11.5px; margin-bottom: 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
`

export const start = (): void => {
  const host = document.createElement('div')
  host.id = 'loom-annotate-host'
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  const root = host.attachShadow({ mode: 'open' })
  document.body.appendChild(host)
  const sidebarIcon =
    '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="12" height="10" rx="1.5"/><line x1="9.5" y1="2.5" x2="9.5" y2="12.5"/></svg>'
  root.innerHTML = `
    <style>${css}</style>
    <div class="hl" id="hl"></div>
    <button class="launcher" id="launcher">&#9998; Annotate</button>
    <aside class="panel" id="panel">
      <div class="resize-handle" id="resize"></div>
      <header>
        <span class="title">Loom &middot; Annotations</span>
        <button class="hide-btn" id="hide" title="Hide">${sidebarIcon}</button>
      </header>
      <div class="list" id="list"></div>
      <div class="composer">
        <textarea id="msg" rows="2" placeholder="Write a message — return to send"></textarea>
        <div class="row">
          <button id="pick">&#9678; Pick element</button>
          <button id="send" class="send-btn" disabled>Send</button>
        </div>
      </div>
    </aside>
    <div class="popover" id="popover" hidden>
      <div class="popover-label" id="pop-label"></div>
      <textarea id="note" rows="2" placeholder="Note on this element — return to add"></textarea>
      <div class="row">
        <button id="add" class="send-btn" disabled>Add</button>
      </div>
    </div>`

  const pick = <T extends Element>(sel: string): T => root.querySelector(sel) as unknown as T
  const panel = pick<HTMLElement>('#panel')
  const list = pick<HTMLElement>('#list')
  const hl = pick<HTMLElement>('#hl')
  const popover = pick<HTMLElement>('#popover')
  const popLabel = pick('#pop-label')
  const msg = pick<HTMLTextAreaElement>('#msg')
  const note = pick<HTMLTextAreaElement>('#note')
  const modeButton = pick('#pick')
  const sendButton = pick<HTMLButtonElement>('#send')
  const addButton = pick<HTMLButtonElement>('#add')
  const resizeHandle = pick<HTMLElement>('#resize')

  let picking = false
  let pending: ReturnType<typeof capture> | null = null
  let editing: number | null = null
  let dragging = false

  const autoGrow = (field: HTMLTextAreaElement): void => {
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`
  }

  const refresh = (): void => {
    void getFeed().then((entries) => {
      list.replaceChildren(...entries.map((entry) => entryLine(entry, editing)))
      const field = editing === null ? null : list.querySelector<HTMLTextAreaElement>('.edit-field')
      if (field) {
        field.focus()
        field.setSelectionRange(field.value.length, field.value.length)
        autoGrow(field)
      }
    })
  }

  const act = (path: string, body: unknown): void => {
    void post(path, body).then(() => {
      editing = null
      refresh()
    })
  }
  const openPanel = (): void => panel.classList.add('open')
  const closePanel = (): void => panel.classList.remove('open')

  const setPicking = (on: boolean): void => {
    picking = on
    modeButton.classList.toggle('on', on)
    document.body.style.cursor = on ? 'crosshair' : ''
    if (on) closePanel()
    else hl.style.display = 'none'
  }

  const closePopover = (): void => {
    popover.hidden = true
    pending = null
    note.value = ''
    addButton.disabled = true
  }

  const route = (): string => location.pathname

  const sendMessage = (): void => {
    void post('/__annotate/capture', { kind: 'message', route: route(), text: msg.value.trim() }).then(
      () => {
        msg.value = ''
        sendButton.disabled = true
        localStorage.removeItem('loom-annotate-draft')
        autoGrow(msg)
        refresh()
      },
    )
  }

  const addAnnotation = (): void => {
    if (!pending) return
    void post('/__annotate/capture', {
      kind: 'annotation',
      route: route(),
      text: note.value.trim(),
      ...pending,
    }).then(() => {
      closePopover()
      openPanel()
      refresh()
    })
  }

  const wire = (
    field: HTMLTextAreaElement,
    button: HTMLButtonElement,
    action: () => void,
  ): void => {
    field.addEventListener('input', () => {
      button.disabled = field.value.trim() === ''
    })
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (field.value.trim() !== '') action()
      }
    })
    button.addEventListener('click', () => {
      if (field.value.trim() !== '') action()
    })
  }

  wire(msg, sendButton, sendMessage)
  wire(note, addButton, addAnnotation)

  msg.value = localStorage.getItem('loom-annotate-draft') ?? ''
  sendButton.disabled = msg.value.trim() === ''
  autoGrow(msg)
  msg.addEventListener('input', () => {
    localStorage.setItem('loom-annotate-draft', msg.value)
    autoGrow(msg)
  })
  note.addEventListener('input', () => autoGrow(note))
  list.addEventListener('input', (e) => {
    const field = e.target as HTMLElement
    if (field.classList.contains('edit-field')) autoGrow(field as HTMLTextAreaElement)
  })

  resizeHandle.addEventListener('mousedown', (e) => {
    dragging = true
    e.preventDefault()
  })
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return
    panel.style.width = `${Math.min(Math.max(window.innerWidth - e.clientX, 280), 680)}px`
  })
  window.addEventListener('mouseup', () => {
    dragging = false
  })

  pick('#launcher').addEventListener('click', () => {
    openPanel()
    refresh()
  })
  pick('#hide').addEventListener('click', closePanel)
  modeButton.addEventListener('click', () => setPicking(!picking))

  list.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button[data-action]')
    if (!button) return
    const action = button.getAttribute('data-action') ?? ''
    const seq = Number(button.getAttribute('data-seq'))
    switch (action) {
      case 'edit':
        editing = seq
        refresh()
        break
      case 'cancel':
        editing = null
        refresh()
        break
      case 'resolve':
        act('/__annotate/resolve', { seq })
        break
      case 'discard':
        act('/__annotate/discard', { seq })
        break
      case 'save': {
        const field = list.querySelector<HTMLTextAreaElement>('.edit-field')
        if (field) act('/__annotate/update', { seq, text: field.value })
        break
      }
    }
  })

  list.addEventListener('keydown', (e) => {
    const field = e.target as HTMLElement
    if (!field.classList.contains('edit-field')) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const seq = Number(field.getAttribute('data-seq'))
      act('/__annotate/update', { seq, text: (field as HTMLTextAreaElement).value })
    }
  })

  document.addEventListener(
    'mousemove',
    (e) => {
      const el = e.target as Element
      if (!picking || el === host) return
      const r = el.getBoundingClientRect()
      hl.style.display = 'block'
      hl.style.left = `${r.x}px`
      hl.style.top = `${r.y}px`
      hl.style.width = `${r.width}px`
      hl.style.height = `${r.height}px`
    },
    true,
  )

  document.addEventListener(
    'click',
    (e) => {
      const el = e.target as Element
      if (!picking || el === host) return
      e.preventDefault()
      e.stopPropagation()
      pending = capture(el)
      setPicking(false)
      popLabel.textContent = `◎ ${pending.label}`
      popover.hidden = false
      addButton.disabled = true
      note.value = ''
      note.focus()
    },
    true,
  )

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!popover.hidden) {
      closePopover()
      openPanel()
    } else if (picking) {
      setPicking(false)
      openPanel()
    }
  })

  refresh()
}

if (!document.getElementById('loom-annotate-host')) start()
