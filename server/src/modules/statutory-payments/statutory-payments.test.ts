import { describe, expect, it } from 'vitest'
import { schemeStatus } from './statutory-payments.module.js'

describe('schemeStatus', () => {
  it('is pending with something due and no challan yet', () => {
    expect(schemeStatus(240_263_00, 0, 0)).toBe('PENDING')
  })

  it('is partially paid while the challans fall short of what is due', () => {
    expect(schemeStatus(240_263_00, 200_000_00, 1)).toBe('PARTIALLY_PAID')
  })

  it('is paid once the challans cover what is due, admin charges and all', () => {
    expect(schemeStatus(240_263_00, 240_263_00, 2)).toBe('PAID')
    expect(schemeStatus(240_263_00, 241_465_00, 1)).toBe('PAID')
  })

  it('is not due when the run owes the scheme nothing', () => {
    expect(schemeStatus(0, 0, 0)).toBe('NOT_DUE')
  })
})
