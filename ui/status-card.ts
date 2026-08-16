/** The status card, attached to stript_status. */

import { parseStatusText } from '../src/cardText.js'
import {
  CARD_STATUS_INTEGRATIONS_LABEL,
  CARD_STATUS_INTEGRATIONS_OFF,
  CARD_STATUS_INTEGRATIONS_ON,
  CARD_STATUS_MODELS_LABEL,
  CARD_STATUS_MODELS_LOADING,
  CARD_STATUS_MODELS_READY,
  CARD_STATUS_RUNNING_HEADLINE,
  CARD_STATUS_TIER_FREE,
  CARD_STATUS_TIER_LABEL,
  CARD_STATUS_TIER_PRO,
  CARD_STATUS_UNAVAILABLE_HEADLINE,
} from '../src/uiCopy.js'
import { startCard } from './bootstrap.js'
import { asNumber, asString, cardRoot, el, evaluationMeter, headline, note } from './dom.js'

function row(rows: HTMLElement, label: string, value: string): void {
  rows.append(el('dt', undefined, label))
  rows.append(el('dd', undefined, value))
}

function render(s: Record<string, unknown>): void {
  const root = cardRoot()

  if (s.app_running !== true) {
    root.append(headline(CARD_STATUS_UNAVAILABLE_HEADLINE, true))
    const guidance = asString(s.guidance)
    if (guidance !== undefined) root.append(note(guidance))
    return
  }

  const version = asString(s.app_version)
  root.append(
    headline(
      version === undefined
        ? CARD_STATUS_RUNNING_HEADLINE
        : `${CARD_STATUS_RUNNING_HEADLINE} (${version})`,
    ),
  )

  const rows = el('dl', 'rows')
  row(
    rows,
    CARD_STATUS_INTEGRATIONS_LABEL,
    s.integration_enabled === true ? CARD_STATUS_INTEGRATIONS_ON : CARD_STATUS_INTEGRATIONS_OFF,
  )
  const tier = asString(s.tier)
  if (tier !== undefined) {
    row(rows, CARD_STATUS_TIER_LABEL, tier === 'pro' ? CARD_STATUS_TIER_PRO : CARD_STATUS_TIER_FREE)
  }
  if (typeof s.models_ready === 'boolean') {
    row(
      rows,
      CARD_STATUS_MODELS_LABEL,
      s.models_ready ? CARD_STATUS_MODELS_READY : CARD_STATUS_MODELS_LOADING,
    )
  }
  root.append(rows)

  const remaining = asNumber(s.evaluation_remaining)
  if (remaining !== undefined) root.append(evaluationMeter(remaining))
}

startCard('stript-status-card', render, parseStatusText)
