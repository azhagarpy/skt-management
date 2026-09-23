# Employee Management & Payroll System — Master Development Prompt

## 1. Project Overview
Build a production-ready **Employee Management, Attendance, Leave, Salary, Payroll and Reporting System** as a Progressive Web App (PWA).

### Technology Stack
Frontend:

- React
- TypeScript
- Vite
- React Router
- TanStack Query
- React Hook Form
- Zod
- PWA / Service Worker
- Responsive UI for desktop, tablet and mobile
Backend:

- Node.js
- Express.js
- TypeScript
- REST API
- Zod validation
- JWT-based authentication or secure session-based authentication
- Proper RBAC authorization
- Structured error handling
- Logging
Database:

- PostgreSQL
- Use migrations
- Use transactions for payroll and other financial operations
Optional infrastructure:

- Redis for background jobs if required
- S3-compatible object storage for documents
- Docker
- Nginx

---

# 2. Core Business Requirements
The application manages:

1. Organizations/company information
2. Employees
3. Supervisors
4. Departments
5. Designations
6. Employee personal information
7. Employee identity documents
8. Bank/account details
9. PF details
10. ESI details
11. Attendance
12. Leave
13. Holidays
14. Weekly offs
15. Salary structures
16. Monthly payroll
17. Bonuses
18. Salary deductions
19. Payment status
20. Payslips
21. Reports
22. User permissions
23. Audit logs
24. Notifications

---

# 3. User Roles
There are exactly three primary roles:

## SUPER_ADMIN
The Super Admin has full access to the system.

Permissions include:

- Manage organizations
- Manage supervisors
- Manage employees
- Create/update/delete departments
- Create/update/delete designations
- Configure holidays
- Configure weekly offs
- Configure salary structures
- Configure PF/ESI rules
- Manage attendance
- Manage leave
- Manage bonuses
- Manage deductions
- Process payroll
- Manage monthly payments
- View all reports
- Export reports
- View employee documents
- Manage users
- View audit logs
- Change system settings

## SUPERVISOR
Supervisor permissions:

- Login
- View own profile
- Upload/update own required documents
- View assigned employees
- View team attendance
- Mark/manage attendance for assigned employees
- View employee leave information
- Approve/reject leave requests if configured
- View team salary/pay information only if explicitly permitted
- View team reports where permitted
Supervisor must NOT have access to Super Admin functions.

## EMPLOYEE
Employee permissions:

- Login
- View own profile
- Update allowed personal information
- Upload required documents
- Upload/update PAN
- Upload/update Aadhaar
- Upload bank/account details
- Upload PF details
- Upload ESI details
- View own attendance
- View own leave
- Apply for leave
- View own salary
- View own monthly payroll
- View own payment status
- View/download own payslip
- View notifications
Employee must NOT be able to view other employees' private information.

---

# 4. Important Attendance Requirement
There is NO check-in/check-out functionality at this stage.

Do NOT implement:

- Check-in time
- Check-out time
- Break time
- GPS attendance
- Biometric attendance
- Working hours calculation
- Overtime calculation
Attendance is currently status-based only.

Allowed attendance statuses:

```
PRESENT
ABSENT
ON_LEAVE
HALF_DAY_LEAVE
HOLIDAY
WEEKLY_OFF
```
The system must be designed so time-based attendance can be added later, but it should NOT be implemented now.

---

# 5. Attendance Rules
Each employee has one attendance record per date.

Example:

```
Employee: EMP001
Date: 2026-09-01
Status: PRESENT
```
Another example:

```
Employee: EMP002
Date: 2026-09-01
Status: ON_LEAVE
```
Database constraint:

```
employee_id + attendance_date
```
must be unique.

Do not allow duplicate attendance records for the same employee and date.

---

# 6. Attendance Management
Super Admin should be able to:

- Select date
- Select department
- Select supervisor
- View employees
- Mark Present
- Mark Absent
- Mark On Leave
- Mark Half Day Leave
- Mark Holiday
- Mark Weekly Off
- Bulk mark attendance
- Edit attendance
- View attendance history
Example UI:

```
Date: September 2, 2026

Department: IT
Supervisor: John

--------------------------------------------------
Employee       Status              Action
--------------------------------------------------
EMP001         Present             [Change]
EMP002         Absent              [Change]
EMP003         On Leave            [Change]
EMP004         Half Day Leave      [Change]
--------------------------------------------------

[Mark All Present]
[Save Attendance]
```
Supervisor should be able to manage attendance for employees assigned to that supervisor.

Employee can only view their own attendance.

---

# 7. Attendance Calendar
Create a monthly calendar view.

Example:

```
Employee: John Doe
September 2026

Mon Tue Wed Thu Fri Sat Sun
 1   2   3   4   5   6   7
 P   P   A   P   P   WO  WO

 8   9  10  11  12  13  14
 P   L   P   P   HL  WO  WO
```
Where:

```
P  = Present
A  = Absent
L  = On Leave
HL = Half Day Leave
H  = Holiday
WO = Weekly Off
```

---

# 8. Weekly Off Management
Do not hard-code Saturday/Sunday.

The system must support configurable weekly offs.

Example:

```
Monday     Working
Tuesday    Working
Wednesday  Working
Thursday   Working
Friday     Working
Saturday   Weekly Off
Sunday     Weekly Off
```
Allow configuration such as:

```
Every Sunday
Every Saturday + Sunday
2nd and 4th Saturday
1st, 3rd and 5th Saturday
Custom weekly off
```
Weekly off configuration should be organization-level and optionally department/location-level.

---

# 9. Holiday Management
Super Admin can create holidays.

Holiday fields:

```
id
organization_id
name
holiday_date
description
is_optional
created_at
updated_at
```
Examples:

```
Republic Day
Independence Day
Gandhi Jayanti
Diwali
Christmas
Company Holiday
```
Holiday should automatically appear in attendance/calendar views.

---

# 10. Leave Management
Create configurable leave types.

Examples:

```
Casual Leave
Sick Leave
Earned Leave
Unpaid Leave
Other Leave
```
Each leave type can have:

```
name
code
annual_limit
is_paid
requires_approval
status
```
Employee can submit:

```
Leave Type
From Date
To Date
Reason
Attachment (optional)
```
Leave request statuses:

```
PENDING
APPROVED
REJECTED
CANCELLED
```
Leave approval workflow:

```
Employee
   ↓
Leave Request
   ↓
Supervisor
   ↓
Approve / Reject
   ↓
Attendance Updated
```
If Supervisor approval is not required for a particular leave type, allow configurable behavior.

---

# 11. Employee Profile
Employee profile should contain the following sections.

## Personal Information

```
Employee ID
Employee Code
First Name
Middle Name
Last Name
Gender
Date of Birth
Mobile Number
Email
Address
City
State
Country
Pincode
Emergency Contact
```

## Employment Information

```
Joining Date
Employment Type
Employment Status
Department
Designation
Supervisor
Location
```
Employment status:

```
ACTIVE
INACTIVE
ON_NOTICE
RESIGNED
TERMINATED
```
Employment type:

```
FULL_TIME
PART_TIME
CONTRACT
TEMPORARY
INTERN
```

---

# 12. Employee Required Documents
Every employee and supervisor must have a document/profile completion section.

Required information:

1. PAN
2. Aadhaar
3. Bank/account details
4. PF details
5. ESI details
The system should clearly show document/profile completion status.

Example:

```
Employee Profile Completion

Personal Information       ✓ Complete
PAN                        ✓ Uploaded
Aadhaar                    ✓ Uploaded
Bank Details               ✓ Complete
PF Details                 ✓ Complete
ESI Details                ⚠ Pending

Profile Completion: 83%
```

---

# 13. PAN Details
Create a dedicated employee PAN section.

Fields:

```
PAN Number
PAN Name
PAN Document
Verification Status
```
Verification status:

```
PENDING
VERIFIED
REJECTED
```
Only authorized users can verify documents.

Employee can upload/update their PAN.

Supervisor can upload/update their own PAN.

Super Admin can view and verify.

---

# 14. Aadhaar Details
Create a dedicated Aadhaar section.

Fields:

```
Aadhaar Number
Aadhaar Name
Aadhaar Document
Verification Status
```
IMPORTANT:

Aadhaar is highly sensitive personal information.

Do not expose the full Aadhaar number in normal employee lists.

Display masked values where appropriate:

```
XXXX XXXX 1234
```
Only authorized users should be able to access sensitive information.

Store sensitive information securely.

---

# 15. Bank / Account Details
Create a dedicated bank details table.

Fields:

```
Account Holder Name
Bank Name
Account Number
IFSC Code
Branch Name
Account Type
Cancelled Cheque / Bank Proof
Verification Status
```
Account type:

```
SAVINGS
CURRENT
OTHER
```
Account number should be masked in normal UI.

Example:

```
Bank: HDFC Bank
Account: ******1234
IFSC: HDFC0001234
```

---

# 16. PF Details
Create dedicated PF information.

Fields:

```
UAN Number
PF Member ID
PF Applicable
Employee Contribution
Employer Contribution
PF Document
Verification Status
```
PF should be configurable rather than hard-coded.

---

# 17. ESI Details
Create dedicated ESI information.

Fields:

```
ESI Applicable
ESI Number
Employee Contribution
Employer Contribution
ESI Document
Verification Status
```
Again, do not hard-code statutory rates throughout the application.

Store applicable rules/configuration separately.

---

# 18. Supervisor Documents
Supervisors must have the same required financial/identity information:

```
PAN
Aadhaar
Bank Account
PF
ESI
```
The supervisor profile should have the same document completion mechanism as employees.

Super Admin should be able to see:

```
Supervisor Profile
Document Status
Verification Status
Bank Details
PF Details
ESI Details
```

---

# 19. Salary Management
The system must support different salary bases.

Salary basis:

```
MONTHLY
DAILY
```
Do not implement hourly salary at this stage unless explicitly requested later.

---

# 20. Salary Structure
Do not store salary only as one number.

Create salary structures with components.

Example:

```
Salary Structure: Monthly Staff

Basic Salary              ₹25,000
HRA                       ₹10,000
Special Allowance          ₹5,000
Transport Allowance        ₹2,000
---------------------------------
Gross Salary              ₹42,000
```
Salary components should support:

```
EARNING
DEDUCTION
EMPLOYER_CONTRIBUTION
```
Calculation types:

```
FIXED
PERCENTAGE
```
Each component should have configurable properties:

```
name
code
type
calculation_type
amount
percentage
taxable
pf_applicable
esi_applicable
active
```

---

# 21. Employee Salary Assignment
An employee can have a salary history.

Do NOT overwrite historical salary records.

Example:

```
Employee: EMP001

01-Jan-2025 → ₹25,000
01-Jan-2026 → ₹30,000
01-Jul-2026 → ₹35,000
```
Create:

```
employee_salary_assignments
```
with:

```
employee_id
salary_structure_id
effective_from
effective_to
status
```
When processing payroll, use the salary structure effective for that payroll period.

---

# 22. Daily Salary Calculation
For daily-paid employees:

```
Daily Rate × Paid Days
```
Paid days must be determined based on attendance rules.

Example:

```
Daily Salary = ₹800

Present = 22 days
Half Day Leave = 1 day
Paid Leave = 2 days
Unpaid Leave = 1 day

Payroll calculation must follow the organization's configured paid/unpaid leave rules.
```
Do not hard-code assumptions about whether every leave type is paid.

---

# 23. Monthly Salary Calculation
For monthly employees, configure how absence affects salary.

The system should support configurable payroll policies such as:

```
Calendar Days
Working Days
Actual Attendance Days
```
Example:

```
Monthly Salary = ₹30,000

Payroll Period = September 2026

Paid Days = 28
Absent/Unpaid Days = 2

Deduction = based on configured salary calculation policy
```
The calculation method must be configurable.

---

# 24. Half Day Leave
Half-day leave must be represented accurately.

Do not treat it as a full day.

For payroll calculations, configurable behavior should support:

```
Half Day = 0.5 paid day
Half Day = 0.5 unpaid day
```
depending on the leave type/policy.

---

# 25. Bonus Management
Super Admin can add bonuses.

Bonus fields:

```
employee_id
bonus_type
amount
bonus_date
payroll_month
reason
status
```
Bonus types:

```
Performance Bonus
Festival Bonus
Attendance Bonus
Production Bonus
Referral Bonus
Special Bonus
Other
```
Bonus can be:

```
FIXED_AMOUNT
PERCENTAGE
```
Bonuses should appear as payroll earning components.

---

# 26. Deductions
The system should support configurable deductions.

Examples:

```
PF
ESI
Professional Tax
TDS
Loan Deduction
Advance Deduction
Other Deduction
```
Each deduction should be stored as a separate payroll component.

---

# 27. Monthly Payroll
Payroll is processed month-by-month.

Example:

```
September 2026 Payroll
```
Payroll statuses:

```
DRAFT
CALCULATED
UNDER_REVIEW
APPROVED
LOCKED
```
Payment status is separate from payroll processing status.

Do NOT combine them.

---

# 28. Payroll Processing Flow

```
Create Payroll
       ↓
Select Month
       ↓
Load Active Employees
       ↓
Load Salary Structures
       ↓
Load Attendance
       ↓
Load Leave
       ↓
Load Holidays
       ↓
Calculate Paid Days
       ↓
Calculate Earnings
       ↓
Calculate Bonuses
       ↓
Calculate Deductions
       ↓
Calculate PF
       ↓
Calculate ESI
       ↓
Calculate Other Deductions
       ↓
Calculate Net Salary
       ↓
Review
       ↓
Approve
       ↓
Lock
```

---

# 29. Payment Status
Monthly employee payment status must be managed separately from payroll status.

Payment statuses:

```
PENDING
PARTIALLY_PAID
PAID
```
Example:

```
Employee: EMP001
September Salary: ₹35,000

Payment Status: PENDING
Paid Amount: ₹0
Pending Amount: ₹35,000
```
Partial payment:

```
Salary: ₹35,000
Paid: ₹20,000
Pending: ₹15,000

Status: PARTIALLY_PAID
```
Fully paid:

```
Salary: ₹35,000
Paid: ₹35,000
Pending: ₹0

Status: PAID
```

---

# 30. Payment Transactions
Do not only store:

```
payment_status
```
Create payment transactions.

Example:

```
payroll_payment_transactions

id
payroll_item_id
payment_date
amount
payment_method
reference_number
notes
created_by
created_at
```
This allows multiple partial payments.

Example:

```
Salary: ₹35,000

01-Sep → ₹10,000
10-Sep → ₹10,000
20-Sep → ₹15,000

Total Paid = ₹35,000
Status = PAID
```
Payment methods:

```
BANK_TRANSFER
CASH
CHEQUE
UPI
OTHER
```

---

# 31. Payroll Item
Each employee gets one payroll item per payroll month.

Example:

```
Employee: EMP001
Month: September 2026

Basic Salary              ₹25,000
HRA                        ₹8,000
Bonus                      ₹2,000
----------------------------------
Gross Earnings             ₹35,000

PF                         ₹1,800
ESI                          ₹300
Other Deduction              ₹500
----------------------------------
Total Deductions            ₹2,600

Net Salary                 ₹32,400

Paid Amount                ₹20,000
Pending Amount             ₹12,400

Payment Status: PARTIALLY_PAID
```

---

# 32. Payroll Snapshot
Once payroll is calculated, store the calculated components in payroll tables.

Do not dynamically recalculate old payroll based on the employee's current salary.

For example:

```
August 2026 payroll
```
must remain unchanged even if the employee's salary changes in September.

Payroll must maintain a historical snapshot of:

```
Salary components
Attendance result
Paid days
Leave days
Bonus
Deductions
PF
ESI
Gross
Net
```

---

# 33. Payroll Locking
After payroll is locked:

```
LOCKED
```
normal users must not be able to edit:

- Salary
- Payroll components
- Attendance used by payroll
- Bonus
- Deductions
- Net salary
If a correction is required, use an adjustment/reversal mechanism.

---

# 34. Payroll Database Structure
Create tables similar to:

```
payroll_runs
```
Fields:

```
id
organization_id
year
month
status
total_employees
total_gross
total_deductions
total_net
created_by
approved_by
created_at
approved_at
locked_at
```

---

## payroll_items

```
id
payroll_run_id
employee_id

working_days
present_days
absent_days
leave_days
half_day_leave_days
holiday_days
weekly_off_days
paid_days

gross_earnings
total_deductions
net_salary

paid_amount
pending_amount
payment_status

created_at
updated_at
```

---

## payroll_item_components

```
id
payroll_item_id

component_code
component_name
component_type
amount

calculation_type
source
```

---

## payroll_payment_transactions

```
id
payroll_item_id

payment_date
amount
payment_method
reference_number
notes

created_by
created_at
```

---

# 35. Database Design
Use normalized PostgreSQL tables.

Core tables:

```
organizations

users
roles
permissions
role_permissions

employees

departments
designations
locations

employee_addresses
employee_emergency_contacts
employee_bank_accounts
employee_pan_details
employee_aadhaar_details
employee_pf_details
employee_esi_details
employee_documents

employee_job_history

shifts
employee_shift_assignments

weekly_off_rules
holiday_calendars
holidays

leave_types
leave_policies
employee_leave_balances
leave_requests
leave_approvals

attendance

salary_structures
salary_components
employee_salary_assignments

bonus_types
employee_bonuses

payroll_runs
payroll_items
payroll_item_components
payroll_payment_transactions

notifications

audit_logs
system_settings
```

---

# 36. Important Database Rules
Use UUID primary keys.

Every organization-specific table should include:

```
organization_id
```
Use foreign keys.

Use indexes on:

```
organization_id
employee_id
attendance_date
payroll_run_id
year
month
payment_status
leave status
```
Use unique constraints where appropriate.

For attendance:

```
UNIQUE(employee_id, attendance_date)
```
For monthly payroll:

```
UNIQUE(payroll_run_id, employee_id)
```
For payroll run:

```
UNIQUE(organization_id, year, month)
```
unless multiple payroll runs per month are intentionally supported.

---

# 37. Authentication
Implement secure authentication.

Login:

```
Email / Employee ID
Password
```
Password must be hashed using a secure password hashing algorithm such as Argon2 or bcrypt.

Implement:

```
Login
Logout
Refresh Token / Session
Forgot Password
Reset Password
Change Password
```
Do not store plain-text passwords.

---

# 38. Authorization
Every protected API endpoint must validate:

1. User authentication
2. User role
3. User permissions
4. Organization access
5. Resource ownership where applicable
Example:

```
Employee:
GET /employees/me
```
Employee must not be able to call:

```
GET /employees
```
and receive all employees.

Supervisor can only access employees assigned to them.

Super Admin can access all employees in their organization.

---

# 39. Employee Document Security
Documents are sensitive.

Do not expose files using public URLs.

Use protected file access.

Example:

```
GET /api/v1/employees/:id/documents/:documentId
```
Backend verifies permission before generating/accessing the file.

Sensitive documents should not be publicly accessible.

---

# 40. Audit Logging
Log all important changes.

Examples:

```
Employee Created
Employee Updated
Salary Changed
Attendance Changed
Leave Approved
Leave Rejected
Bonus Added
Payroll Calculated
Payroll Approved
Payroll Locked
Payment Added
Payment Updated
Document Uploaded
Document Verified
```
Audit fields:

```
id
organization_id
user_id
action
entity_type
entity_id
old_values
new_values
ip_address
user_agent
created_at
```

---

# 41. Reports
Create a dedicated Reports module.

## Employee Reports

```
Employee Master
Active Employees
Inactive Employees
New Employees
Department-wise Employees
Supervisor-wise Employees
Employee Document Status
```

## Attendance Reports

```
Daily Attendance
Monthly Attendance
Employee Attendance
Department Attendance
Present Report
Absent Report
Leave Report
Half Day Report
Holiday Report
Weekly Off Report
```

## Leave Reports

```
Leave Requests
Approved Leaves
Rejected Leaves
Leave Balance
Employee Leave Summary
Department Leave Summary
```

## Payroll Reports

```
Monthly Payroll
Salary Register
Employee Salary Report
Department Salary Report
Gross Salary Report
Net Salary Report
Deduction Report
Bonus Report
PF Report
ESI Report
Payment Status Report
Pending Salary Report
Partial Payment Report
Paid Salary Report
```

---

# 42. Dashboard

## Super Admin Dashboard
Display:

```
Total Employees
Active Employees
Total Supervisors

Present Today
Absent Today
On Leave Today
Half Day Today

Pending Leave Requests

Current Month Gross Salary
Current Month Net Salary

Paid Payroll
Pending Payments
Partial Payments

Employees With Missing Documents
```
Example:

```
Employees             250
Supervisors             12

Present Today          218
Absent Today            14
On Leave Today          12
Half Day                 6

----------------------------

September Payroll

Gross Salary       ₹52,00,000
Net Salary         ₹47,20,000

Paid               ₹40,00,000
Partial             ₹4,00,000
Pending             ₹3,20,000
```

---

# 43. Supervisor Dashboard
Show:

```
My Team
Present Today
Absent Today
On Leave Today
Half Day Today

Pending Leave Requests

Team Attendance
Team Employee List
```
Supervisor should only see assigned employees.

---

# 44. Employee Dashboard
Show:

```
Welcome, Employee

Today's Attendance
Current Month Attendance
Leave Balance
Pending Leave Requests

Current Month Salary
Paid Amount
Pending Amount
Payment Status

Profile Completion
Document Verification Status

Latest Payslip
Notifications
```

---

# 45. Employee Profile Completion
Create a profile completion calculation.

Required sections:

```
Personal Information
PAN
Aadhaar
Bank Account
PF
ESI
```
Example:

```
6 required sections

Complete: 5
Pending: 1

Completion: 83%
```
The employee dashboard should prominently show missing information.

---

# 46. UI Requirements
Build a modern professional admin dashboard.

Desktop:

```
Sidebar
Top Navigation
Breadcrumb
Page Content
Tables
Filters
Cards
Charts
Dialogs
Forms
```
Mobile:

```
Bottom navigation or collapsible sidebar
Responsive cards
Mobile-friendly forms
Mobile-friendly tables
Touch-friendly buttons
```
PWA should work well on Android and desktop.

---

# 47. Main Navigation

## Super Admin

```
Dashboard

Organization
  ├── Departments
  ├── Designations
  ├── Locations
  └── Settings

Employees
  ├── All Employees
  ├── Add Employee
  └── Employee Documents

Supervisors

Attendance
  ├── Daily Attendance
  ├── Monthly Attendance
  └── Attendance Reports

Leave
  ├── Leave Requests
  ├── Leave Types
  └── Leave Policies

Calendar
  ├── Holidays
  └── Weekly Off

Salary
  ├── Salary Structures
  └── Employee Salaries

Payroll
  ├── Payroll Runs
  ├── Monthly Payroll
  ├── Payments
  └── Payslips

Bonuses

Reports

Audit Logs

Settings
```

## Supervisor

```
Dashboard
My Team
Attendance
Leave
Reports
My Profile
Documents
```

## Employee

```
Dashboard
My Profile
My Attendance
My Leave
My Salary
My Payslips
My Documents
Notifications
```

---

# 48. API Structure
Use versioned REST APIs.

Base:

```
/api/v1
```
Authentication:

```
POST /auth/login
POST /auth/logout
POST /auth/refresh
POST /auth/forgot-password
POST /auth/reset-password
GET  /auth/me
```
Employees:

```
GET    /employees
POST   /employees
GET    /employees/:id
PATCH  /employees/:id
DELETE /employees/:id
GET    /employees/:id/documents
POST   /employees/:id/documents
```
Attendance:

```
GET   /attendance
POST  /attendance
PATCH /attendance/:id
POST  /attendance/bulk
GET   /attendance/monthly
```
Leave:

```
GET   /leave/requests
POST  /leave/requests
GET   /leave/requests/:id
POST  /leave/requests/:id/approve
POST  /leave/requests/:id/reject
```
Salary:

```
GET   /salary/structures
POST  /salary/structures
PATCH /salary/structures/:id

GET   /employees/:id/salary
POST  /employees/:id/salary
```
Payroll:

```
GET  /payroll/runs
POST /payroll/runs
GET  /payroll/runs/:id
POST /payroll/runs/:id/calculate
POST /payroll/runs/:id/approve
POST /payroll/runs/:id/lock
GET  /payroll/runs/:id/items
```
Payments:

```
GET  /payroll/:payrollItemId/payments
POST /payroll/:payrollItemId/payments
```
Reports:

```
GET /reports/employees
GET /reports/attendance
GET /reports/leave
GET /reports/payroll
GET /reports/payments
GET /reports/pf
GET /reports/esi
```

---

# 49. API Response Format
Use consistent responses.

Success:

```
{
  "success": true,
  "data": {},
  "message": "Employee created successfully"
}
```
Error:

```
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid employee data",
    "details": []
  }
}
```

---

# 50. Backend Architecture
Use modular architecture.

```
server/
└── src/
    ├── config/
    ├── middleware/
    ├── utils/
    ├── database/
    │
    ├── modules/
    │   ├── auth/
    │   ├── users/
    │   ├── employees/
    │   ├── departments/
    │   ├── designations/
    │   ├── attendance/
    │   ├── leave/
    │   ├── holidays/
    │   ├── shifts/
    │   ├── salary/
    │   ├── payroll/
    │   ├── bonuses/
    │   ├── payments/
    │   ├── documents/
    │   ├── reports/
    │   └── notifications/
    │
    ├── app.ts
    └── server.ts
```
Each module should contain:

```
controller
service
repository
routes
validation
types
```
Payroll should additionally contain:

```
calculator
rules
```

---

# 51. Frontend Architecture

```
src/
├── app/
│   ├── router/
│   ├── providers/
│   └── store/
│
├── features/
│   ├── auth/
│   ├── dashboard/
│   ├── employees/
│   ├── supervisors/
│   ├── attendance/
│   ├── leave/
│   ├── holidays/
│   ├── salary/
│   ├── payroll/
│   ├── payments/
│   ├── reports/
│   ├── documents/
│   └── notifications/
│
├── components/
│   ├── ui/
│   ├── tables/
│   ├── forms/
│   ├── dialogs/
│   └── charts/
│
├── layouts/
├── hooks/
├── lib/
├── types/
└── utils/
```
Use reusable components.

Examples:

```
DataTable
SearchInput
DatePicker
EmployeeSelector
DepartmentSelector
StatusBadge
ConfirmDialog
DocumentUploader
CurrencyInput
Pagination
ExportButton
```

---

# 52. Document Upload
Support:

```
PDF
JPG
JPEG
PNG
```
Validate:

```
File type
File size
File name
```
Do not trust the MIME type supplied by the client.

Generate safe storage names.

Do not use original file names directly as storage keys.

---

# 53. Data Privacy
Treat the following as sensitive:

```
Aadhaar
PAN
Bank Account
PF
ESI
Salary
Payroll
Payslips
```
Implement:

- Masking
- Role-based access
- Protected document URLs
- Audit logs
- Encryption where appropriate
- Secure database access
- HTTPS
- No sensitive information in application logs
- No sensitive information in browser localStorage unless absolutely necessary

---

# 54. Validation
Validate every API request.

Examples:

PAN:

```
Validate expected PAN format
```
IFSC:

```
Validate expected IFSC format
```
Email:

```
Valid email
```
Phone:

```
Valid phone format
```
Salary:

```
Must be >= 0
```
Payment:

```
Amount > 0
Amount <= remaining payable amount
```
Do validation on both:

```
Frontend
Backend
```
Backend validation is mandatory.

---

# 55. Payment Rules
When recording a payment:

```
remaining = net_salary - total_paid
```
New payment cannot exceed:

```
remaining
```
Example:

```
Net Salary = ₹40,000
Already Paid = ₹30,000
Remaining = ₹10,000
```
Allowed:

```
₹5,000
```
Not allowed:

```
₹15,000
```
After payment:

```
total_paid = 35,000
pending = 5,000
status = PARTIALLY_PAID
```
When:

```
total_paid == net_salary
```
status becomes:

```
PAID
```

---

# 56. Payroll Transaction Safety
Payroll operations must use PostgreSQL transactions.

Especially:

```
Payroll calculation
Payroll approval
Payroll locking
Payment creation
Payment updates
Leave approval + attendance update
```
If one part fails, rollback the entire operation.

---

# 57. Reporting and Export
Reports should support:

```
CSV
Excel
PDF
```
Filters:

```
Date range
Month
Department
Supervisor
Employee
Status
Payment status
```
Examples:

```
September Payroll
Department = IT
Payment Status = PENDING
```
should return only matching employees.

---

# 58. Search and Filtering
Large employee lists must support:

```
Search by:
Employee ID
Employee Code
Name
Email
Phone
Department
Designation
Supervisor
Status
```
Use server-side pagination.

Do not load thousands of records into React at once.

---

# 59. Performance
Use:

```
Database indexes
Pagination
Server-side filtering
Lazy-loaded React routes
Caching where appropriate
Optimized SQL
Connection pooling
```
For payroll calculations, avoid N+1 queries.

Use batch queries where possible.

---

# 60. Audit and History
Never silently modify important financial records.

For:

```
Salary
Payroll
Payment
Bonus
Deduction
Attendance
Leave
Documents
```
maintain appropriate history/audit information.

---

# 61. Testing
Create tests for:

### Backend

```
Authentication
Authorization
Employee CRUD
Attendance
Leave
Salary calculation
Payroll calculation
Payment calculation
Document permissions
```

### Critical payroll test cases
Test:

```
Monthly employee
Daily employee
Present days
Absent days
Paid leave
Unpaid leave
Half-day leave
Holiday
Weekly off
Bonus
PF
ESI
Multiple deductions
Partial payment
Full payment
Salary change
Employee joining mid-month
Employee leaving mid-month
```

---

# 62. Payroll Calculation Example
Example employee:

```
Employee:
John Doe

Salary Basis:
MONTHLY

Monthly Gross:
₹40,000

PF:
₹1,800

ESI:
₹300

Bonus:
₹2,000

Other Deduction:
₹500
```
Calculation:

```
Gross Earnings
₹40,000
+ Bonus
₹2,000
----------------
Total Earnings
₹42,000

Deductions:
PF       ₹1,800
ESI        ₹300
Other      ₹500
----------------
Total      ₹2,600

Net Salary:
₹39,400
```
Payment:

```
Paid:
₹20,000

Pending:
₹19,400

Status:
PARTIALLY_PAID
```

---

# 63. Important Domain Rules
Implement these rules carefully:

1. One attendance record per employee per date.
2. Employee cannot modify another employee's attendance.
3. Supervisor can only manage assigned employees.
4. Employee can only see their own information.
5. Super Admin has organization-wide access.
6. Employee documents must be protected.
7. Full Aadhaar should not be displayed unnecessarily.
8. Salary history must be preserved.
9. Historical payroll must not change after salary updates.
10. Payroll and payment status are separate concepts.
11. Partial payments must be supported.
12. Total payments cannot exceed net salary.
13. Locked payroll cannot be directly edited.
14. Payroll calculations must be reproducible.
15. Statutory rules such as PF/ESI should be configurable.
16. Leave and attendance must remain logically consistent.
17. Weekly offs and holidays should be calculated from configuration.
18. All important financial changes must be audited.

---

# 64. PWA Requirements
Implement:

```
Installable PWA
Service worker
App manifest
Responsive layout
Offline app shell
Caching of safe/read-only data where appropriate
Network status indicator
```
Do not cache sensitive payroll/document information in an insecure way.

Employee should be able to use the application comfortably from a mobile phone.

---

# 65. Error Handling
Create global Express error handling.

Handle:

```
Validation errors
Authentication errors
Authorization errors
Not found
Duplicate records
Database errors
File upload errors
Payroll calculation errors
Payment errors
```
Return proper HTTP status codes.

Examples:

```
400 Validation
401 Unauthenticated
403 Forbidden
404 Not Found
409 Conflict
422 Business Rule Error
500 Internal Server Error
```
Never expose stack traces or database internals to production users.

---

# 66. Seed Data
Create development seed data.

Create:

```
1 Organization

1 Super Admin

2 Supervisors

10 Employees

3 Departments

3 Designations

2 Salary Structures

Several Leave Types

Holiday Calendar

Weekly Off Configuration

Sample Attendance

Sample Payroll

Sample Payment Transactions
```
Create sample accounts for development only.

---

# 67. Initial Development Milestones
Build in this order.

## Milestone 1

```
Project setup
React PWA
Express API
PostgreSQL
Docker
Authentication
RBAC
```

## Milestone 2

```
Organization
Departments
Designations
Supervisors
Employees
Employee profiles
```

## Milestone 3

```
PAN
Aadhaar
Bank details
PF
ESI
Document uploads
Verification
Profile completion
```

## Milestone 4

```
Attendance
Weekly offs
Holidays
Monthly attendance calendar
```

## Milestone 5

```
Leave types
Leave policies
Leave requests
Leave approval
Leave balances
```

## Milestone 6

```
Salary structures
Salary components
Salary history
Employee salary assignment
```

## Milestone 7

```
Payroll engine
Monthly payroll
PF
ESI
Bonus
Deductions
Payroll approval
Payroll locking
```

## Milestone 8

```
Payment management
Partial payment
Full payment
Pending payment
Payment transactions
```

## Milestone 9

```
Payslips
Reports
CSV/Excel/PDF export
Dashboard analytics
```

## Milestone 10

```
Audit logs
Notifications
Security hardening
Testing
Performance optimization
Production deployment
```

---

# 68. Code Quality Requirements
Write production-quality code.

Requirements:

- TypeScript strict mode
- No `any` unless absolutely necessary
- Modular architecture
- Reusable components
- No duplicated business logic
- Business logic must be in services
- Database queries must be isolated appropriately
- Validation schemas must be reusable
- Consistent naming
- Proper error handling
- Proper logging
- Database migrations
- Environment variables
- No secrets committed to Git
- No hard-coded passwords
- No hard-coded statutory rates
- No hard-coded organization-specific rules

---

# 69. Environment Configuration
Use:

```
.env
```
for:

```
DATABASE_URL
JWT_SECRET
JWT_EXPIRES_IN
REFRESH_TOKEN_SECRET
STORAGE_ENDPOINT
STORAGE_BUCKET
STORAGE_ACCESS_KEY
STORAGE_SECRET_KEY
REDIS_URL
```
Never commit `.env`.

Provide:

```
.env.example
```

---

# 70. Final Architecture
The final system should follow:

```
                     React PWA
                         │
                         │ HTTPS
                         ▼
                  Express REST API
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
        ▼                ▼                 ▼
 Authentication     Business Logic      Reports
 RBAC               Services            Exports
        │                │
        └────────────────┤
                         ▼
                    PostgreSQL
                         │
             ┌───────────┼────────────┐
             ▼           ▼            ▼
         Employees    Attendance    Payroll
             │           │            │
             ▼           ▼            ▼
        Documents      Leave       Payments
                         │
                         ▼
                    Audit Logs
```

---

# 71. Final Implementation Instruction
Do not build the entire application as one large file or one large module.

Build it as a modular monolith with clear domain boundaries.

Prioritize correctness of:

1. Employee data
2. Document security
3. Attendance
4. Leave
5. Salary
6. Payroll
7. Payment tracking
8. Historical payroll
9. Permissions
10. Audit logging
The payroll calculation must be deterministic and testable.

The application must be designed so that future modules such as:

```
Check-in / Check-out
Biometric attendance
GPS attendance
Overtime
Loans
Reimbursements
TDS
Advanced tax calculation
Multiple organizations
Multiple locations
Mobile push notifications
```
can be added without rewriting the existing architecture.

Before implementing each module, first define:

- Database schema
- Relationships
- API endpoints
- Validation rules
- Authorization rules
- Business rules
- UI screens
- Test cases
Then implement the module.

Do not make assumptions about payroll/legal/statutory rules that were not specified. Make such rules configurable and clearly document them.

The finished application should be production-ready, responsive, secure, maintainable and suitable for deployment as a React PWA with an Express API and PostgreSQL database.