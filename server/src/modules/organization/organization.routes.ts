import { Router } from 'express'
import { z } from 'zod'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermissions } from '../../middleware/authorize.js'
import { validate } from '../../middleware/validate.js'
import { uploadSingleImage } from '../../middleware/upload.js'
import { PERMISSIONS } from '../auth/permissions.js'
import * as controller from './organization.controller.js'
import {
  departmentSchema,
  designationSchema,
  listQuerySchema,
  locationSchema,
  settingsUpsertSchema,
  updateDepartmentSchema,
  updateDesignationSchema,
  updateLocationSchema,
  updateOrganizationSchema,
  uuidParam,
} from './organization.validation.js'

const idParam = uuidParam('id')

export const organizationRouter = Router()
organizationRouter.use(authenticate)

organizationRouter.get('/', requirePermissions(PERMISSIONS.ORG_VIEW), controller.getOrganization)
organizationRouter.patch(
  '/',
  requirePermissions(PERMISSIONS.ORG_MANAGE),
  validate({ body: updateOrganizationSchema }),
  controller.updateOrganization,
)

// Branding. Anyone who can see the organization can render its logo; only
// org.manage may change it.
organizationRouter.get('/logo', requirePermissions(PERMISSIONS.ORG_VIEW), controller.getOrganizationLogo)
organizationRouter.post(
  '/logo',
  requirePermissions(PERMISSIONS.ORG_MANAGE),
  uploadSingleImage,
  controller.updateOrganizationLogo,
)
organizationRouter.delete(
  '/logo',
  requirePermissions(PERMISSIONS.ORG_MANAGE),
  controller.removeOrganizationLogo,
)

organizationRouter.get(
  '/settings',
  requirePermissions(PERMISSIONS.SETTINGS_VIEW),
  validate({ query: z.object({ category: z.string().trim().max(60).optional() }) }),
  controller.listSettings,
)
organizationRouter.put(
  '/settings',
  requirePermissions(PERMISSIONS.SETTINGS_MANAGE),
  validate({ body: settingsUpsertSchema }),
  controller.upsertSettings,
)

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------
export const departmentRouter = Router()
departmentRouter.use(authenticate)

departmentRouter.get(
  '/',
  requirePermissions(PERMISSIONS.DEPARTMENT_VIEW),
  validate({ query: listQuerySchema }),
  controller.listDepartments,
)
departmentRouter.post(
  '/',
  requirePermissions(PERMISSIONS.DEPARTMENT_MANAGE),
  validate({ body: departmentSchema }),
  controller.createDepartment,
)
departmentRouter.get(
  '/:id',
  requirePermissions(PERMISSIONS.DEPARTMENT_VIEW),
  validate({ params: idParam }),
  controller.getDepartment,
)
departmentRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.DEPARTMENT_MANAGE),
  validate({ params: idParam, body: updateDepartmentSchema }),
  controller.updateDepartment,
)
departmentRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.DEPARTMENT_MANAGE),
  validate({ params: idParam }),
  controller.deleteDepartment,
)

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------
export const designationRouter = Router()
designationRouter.use(authenticate)

designationRouter.get(
  '/',
  requirePermissions(PERMISSIONS.DESIGNATION_VIEW),
  validate({ query: listQuerySchema }),
  controller.listDesignations,
)
designationRouter.post(
  '/',
  requirePermissions(PERMISSIONS.DESIGNATION_MANAGE),
  validate({ body: designationSchema }),
  controller.createDesignation,
)
designationRouter.get(
  '/:id',
  requirePermissions(PERMISSIONS.DESIGNATION_VIEW),
  validate({ params: idParam }),
  controller.getDesignation,
)
designationRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.DESIGNATION_MANAGE),
  validate({ params: idParam, body: updateDesignationSchema }),
  controller.updateDesignation,
)
designationRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.DESIGNATION_MANAGE),
  validate({ params: idParam }),
  controller.deleteDesignation,
)

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
export const locationRouter = Router()
locationRouter.use(authenticate)

locationRouter.get(
  '/',
  requirePermissions(PERMISSIONS.LOCATION_VIEW),
  validate({ query: listQuerySchema }),
  controller.listLocations,
)
locationRouter.post(
  '/',
  requirePermissions(PERMISSIONS.LOCATION_MANAGE),
  validate({ body: locationSchema }),
  controller.createLocation,
)
locationRouter.get(
  '/:id',
  requirePermissions(PERMISSIONS.LOCATION_VIEW),
  validate({ params: idParam }),
  controller.getLocation,
)
locationRouter.patch(
  '/:id',
  requirePermissions(PERMISSIONS.LOCATION_MANAGE),
  validate({ params: idParam, body: updateLocationSchema }),
  controller.updateLocation,
)
locationRouter.delete(
  '/:id',
  requirePermissions(PERMISSIONS.LOCATION_MANAGE),
  validate({ params: idParam }),
  controller.deleteLocation,
)
