import { Window } from 'happy-dom'

const scope = globalThis as Record<string, unknown>
const browser = new Window()
scope.window = browser
scope.document = browser.document
scope.Node = browser.Node
scope.Event = browser.Event
scope.CustomEvent = browser.CustomEvent
