import { describe, expect, it } from 'vitest'

import { CARD_META_KEY, textResult } from '../src/tools/shared.js'

describe('card payload mirror', () => {
  it('mirrors structured content into the card _meta key', () => {
    const structured = { status: 'anonymized', replacements: 3 }
    const result = textResult('Anonymized.', structured)
    expect(result.structuredContent).toEqual(structured)
    expect(result._meta?.[CARD_META_KEY]).toEqual(structured)
  })

  it('adds no _meta when there is no structured content', () => {
    const result = textResult('Just text.')
    expect(result._meta).toBeUndefined()
    expect(result.structuredContent).toBeUndefined()
  })
})
