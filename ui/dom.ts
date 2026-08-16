/** Tiny DOM helpers shared by the card widgets.
 *
 * Everything renders through createElement and textContent, never through
 * innerHTML, so result data can never become markup. Cards are display
 * only: they render what the tool result already carries and nothing else.
 */

import {
  CARD_EVALUATION_LABEL,
  CARD_UNLIMITED_LABEL,
  CARD_UPSELL_LINE,
} from '../src/uiCopy.js'

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className !== undefined && className.length > 0) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The card root. Clears the initial waiting state on first render. */
export function cardRoot(): HTMLElement {
  const root = document.getElementById('stript-card')
  if (root === null) throw new Error('missing card root')
  root.replaceChildren()
  return root
}

/** The Stript brand mark (the app icon), inlined for self-containment.
 * Source: landing/public/favicon.svg, keep the two in sync. */
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
  '<rect width="32" height="32" rx="7" fill="#4f46e5"/>' +
  '<rect x="8" y="5" width="16" height="22" rx="2.5" fill="#ffffff"/>' +
  '<rect x="11" y="9" width="10" height="2" rx="1" fill="#c7d2fe" opacity="0.6"/>' +
  '<rect x="11" y="13.5" width="3.5" height="2" rx="1" fill="#c7d2fe" opacity="0.6"/>' +
  '<rect x="15.5" y="13" width="5" height="3" rx="1" fill="#10b981"/>' +
  '<rect x="11" y="18" width="7.5" height="2" rx="1" fill="#c7d2fe" opacity="0.6"/>' +
  '<rect x="11" y="22.5" width="2.5" height="2" rx="1" fill="#c7d2fe" opacity="0.6"/>' +
  '<rect x="14.5" y="22" width="5.5" height="3" rx="1" fill="#10b981"/>' +
  '</svg>'

export function headline(text: string, plain = false): HTMLElement {
  const h = el('h1', plain ? 'headline plain' : 'headline', text)
  const brand = document.createElement('span')
  brand.className = 'brand'
  brand.innerHTML = LOGO_SVG
  h.append(brand)
  return h
}

export function subline(text: string): HTMLElement {
  return el('p', 'sub', text)
}

export function note(text: string, variant?: 'accent' | 'advisory'): HTMLElement {
  return el('p', variant === undefined ? 'note' : `note ${variant}`, text)
}

/** A small labeled count chip, for example "PERSON 4". */
export function chip(label: string, count?: number): HTMLElement {
  const node = el('span', 'chip')
  node.append(label)
  if (count !== undefined) {
    node.append(' ')
    node.append(el('b', undefined, String(count)))
  }
  return node
}

export function chipRow(chips: HTMLElement[]): HTMLElement {
  const row = el('div', 'chips')
  for (const c of chips) row.append(c)
  return row
}

/** The 5-dot Free Evaluation meter. Filled dots are the documents left.
 * Pro or -1 renders the unlimited label instead of dots. Appends the
 * honest upsell line at 0 remaining. */
export function evaluationMeter(remaining: number): HTMLElement {
  const wrap = el('div')
  const meter = el('div', 'meter')
  meter.append(el('span', undefined, CARD_EVALUATION_LABEL))
  if (remaining === -1 || remaining > 5) {
    meter.append(el('span', undefined, CARD_UNLIMITED_LABEL))
    wrap.append(meter)
    return wrap
  }
  const clamped = Math.max(0, Math.min(5, remaining))
  const dots = el('span', 'dots')
  for (let i = 0; i < 5; i += 1) {
    dots.append(el('span', i < clamped ? 'dot filled' : 'dot'))
  }
  meter.append(dots)
  meter.append(el('span', undefined, `${clamped} of 5 left`))
  wrap.append(meter)
  if (clamped === 0) wrap.append(note(CARD_UPSELL_LINE))
  return wrap
}

/** Collapsed notes block. Returns null when there is nothing to show. */
export function notesDetails(notes: string[]): HTMLElement | null {
  if (notes.length === 0) return null
  const details = el('details')
  const label = notes.length === 1 ? '1 note' : `${notes.length} notes`
  details.append(el('summary', undefined, label))
  const list = el('ul')
  for (const message of notes) list.append(el('li', undefined, message))
  details.append(list)
  return details
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
