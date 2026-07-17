const PENDING_KEY = '__foldkitPending'
const STOP_KEY = '__foldkitStopCapture'

type PendingInput = {
  readonly type: string
  readonly value: string | undefined
  readonly checked: boolean | undefined
  readonly target: EventTarget & { value?: string; checked?: boolean }
}

type PrehydrationScope = {
  [PENDING_KEY]?: Array<PendingInput>
  [STOP_KEY]?: () => void
}

export const PREHYDRATION_CAPTURE_SCRIPT = `(function () {
  var pending = (window.${PENDING_KEY} = window.${PENDING_KEY} || [])
  function capture(event) {
    var target = event.target
    if (target) {
      pending.push({
        type: event.type,
        value: target.value,
        checked: target.checked,
        target: target,
      })
    }
  }
  window.addEventListener('input', capture, true)
  window.addEventListener('change', capture, true)
  window.${STOP_KEY} = function () {
    window.removeEventListener('input', capture, true)
    window.removeEventListener('change', capture, true)
  }
})();`

const replayEntry = (entry: PendingInput): void => {
  const { target } = entry
  if (entry.value !== undefined && 'value' in target) {
    target.value = entry.value
  }
  if (entry.checked !== undefined && 'checked' in target) {
    target.checked = entry.checked
  }
  target.dispatchEvent(new Event(entry.type, { bubbles: true }))
}

export const replayPreHydrationInput = (): void => {
  const scope = window as unknown as PrehydrationScope
  const pending = scope[PENDING_KEY]
  scope[STOP_KEY]?.()
  scope[PENDING_KEY] = []
  if (pending !== undefined) {
    pending.forEach(replayEntry)
  }
}
