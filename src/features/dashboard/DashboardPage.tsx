import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  AlertTriangle,
  CalendarClock,
  CircleDollarSign,
  ClipboardCheck,
  FileWarning,
  ShieldCheck,
  UserMinus,
  UsersRound,
} from 'lucide-react'
import { get } from '../../lib/api'
import { formatCurrency, formatCurrencyCompact, formatDays } from '../../lib/format'
import { useAuth } from '../../app/providers/AuthProvider'
import { brandRamp, useBranding } from '../../app/providers/BrandingProvider'
import {
  Badge,
  Button,
  Card,
  ErrorState,
  PageHeader,
  ProgressBar,
  Spinner,
  StatTile,
  StatusBadge,
} from '../../components/ui'
import type {
  DashboardData,
  EmployeeDashboard,
  SuperAdminDashboard,
  SupervisorDashboard,
} from '../../types/api'

/**
 * One route, three dashboards.
 *
 * The server decides which shape to return based on the caller's permissions
 * (plan sections 42-44), so this page renders whichever it receives rather than
 * branching on a client-held role.
 */
export default function DashboardPage() {
  const { user } = useAuth()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => get<DashboardData>('/dashboard'),
  })

  if (isLoading) return <Spinner label="Loading dashboard" />
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />
  if (!data) return null

  const greeting = `Welcome back, ${user?.fullName?.split(' ')[0] ?? 'there'}`

  return (
    <div className="page">
      <PageHeader title={greeting} description="Here is where things stand today." />
      {data.role === 'SUPER_ADMIN' ? (
        <AdminDashboard data={data} />
      ) : data.role === 'SUPERVISOR' ? (
        <TeamDashboard data={data} />
      ) : (
        <SelfDashboard data={data} />
      )}
    </div>
  )
}

/**
 * Chart colours.
 *
 * The first series takes the organization's own accent colour so the charts
 * follow a rebrand; the rest are fixed categoricals chosen to stay
 * distinguishable against any brand hue.
 */
const CATEGORICAL_COLOURS = ['#c0463b', '#c98a26', '#3a72c4', '#7a5cc0', '#8a9a95']

function useChartColours(): { primary: string; series: string[] } {
  const { themeColor } = useBranding()
  const primary = brandRamp(themeColor)?.['--brand-500'] ?? themeColor
  return { primary, series: [primary, ...CATEGORICAL_COLOURS] }
}

function attendanceChartData(counts: {
  present: number
  absent: number
  onLeave: number
  halfDay: number
  holiday: number
  weeklyOff: number
}) {
  return [
    { name: 'Present', value: counts.present },
    { name: 'Absent', value: counts.absent },
    { name: 'On leave', value: counts.onLeave },
    { name: 'Half day', value: counts.halfDay },
    { name: 'Holiday', value: counts.holiday },
    { name: 'Weekly off', value: counts.weeklyOff },
  ].filter((entry) => entry.value > 0)
}

// ---------------------------------------------------------------------------
// Super Admin
// ---------------------------------------------------------------------------

function AdminDashboard({ data }: { data: SuperAdminDashboard }) {
  const attendance = attendanceChartData(data.attendanceToday)
  const chartColours = useChartColours()
  const payroll = data.currentPayroll

  const paymentBars = payroll
    ? [
        { name: 'Paid', amount: payroll.byPaymentStatus.PAID?.amount ?? 0 },
        { name: 'Partial', amount: payroll.byPaymentStatus.PARTIALLY_PAID?.amount ?? 0 },
        { name: 'Pending', amount: payroll.byPaymentStatus.PENDING?.amount ?? 0 },
      ]
    : []

  return (
    <>
      <div className="grid grid-4">
        <StatTile
          label="Employees"
          value={data.headcount.totalEmployees}
          sublabel={`${data.headcount.activeEmployees} active`}
          icon={<UsersRound size={18} />}
          tone="info"
        />
        <StatTile
          label="Supervisors"
          value={data.headcount.supervisors}
          sublabel={data.headcount.onNotice > 0 ? `${data.headcount.onNotice} on notice` : 'Team leads'}
          icon={<ShieldCheck size={18} />}
          tone="accent"
        />
        <StatTile
          label="Present today"
          value={data.attendanceToday.present}
          sublabel={`${data.attendanceToday.absent} absent · ${data.attendanceToday.onLeave} on leave`}
          icon={<ClipboardCheck size={18} />}
          tone="success"
        />
        <StatTile
          label="Pending leave"
          value={data.pendingLeaveRequests}
          sublabel="Awaiting a decision"
          icon={<CalendarClock size={18} />}
          tone={data.pendingLeaveRequests > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <div className="grid grid-2">
        <Card title="Attendance today" description="Across the whole organization.">
          {attendance.length === 0 ? (
            <p className="muted">No attendance has been marked for today yet.</p>
          ) : (
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={attendance} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                    {attendance.map((entry, index) => (
                      <Cell key={entry.name} fill={chartColours.series[index % chartColours.series.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend verticalAlign="bottom" height={36} iconSize={9} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card
          title={payroll ? `${payroll.monthLabel} payroll` : 'Current payroll'}
          description={payroll ? undefined : 'No payroll run has been created for this month.'}
          actions={
            payroll ? (
              <Link to={`/payroll/runs/${payroll.id}`}>
                <Button variant="secondary" size="sm">
                  Open run
                </Button>
              </Link>
            ) : (
              <Link to="/payroll">
                <Button size="sm">Create run</Button>
              </Link>
            )
          }
        >
          {payroll ? (
            <div className="stack">
              <div className="row" style={{ gap: '1.5rem' }}>
                <div>
                  <p className="stat-label">Gross</p>
                  <p className="stat-value">{formatCurrencyCompact(payroll.grossSalary)}</p>
                </div>
                <div>
                  <p className="stat-label">Net</p>
                  <p className="stat-value">{formatCurrencyCompact(payroll.netSalary)}</p>
                </div>
                <div>
                  <p className="stat-label">Status</p>
                  <p style={{ marginTop: '0.35rem' }}>
                    <StatusBadge status={payroll.status} />
                  </p>
                </div>
              </div>

              <div style={{ width: '100%', height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={paymentBars} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis
                      tickFormatter={(value: number) => formatCurrencyCompact(value)}
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      width={62}
                    />
                    <Tooltip formatter={(value: number) => formatCurrency(value)} />
                    <Bar dataKey="amount" fill={chartColours.primary} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Needs attention">
          <div className="stack">
            <AttentionRow
              icon={<FileWarning size={16} />}
              label="Documents awaiting verification"
              value={data.documents.pendingVerification}
              to="/documents"
            />
            <AttentionRow
              icon={<AlertTriangle size={16} />}
              label="Employees with incomplete profiles"
              value={data.documents.employeesWithIncompleteProfiles}
              to="/employees"
            />
            <AttentionRow
              icon={<CalendarClock size={16} />}
              label="Leave requests pending approval"
              value={data.pendingLeaveRequests}
              to="/leave"
            />
            <AttentionRow
              icon={<UserMinus size={16} />}
              label="Employees on notice"
              value={data.headcount.onNotice}
              to="/employees"
            />
          </div>
        </Card>

        <Card title="Recent payroll runs">
          {data.recentPayrollRuns.length === 0 ? (
            <p className="muted">No payroll has been run yet.</p>
          ) : (
            <div className="stack" style={{ gap: '0.5rem' }}>
              {data.recentPayrollRuns.map((run) => (
                <Link key={run.id} to={`/payroll/runs/${run.id}`} className="breakdown-row" style={{ color: 'inherit' }}>
                  <span>
                    {run.monthLabel} <StatusBadge status={run.status} />
                  </span>
                  <span className="numeric">
                    {formatCurrency(run.netSalary)}
                    {run.pending > 0 ? <span className="subtle"> · {formatCurrency(run.pending)} pending</span> : null}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

function AttentionRow({
  icon,
  label,
  value,
  to,
}: {
  icon: React.ReactNode
  label: string
  value: number
  to: string
}) {
  return (
    <Link to={to} className="breakdown-row" style={{ color: 'inherit' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span className="muted">{icon}</span>
        {label}
      </span>
      <Badge tone={value > 0 ? 'warning' : 'success'}>{value}</Badge>
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

function TeamDashboard({ data }: { data: SupervisorDashboard }) {
  return (
    <>
      <div className="grid grid-4">
        <StatTile label="My team" value={data.team.activeEmployees} sublabel="Active employees" icon={<UsersRound size={18} />} tone="info" />
        <StatTile label="Present today" value={data.attendanceToday.present} icon={<ClipboardCheck size={18} />} tone="success" />
        <StatTile label="Absent today" value={data.attendanceToday.absent} icon={<UserMinus size={18} />} tone={data.attendanceToday.absent > 0 ? 'danger' : 'neutral'} />
        <StatTile
          label="Pending leave"
          value={data.pendingLeaveRequests}
          sublabel="Waiting on you"
          icon={<CalendarClock size={18} />}
          tone={data.pendingLeaveRequests > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <Card
        title="My team today"
        description={`Attendance for ${data.date}`}
        actions={
          <Link to="/attendance">
            <Button size="sm">Mark attendance</Button>
          </Link>
        }
        padded={false}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Section</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.teamMembers.map((member) => (
              <tr key={member.id}>
                <td data-label="Employee">
                  <Link to={`/employees/${member.id}`}>{member.name}</Link>
                  <span className="subtle"> · {member.employeeCode}</span>
                </td>
                <td data-label="Section">{member.designationName ?? '—'}</td>
                <td data-label="Status">
                  {member.todayStatus ? <StatusBadge status={member.todayStatus} /> : <span className="subtle">Not marked</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}

// ---------------------------------------------------------------------------
// Employee
// ---------------------------------------------------------------------------

function SelfDashboard({ data }: { data: EmployeeDashboard }) {
  const completion = data.profileCompletion

  return (
    <>
      <div className="grid grid-4">
        <StatTile
          label="Today"
          value={data.todayStatus ? <StatusBadge status={data.todayStatus} /> : <span className="subtle">Not marked</span>}
          icon={<ClipboardCheck size={18} />}
          tone="info"
        />
        <StatTile
          label={`${data.currentMonth.monthLabel} present`}
          value={data.currentMonth.present}
          sublabel={`${data.currentMonth.absent} absent · ${data.currentMonth.onLeave} leave`}
          icon={<CalendarClock size={18} />}
          tone="success"
        />
        <StatTile
          label="Latest net salary"
          value={data.latestPayroll ? formatCurrency(data.latestPayroll.netSalary) : '—'}
          sublabel={data.latestPayroll ? data.latestPayroll.monthLabel : 'No payroll published yet'}
          icon={<CircleDollarSign size={18} />}
          tone="accent"
        />
        <StatTile
          label="Profile completion"
          value={`${completion.completionPercent}%`}
          sublabel={`${completion.completedSections} of ${completion.totalSections} sections`}
          icon={<ShieldCheck size={18} />}
          tone={completion.isComplete ? 'success' : 'warning'}
        />
      </div>

      {!completion.isComplete ? (
        <Card title="Complete your profile" description="Payroll needs these details before it can pay you correctly.">
          <div className="stack">
            <ProgressBar value={completion.completionPercent} tone={completion.isComplete ? 'success' : 'warning'} />
            <div className="stack" style={{ gap: '0.35rem' }}>
              {completion.sections.map((section) => (
                <div key={section.section} className="breakdown-row">
                  <span>{section.label}</span>
                  <span>
                    {section.complete ? (
                      <StatusBadge status={section.verificationStatus ?? 'VERIFIED'} />
                    ) : (
                      <Badge tone="warning">Pending</Badge>
                    )}
                  </span>
                </div>
              ))}
            </div>
            <Link to="/my-documents">
              <Button size="sm">Add missing details</Button>
            </Link>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-2">
        <Card
          title="Leave balance"
          actions={
            <Link to="/my-leave">
              <Button variant="secondary" size="sm">
                Apply for leave
              </Button>
            </Link>
          }
        >
          {data.leaveBalances.length === 0 ? (
            <p className="muted">No leave balances have been set up yet.</p>
          ) : (
            <div className="stack" style={{ gap: '0.4rem' }}>
              {data.leaveBalances.map((balance) => (
                <div key={balance.leaveTypeName} className="breakdown-row">
                  <span>{balance.leaveTypeName}</span>
                  <span className="numeric">
                    <strong>{formatDays(balance.available)}</strong>
                    <span className="subtle"> of {formatDays(balance.entitled)} available</span>
                  </span>
                </div>
              ))}
              {data.pendingLeaveRequests > 0 ? (
                <p className="subtle">
                  You have {data.pendingLeaveRequests} request(s) awaiting approval.
                </p>
              ) : null}
            </div>
          )}
        </Card>

        <Card
          title="Salary and payslips"
          actions={
            <Link to="/my-payslips">
              <Button variant="secondary" size="sm">
                All payslips
              </Button>
            </Link>
          }
        >
          {data.latestPayroll ? (
            <div className="stack">
              <div className="breakdown-row">
                <span>{data.latestPayroll.monthLabel} net salary</span>
                <span className="numeric">{formatCurrency(data.latestPayroll.netSalary)}</span>
              </div>
              <div className="breakdown-row">
                <span>Paid</span>
                <span className="numeric">{formatCurrency(data.latestPayroll.paidAmount)}</span>
              </div>
              <div className="breakdown-row">
                <span>Pending</span>
                <span className="numeric">{formatCurrency(data.latestPayroll.pendingAmount)}</span>
              </div>
              <div className="breakdown-row">
                <span>Payment status</span>
                <StatusBadge status={data.latestPayroll.paymentStatus} />
              </div>
              <Link to={`/payroll/items/${data.latestPayroll.payrollItemId}`}>
                <Button variant="secondary" size="sm">
                  View breakdown
                </Button>
              </Link>
            </div>
          ) : (
            <p className="muted">Your payroll will appear here once it has been approved.</p>
          )}
        </Card>
      </div>
    </>
  )
}
