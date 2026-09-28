import { describe, expect, it } from 'vitest'
import { idListParam } from './query-params.js'

const A = '6f1c1f0e-8a5e-4c55-9d6c-3e2b9b0a7c11'
const B = '494b6af4-0a07-4144-a5ad-b85a02c577ad'

describe('idListParam', () => {
  it('reads a single id, a comma-separated list and a repeated parameter the same way', () => {
    expect(idListParam.parse(A)).toEqual([A])
    expect(idListParam.parse(`${A},${B}`)).toEqual([A, B])
    expect(idListParam.parse(` ${A} , ${B} `)).toEqual([A, B])
    expect(idListParam.parse([A, B])).toEqual([A, B])
  })

  it('treats an empty value as no filter', () => {
    expect(idListParam.parse('')).toEqual([])
    expect(idListParam.optional().parse(undefined)).toBeUndefined()
  })

  it('refuses anything that is not an id', () => {
    expect(idListParam.safeParse(`${A},not-an-id`).success).toBe(false)
  })
})
