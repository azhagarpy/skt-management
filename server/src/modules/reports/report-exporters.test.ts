import { describe, expect, it } from 'vitest'
import { toPfEcr } from './report-exporters.js'

describe('toPfEcr', () => {
  const member = {
    ecr_member_number: '100883571796',
    ecr_pf_applicable: true,
    pf_name: 'A SENTHILKUMAR',
    total_wages: '26400.00',
    pf_covered_amount: '15000.00',
    employee_contribution: '1800.00',
    employer_eps: '1250.00',
    employer_epf: '550.00',
    ecr_ncp_days: 6,
  }

  it('writes one header-less line per member, joined by #~#', () => {
    const { buffer, included, skipped } = toPfEcr([member])
    expect(buffer.toString('utf8')).toBe(
      '100883571796#~#A SENTHILKUMAR#~#26400#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#6#~#0\r\n',
    )
    expect(included).toBe(1)
    expect(skipped).toBe(0)
  })

  it('lists a member with no wages as zeros and every day not worked', () => {
    const { buffer } = toPfEcr([
      {
        ...member,
        ecr_member_number: '101222025731',
        pf_name: 'A. SENGAMALAM',
        total_wages: '0',
        pf_covered_amount: '0',
        employee_contribution: '0',
        employer_eps: '0',
        employer_epf: '0',
        ecr_ncp_days: 31,
      },
    ])
    expect(buffer.toString('utf8')).toBe('101222025731#~#A. SENGAMALAM#~#0#~#0#~#0#~#0#~#0#~#0#~#0#~#31#~#0\r\n')
  })

  it('rounds to whole rupees and never writes a negative or fractional amount', () => {
    const { buffer } = toPfEcr([{ ...member, total_wages: '26400.6', employee_contribution: '-3', ecr_ncp_days: 2.4 }])
    const fields = buffer.toString('utf8').trim().split('#~#')
    expect(fields[2]).toBe('26401')
    expect(fields[6]).toBe('0')
    expect(fields[9]).toBe('2')
  })

  it('leaves out members without a UAN or not marked PF-applicable, and counts them', () => {
    const { buffer, included, skipped } = toPfEcr([
      member,
      { ...member, ecr_member_number: null },
      { ...member, ecr_member_number: '   ' },
      { ...member, ecr_pf_applicable: false },
    ])
    expect(included).toBe(1)
    expect(skipped).toBe(3)
    expect(buffer.toString('utf8').split('\r\n').filter(Boolean)).toHaveLength(1)
  })

  it('keeps a name that contains the separator or a line break on one clean row', () => {
    const { buffer } = toPfEcr([{ ...member, pf_name: 'RAVI#~#KUMAR\nS' }])
    const fields = buffer.toString('utf8').trim().split('#~#')
    expect(fields).toHaveLength(11)
    expect(fields[1]).toBe('RAVI KUMAR S')
  })

  it('produces an empty file when nobody qualifies', () => {
    const { buffer, included } = toPfEcr([])
    expect(buffer.length).toBe(0)
    expect(included).toBe(0)
  })
})
