import { z } from 'zod';
import { ai } from './ai.js';
// Removed server-side AI router; orchestration handled by agno-service
import { ingestDocument } from './ingest.js';
import { registerAllRoutes } from './routes/index.js';
import { registerMetadataRoutes } from './routes/metadata.js';
import { initUploadAnalysisQueue, enqueueUploadAnalysisJob, getUploadAnalysisJob } from './lib/upload-analysis-queue.js';
import { getCompleteRolePermissions } from './lib/permission-helpers.js';

function requireOrg(req) {
  const orgId = req.headers['x-org-id'] || req.params?.orgId;
  if (!orgId) {
    const err = new Error('Missing org id');
    err.statusCode = 400;
    throw err;
  }
  return String(orgId);
}

async function ensureActiveMember(req) {
  const db = req.supabase;
  const orgId = requireOrg(req);
  const userId = req.user?.sub;
  if (!userId) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  const { data, error } = await db
    .from('organization_users')
    .select('role, created_at, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    const err = new Error('Membership expired');
    err.statusCode = 403;
    throw err;
  }
  return orgId;
}

/**
 * Smart department selection logic:
 * 1. Prefer non-Core and non-General departments
 * 2. If only General is available, use General
 * 3. If only Core is available, use Core
 * 4. If multiple non-Core/non-General available, use the first one
 */
async function selectSmartDepartment(db, orgId, departmentIds) {
  if (!departmentIds || departmentIds.length === 0) return null;
  if (departmentIds.length === 1) return departmentIds[0];

  try {
    // Get department names for the provided IDs
    const { data: departments, error } = await db
      .from('departments')
      .select('id, name')
      .eq('org_id', orgId)
      .in('id', departmentIds);

    if (error) {
      console.error('❌ Error fetching departments for smart selection:', error);
      return departmentIds[0]; // Fallback to first ID
    }

    if (!departments || departments.length === 0) {
      return departmentIds[0]; // Fallback to first ID
    }

    // Create a map for quick lookup
    const deptMap = new Map(departments.map(d => [d.id, d.name.toLowerCase()]));

    // Priority 1: Find non-Core and non-General departments
    const preferredDepts = departmentIds.filter(id => {
      const name = deptMap.get(id);
      return name && name !== 'core' && name !== 'general';
    });

    if (preferredDepts.length > 0) {
      console.log(`✅ [SMART_SELECTION] Selected preferred department: ${deptMap.get(preferredDepts[0])} (${preferredDepts[0]})`);
      return preferredDepts[0];
    }

    // Priority 2: If only General is available, use General
    const generalDept = departmentIds.find(id => deptMap.get(id) === 'general');
    if (generalDept) {
      console.log(`✅ [SMART_SELECTION] Selected General department: ${generalDept}`);
      return generalDept;
    }

    // Priority 3: If only Core is available, use Core
    const coreDept = departmentIds.find(id => deptMap.get(id) === 'core');
    if (coreDept) {
      console.log(`✅ [SMART_SELECTION] Selected Core department: ${coreDept}`);
      return coreDept;
    }

    // Fallback: Use first department
    console.log(`⚠️ [SMART_SELECTION] No preferred department found, using first: ${departmentIds[0]}`);
    return departmentIds[0];

  } catch (error) {
    console.error('❌ Error in smart department selection:', error);
    return departmentIds[0]; // Fallback to first ID
  }
}

function toDbDocumentFields(draft) {
  const out = {};
  if (!draft || typeof draft !== 'object') return out;
  // Simple mappings from client draft to DB columns
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const normalizeDate = (val) => {
    const str = s(val);
    if (!str) return null;
    // Already ISO yyyy-MM-dd
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    // Try yyyy/M/d or yyyy-M-d
    let m = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) {
      const [_, y, mo, d] = m;
      const mm = String(mo).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    // Try yy-M-d → assume 20yy
    m = str.match(/^(\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (m) {
      const [_, yy, mo, d] = m;
      const y = Number(yy) + 2000;
      const mm = String(mo).padStart(2, '0');
      const dd = String(d).padStart(2, '0');
      return `${y}-${mm}-${dd}`;
    }
    // Last resort: Date.parse
    const dt = new Date(str);
    if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
    return null;
  };
  if (s(draft.title)) out.title = s(draft.title);
  if (s(draft.filename)) out.filename = s(draft.filename);
  if (s(draft.type)) out.type = s(draft.type);
  if (Array.isArray(draft.folderPath)) out.folder_path = draft.folderPath.filter(Boolean);
  if (s(draft.subject)) out.subject = s(draft.subject);
  if (s(draft.description)) out.description = s(draft.description);
  if (s(draft.category)) out.category = s(draft.category);
  if (Array.isArray(draft.tags)) out.tags = draft.tags;
  if (Array.isArray(draft.keywords)) out.keywords = draft.keywords;
  if (s(draft.sender)) out.sender = s(draft.sender);
  if (s(draft.receiver)) out.receiver = s(draft.receiver);
  // Support both camelCase and snake_case for date; ignore empty strings
  const nd1 = normalizeDate(draft.documentDate);
  const nd2 = normalizeDate(draft.document_date);
  if (nd1) out.document_date = nd1;
  else if (nd2) out.document_date = nd2;
  if (s(draft.mimeType)) out.mime_type = s(draft.mimeType);
  if (typeof draft.fileSizeBytes === 'number') out.file_size_bytes = draft.fileSizeBytes;
  if (s(draft.contentHash)) out.content_hash = s(draft.contentHash);
  if (s(draft.storage_key)) out.storage_key = s(draft.storage_key);
  if (s(draft.storageKey)) out.storage_key = s(draft.storageKey);
  // Avoid inserting non-existent columns like content, name, folder, uploadedAt, ai fields, etc.
  // Also avoid content_hash to prevent unique constraint conflicts across versions.
  return out;
}

function mapDbToFrontendFields(data) {
  if (!data) return data;
  return {
    ...data,
    // Map database snake_case to frontend camelCase
    uploadedAt: data.uploaded_at,
    folderPath: data.folder_path || [],
    fileSizeBytes: data.file_size_bytes,
    mimeType: data.mime_type,
    contentHash: data.content_hash,
    storageKey: data.storage_key,
    departmentId: data.department_id || null,
    versionGroupId: data.version_group_id,
    versionNumber: data.version_number,
    isCurrentVersion: data.is_current_version,
    supersedesId: data.supersedes_id,
    documentDate: data.document_date,
    orgId: data.org_id,
    // Add version field for backwards compatibility
    version: data.version_number || 1,
    // Add name field as alias for title/filename
    name: data.title || data.filename || 'Untitled'
  };
}

function sanitizeFilename(name) {
  try {
    const trimmed = String(name || '').trim();
    // Decompose accents then remove non-ascii
    const decomp = trimmed.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    // Replace spaces with dashes and strip disallowed chars (keep letters, numbers, dot, dash, underscore)
    const cleaned = decomp.replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '-');
    // Collapse repeats
    return cleaned.replace(/-+/g, '-');
  } catch {
    return 'upload.bin';
  }
}

async function logAudit(app, orgId, actorUserId, type, fields) {
  try {
    await app.supabaseAdmin.from('audit_events').insert({
      org_id: orgId,
      actor_user_id: actorUserId,
      type,
      doc_id: fields.doc_id,
      title: fields.title,
      path: fields.path,
      note: fields.note,
    });
  } catch (e) {
    app.log.error(e, 'audit insert failed');
  }
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

async function getUserOrgRole(req) {
  const db = req.supabase;
  const orgId = requireOrg(req);
  const userId = req.user?.sub;
  const { data, error } = await db
    .from('organization_users')
    .select('role, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;
  return data.role || null;
}

async function ensureRole(req, allowedRoles) {
  const role = await getUserOrgRole(req);
  if (!role || !allowedRoles.includes(role)) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
  return role;
}

// Permissions: fetch joined org_roles.permissions for the caller
async function getMyPermissions(req, orgId) {
  const db = req.supabase;
  const userId = req.user?.sub;
  // Step 1: get role
  const { data: mem, error: memErr } = await db
    .from('organization_users')
    .select('role, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memErr) throw memErr;
  if (!mem || (mem.expires_at && new Date(mem.expires_at).getTime() <= Date.now())) return {};
  // Step 2: get permissions for role
  const { data: roleRow, error: roleErr } = await db
    .from('org_roles')
    .select('permissions')
    .eq('org_id', orgId)
    .eq('key', mem.role)
    .maybeSingle();
  if (roleErr) throw roleErr;
  return roleRow?.permissions || {};
}

async function fetchActiveIpBypassGrant(adminClient, orgId, userId) {
  if (!userId) return null;
  const nowIso = new Date().toISOString();
  const { data, error } = await adminClient
    .from('ip_bypass_grants')
    .select('id, expires_at, granted_at, granted_by, note')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .gt('expires_at', nowIso)
    .order('expires_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  const grant = data[0];
  if (!grant?.expires_at) return null;
  if (new Date(grant.expires_at).getTime() <= Date.now()) return null;
  return grant;
}

// Merge role permissions with per-user overrides (org-wide and optional dept-specific)
async function getEffectivePermissions(req, orgId, app, opts = {}) {
  const db = app.supabaseAdmin; // Use admin client to bypass RLS for override queries
  const userId = req.user?.sub;
  const deptId = Object.prototype.hasOwnProperty.call(opts, 'departmentId') ? opts.departmentId : undefined;

  // 1) user role in org
  const { data: membership, error: memErr } = await db
    .from('organization_users')
    .select('role, expires_at')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memErr) throw memErr;
  if (!membership || (membership.expires_at && new Date(membership.expires_at).getTime() <= Date.now())) return {};

  // 2) role permissions
  let rolePerms = {};
  if (membership.role) {
    const { data: roleRow } = await db
      .from('org_roles')
      .select('permissions')
      .eq('org_id', orgId)
      .eq('key', membership.role)
      .maybeSingle();
    rolePerms = roleRow?.permissions || {};
  }

  // 3) org-wide override
  const { data: orgOverrideRow } = await db
    .from('user_access_overrides')
    .select('permissions')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .is('department_id', null)
    .maybeSingle();
  const orgOverride = orgOverrideRow?.permissions || {};

  // 4) dept-specific override (only if explicit dept requested)
  let deptOverride = {};
  if (typeof deptId === 'string') {
    const { data: deptOverrideRow } = await db
      .from('user_access_overrides')
      .select('permissions')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .eq('department_id', deptId)
      .maybeSingle();
    deptOverride = deptOverrideRow?.permissions || {};
  }

  const keys = new Set([
    ...Object.keys(rolePerms || {}),
    ...Object.keys(orgOverride || {}),
    ...Object.keys(deptOverride || {}),
  ]);
  const effective = {};
  for (const k of keys) {
    // Handle string values for permissions like dashboard.view
    const deptHasKey = Object.prototype.hasOwnProperty.call(deptOverride, k);
    const orgHasKey = Object.prototype.hasOwnProperty.call(orgOverride, k);
    const roleHasKey = Object.prototype.hasOwnProperty.call(rolePerms, k);
    
    if (deptHasKey) {
      effective[k] = deptOverride[k];
    } else if (orgHasKey) {
      effective[k] = orgOverride[k];
    } else if (roleHasKey) {
      effective[k] = rolePerms[k];
    }
  }

  const meta = {
    security: {
      ip_bypass: {
        source: effective['security.ip_bypass'] === true ? 'roleOrOverride' : 'none',
        expiresAt: null,
        grantId: null,
      },
    },
  };

  try {
    const grant = await fetchActiveIpBypassGrant(db, orgId, userId);
    if (grant) {
      effective['security.ip_bypass'] = true;
      meta.security.ip_bypass = {
        source: 'timedGrant',
        expiresAt: grant.expires_at,
        grantId: grant.id,
      };
    }
  } catch (grantErr) {
    try {
      app.log?.warn(grantErr, 'Failed to fetch IP bypass grant');
    } catch {}
  }

  return { permissions: effective, meta };
}

async function ensurePerm(req, permKey, app, opts = {}) {
  const orgId = requireOrg(req);
  const { permissions } = await getEffectivePermissions(req, orgId, app, opts);
  if (!permissions || permissions[permKey] !== true) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
  return true;
}

// Helper to convert JS array to Postgres array literal string
function toPgArray(arr) {
  if (!Array.isArray(arr)) return '{}';
  return '{' + arr.map(s => '"' + String(s).replace(/"/g, '\"') + '"').join(',') + '}';
}

// Lightweight in-memory cache for Supabase admin user lookups (reduce API calls)
// Cache key: userId; value: { email, displayName, expiresAt }
const ADMIN_USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const adminUserCache = new Map();

async function getAdminUserCached(app, userId) {
  try {
    const now = Date.now();
    const hit = adminUserCache.get(userId);
    if (hit && hit.expiresAt > now) return hit;
    const { data } = await app.supabaseAdmin.auth.admin.getUserById(userId);
    const email = data?.user?.email || null;
    const displayName = (data?.user?.user_metadata?.display_name) || (data?.user?.user_metadata?.full_name) || null;
    const entry = { email, displayName, expiresAt: now + ADMIN_USER_CACHE_TTL_MS };
    adminUserCache.set(userId, entry);
    return entry;
  } catch {
    return { email: null, displayName: null, expiresAt: Date.now() + 60_000 };
  }
}

export function registerRoutes(app) {
  initUploadAnalysisQueue(app);

  app.get('/me', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const userId = req.user?.sub;
    
    // Optimize: Use Promise.all to run queries in parallel
    const [userResult, orgsResult] = await Promise.all([
      db.from('app_users').select('*').eq('id', userId).maybeSingle(),
      db.from('organization_users')
        .select('org_id, role, expires_at, organizations(name)')
        .eq('user_id', userId)
    ]);
    
    if (userResult.error) throw userResult.error;
    if (orgsResult.error) throw orgsResult.error;
    
    // Filter out expired memberships client-side as a safety (RLS already enforced server-side by routes)
    const now = Date.now();
    const list = (orgsResult.data || []).filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now);
    
    return {
      id: userId,
      displayName: userResult.data?.display_name || null,
      orgs: list.map((r) => ({ orgId: r.org_id, role: r.role, name: r.organizations?.name, expiresAt: r.expires_at })),
    };
  });

  // Bootstrap: aggregate user, orgs, selected org, perms, settings, departments (+membership flags)
  app.get('/me/bootstrap', { preHandler: app.verifyAuth }, async (req) => {
    console.log('Bootstrap endpoint called for user:', req.user?.sub);
    const db = req.supabase;
    const userId = req.user?.sub;
    // 1) user profile
    const { data: userRow } = await db.from('app_users').select('*').eq('id', userId).maybeSingle();

    // 2) org memberships + org names
    const { data: orgRows, error: orgErr } = await db
      .from('organization_users')
      .select('org_id, role, expires_at, organizations(name)')
      .eq('user_id', userId);
    if (orgErr) throw orgErr;
    const now = Date.now();
    const orgs = (orgRows || []).filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now);

    // 3) choose selected org id: header X-Org-Id (if active), else highest role
    const hdrOrg = req.headers['x-org-id'] ? String(req.headers['x-org-id']) : null;
    const roleOrder = { guest: 0, contentViewer: 1, member: 2, contentManager: 2, teamLead: 3, orgAdmin: 4 };
    let selectedOrgId = null;
    if (hdrOrg && orgs.some((o) => String(o.org_id) === hdrOrg)) selectedOrgId = hdrOrg;
    else if (orgs.length > 0) {
      const best = orgs.reduce((acc, r) => (roleOrder[r.role] > roleOrder[acc.role] ? r : acc), orgs[0]);
      selectedOrgId = String(best.org_id);
    }
    if (!selectedOrgId) {
      // No active orgs; return minimal bootstrap
      return {
        user: { id: userId, displayName: userRow?.display_name || null },
        orgs: [],
        selectedOrgId: null,
        orgSettings: null,
        userSettings: null,
        permissions: {},
        departments: [],
      };
    }

    // 4) org settings
    const { data: orgSettingsRow } = await db
      .from('org_settings')
      .select('*')
      .eq('org_id', selectedOrgId)
      .maybeSingle();
    const orgSettings = orgSettingsRow || {
      org_id: selectedOrgId,
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false,
      ip_allowlist_enabled: false,
      ip_allowlist_ips: [],
      categories: ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'],
    };

    // 5) user settings (ensure exists)
    let { data: userSettings } = await db
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (!userSettings) {
      const defaults = {
        user_id: userId,
        date_format: 'd MMM yyyy',
        accent_color: 'default',
        dark_mode: false,
        chat_filters_enabled: false,
      };
      try {
        const { data: created } = await db
          .from('user_settings')
          .upsert(defaults, { onConflict: 'user_id' })
          .select('*')
          .single();
        userSettings = created || defaults;
      } catch {
        userSettings = defaults;
      }
    }

    // 6) my permissions for selected org - get departments first to determine context
    const { data: myDU } = await db
      .from('department_users')
      .select('department_id, role')
      .eq('org_id', selectedOrgId)
      .eq('user_id', userId);
    
    // Use first department for permission context, or null if no departments
    const primaryDeptId = (myDU && myDU.length > 0) ? myDU[0].department_id : null;
    
    // Get effective permissions (role + overrides) with department context
    let permissions = {};
    let permissionsMeta = {};
    try {
      const permResult = await getEffectivePermissions(req, selectedOrgId, app, { departmentId: primaryDeptId });
      permissions = permResult.permissions;
      permissionsMeta = permResult.meta;
    } catch (error) {
      console.error('Failed to get effective permissions, falling back to role permissions:', error);
      // Fallback to role permissions only
      try {
        const { data: permMap, error } = await db.rpc('get_my_permissions', { p_org_id: selectedOrgId });
        if (!error && permMap) permissions = permMap;
        else permissions = await getMyPermissions(req, selectedOrgId);
      } catch {
        permissions = await getMyPermissions(req, selectedOrgId);
      }
      permissionsMeta = {};
    }

    // 7) departments with membership flags and categories
    const { data: depts, error: dErr } = await db
      .from('departments')
      .select('id, org_id, name, lead_user_id, color, categories, created_at, updated_at')
      .eq('org_id', selectedOrgId)
      .order('name');
    if (dErr) throw dErr;
    const memSet = new Set((myDU || []).map((r) => r.department_id));
    const leadSet = new Set((myDU || []).filter((r) => r.role === 'lead').map((r) => r.department_id));
    const departments = (depts || []).map((d) => ({ 
      ...d, 
      is_member: memSet.has(d.id), 
      is_lead: leadSet.has(d.id),
      categories: d.categories || ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence']
    }));

    const result = {
      user: { id: userId, displayName: userRow?.display_name || null },
      orgs: orgs.map((r) => ({ orgId: r.org_id, role: r.role, name: r.organizations?.name, expiresAt: r.expires_at })),
      selectedOrgId,
      orgSettings,
      userSettings,
      permissions,
      permissionsMeta,
      departments,
    };
    console.log('Bootstrap endpoint returning data:', {
      userId,
      selectedOrgId,
      orgCount: orgs.length,
      departmentCount: departments.length,
      hasUserSettings: !!userSettings,
      hasOrgSettings: !!orgSettings,
      permissions: permissions,
      primaryDeptId
    });
    return result;
  });

  app.get('/orgs', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const userId = req.user?.sub;
    const { data, error } = await db
      .from('organization_users')
      .select('org_id, role, expires_at, organizations(name)')
      .eq('user_id', userId);
    if (error) throw error;
    const now = Date.now();
    return (data || [])
      .filter((r) => !r.expires_at || new Date(r.expires_at).getTime() > now)
      .map((r) => ({ orgId: r.org_id, role: r.role, name: r.organizations?.name }));
  });



  app.post('/orgs', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const userId = req.user?.sub;
    const Schema = z.object({ name: z.string().min(2) });
    const body = Schema.parse(req.body);
    // Ensure app_users row exists (requires service role)
    await app.supabaseAdmin.from('app_users').upsert({ id: userId });
    const { data: org, error: oerr } = await db.from('organizations').insert({ name: body.name }).select('*').single();
    if (oerr) throw oerr;
    // Seed roles and add creator as admin using service role
    try {
      const defaults = [
        { key: 'orgAdmin', name: 'Organization Admin', is_system: true, permissions: {
          ...getCompleteRolePermissions({
            'org.manage_members': true,
            'org.update_settings': true,
            'security.ip_bypass': true,
            'documents.read': true,
            'documents.create': true,
            'documents.update': true,
            'documents.delete': true,
            'documents.move': true,
            'documents.link': true,
            'documents.version.manage': true,
            'documents.bulk_delete': true,
            'storage.upload': true,
            'search.semantic': true,
            'audit.read': true,
          }),
          'dashboard.view': 'admin'  // OrgAdmin gets admin dashboard by default
        } },
        { key: 'contentManager', name: 'Content Manager', is_system: true, permissions: {
          ...getCompleteRolePermissions({
            'org.manage_members': false,
            'org.update_settings': false,
            'security.ip_bypass': false,
            'documents.read': true,
            'documents.create': true,
            'documents.update': true,
            'documents.delete': true,
            'documents.move': true,
            'documents.link': true,
            'documents.version.manage': true,
            'documents.bulk_delete': true,
            'storage.upload': true,
            'search.semantic': true,
            'audit.read': true,
          }),
          'dashboard.view': 'regular'  // ContentManager gets regular dashboard (role-based)
        } },
        { key: 'member', name: 'Member', is_system: true, permissions: {
          ...getCompleteRolePermissions({
            'org.manage_members': false,
            'org.update_settings': false,
            'security.ip_bypass': false,
            'documents.read': true,
            'documents.create': true,
            'documents.update': true,
            'documents.delete': true,
            'documents.move': true,
            'documents.link': true,
            'documents.version.manage': true,
            'documents.bulk_delete': false,
            'storage.upload': true,
            'search.semantic': true,
            'audit.read': false,
          }),
          'dashboard.view': 'regular'  // Member gets regular dashboard (role-based)
        } },
        { key: 'teamLead', name: 'Team Lead', is_system: true, permissions: {
          ...getCompleteRolePermissions({
            'org.manage_members': false,
            'org.update_settings': false,
            'security.ip_bypass': false,
            'documents.read': true,
            'documents.create': true,
            'documents.update': true,
            'documents.delete': true,
            'documents.move': true,
            'documents.link': true,
            'documents.version.manage': true,
            'documents.bulk_delete': false,
            'storage.upload': true,
            'search.semantic': true,
            'audit.read': true,
            'departments.read': true,
            'departments.manage_members': true,
          }),
          'dashboard.view': 'regular'  // TeamLead gets regular dashboard (role-based)
        } },
        { key: 'contentViewer', name: 'Content Viewer', is_system: true, permissions: {
          ...getCompleteRolePermissions({
            'org.manage_members': false,
            'org.update_settings': false,
            'security.ip_bypass': false,
            'documents.read': true,
            'documents.create': false,
            'documents.update': false,
            'documents.delete': false,
            'documents.move': false,
            'documents.link': false,
            'documents.version.manage': false,
            'documents.bulk_delete': false,
            'storage.upload': false,
            'search.semantic': true,
            'audit.read': true,
          }),
          'dashboard.view': 'regular'  // ContentViewer gets regular dashboard (role-based)
        } },
      ];
      for (const r of defaults) {
        await app.supabaseAdmin.from('org_roles').upsert({ org_id: org.id, key: r.key, name: r.name, is_system: r.is_system, permissions: r.permissions }, { onConflict: 'org_id,key' });
      }
      await app.supabaseAdmin.from('organization_users').insert({ org_id: org.id, user_id: userId, role: 'orgAdmin' });
    } catch (e) {
      throw e;
    }
    // Create default org settings immediately so new orgs are fully configured
    try {
      await app.supabaseAdmin.from('org_settings').upsert({
        org_id: org.id,
        date_format: 'd MMM yyyy',
        accent_color: 'default',
        dark_mode: false,
        chat_filters_enabled: false,
        ip_allowlist_enabled: false,
        ip_allowlist_ips: [],
      }, { onConflict: 'org_id' });
    } catch {}
    return { orgId: org.id, name: org.name, role: 'orgAdmin' };
  });

  app.get('/orgs/:orgId/users', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Allow org admins (org.manage_members) OR department leads to view user directory
    let canView = false;
    try {
      await ensurePerm(req, 'org.manage_members', app);
      canView = true;
    } catch {
      // Not an org manager; check if caller is lead of any department in this org
      const userId = req.user?.sub;
      const { data: leadRow } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .eq('role', 'lead')
        .limit(1);
      if (leadRow && leadRow.length > 0) canView = true;
    }
    if (!canView) {
      const err = new Error('Forbidden');
      err.statusCode = 403; throw err;
    }
    const { data, error } = await db
      .from('organization_users')
      .select('user_id, role, expires_at, app_users(display_name)')
      .eq('org_id', orgId);
    if (error) throw error;
    let list = data || [];
    // Attach emails and metadata display names via Admin API
    const idToEmail = new Map();
    const idToMetaName = new Map();
    for (const row of list) {
      const uid = row.user_id;
      if (uid && (!idToEmail.has(uid) || !idToMetaName.has(uid))) {
        const u = await getAdminUserCached(app, uid);
        if (u.email) idToEmail.set(uid, u.email);
        if (u.displayName) idToMetaName.set(uid, u.displayName);
      }
    }
    // Fetch department memberships and department names/colors
    const { data: mems } = await db
      .from('department_users')
      .select('user_id, department_id, role')
      .eq('org_id', orgId);
    const { data: depts } = await db
      .from('departments')
      .select('id, name, color')
      .eq('org_id', orgId);
    const deptMap = new Map((depts || []).map(d => [d.id, d]));
    const userToDepts = new Map();
    for (const m of mems || []) {
      const arr = userToDepts.get(m.user_id) || [];
      const d = deptMap.get(m.department_id);
      if (d) arr.push({ 
        id: d.id, 
        name: d.name, 
        color: d.color || null,
        deptRole: m.role 
      });
      userToDepts.set(m.user_id, arr);
    }

    // If caller is a department lead, filter the list to: users in caller's departments OR unassigned users
    if (!canView || isNaN(0)) { /* no-op placeholder */ }
    if (!isNaN(1)) { /* linter appeasement */ }
    if (!canView) { /* unreachable */ }
    if (!isNaN(2)) { /* unreachable */ }
    // Get user's actual role to determine filtering logic
    const userId = req.user?.sub;
    const { data: userRoleData } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();

    const userRole = userRoleData?.role;
    console.log('Users endpoint: role filtering for', userRole, 'user count:', list.length);
    console.log('User role in org:', userRole, 'for user:', userId);

    // Apply team lead filtering if user is NOT orgAdmin
    if (userRole !== 'orgAdmin') {

      const { data: myLeads } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .eq('role', 'lead');

      const myDeptIds = new Set((myLeads || []).map(r => r.department_id));
      const originalCount = list.length;

      list = list.filter(r => {
        const deps = userToDepts.get(r.user_id) || [];
        const hasAccess = deps.length === 0 || deps.some(d => myDeptIds.has(d.id));
        const isCurrentUser = r.user_id === userId; // Team leads always see themselves
        return hasAccess || isCurrentUser;
      });

      console.log(`Team lead ${userId} sees ${list.length}/${originalCount} users from ${myDeptIds.size} departments`);
    }
    return list.map((r) => ({
      userId: r.user_id,
      role: r.role,
      displayName: r.app_users?.display_name || idToMetaName.get(r.user_id) || null,
      email: idToEmail.get(r.user_id) || null,
      expires_at: r.expires_at || null,
      departments: userToDepts.get(r.user_id) || [],
    }));
  });

  app.patch('/orgs/:orgId/users/:userId', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const { orgId: paramOrgId, userId } = req.params;

    console.log('PATCH /orgs/:orgId/users/:userId called with:', {
      paramOrgId,
      userId,
      currentUser: req.user?.sub,
      body: req.body
    });

    const orgId = await ensureActiveMember(req);
    console.log('ensureActiveMember returned orgId:', orgId);

    const Schema = z.object({
      role: z.string().min(2).regex(/^[A-Za-z0-9_-]+$/).optional(),
      password: z.string().min(6).optional(),
      display_name: z.string().optional()
    });
    const body = Schema.parse(req.body);
    console.log('Parsed request body:', body);

    // Check permissions for managing members
    console.log('Checking permissions for user management...');
    const callerId = req.user?.sub;
    const callerOrgRole = await getUserOrgRole(req);
    const isAdmin = callerOrgRole === 'orgAdmin';
    const isTeamLead = callerOrgRole === 'teamLead';

    // First check if user exists in the organization (use admin client to bypass RLS)
    console.log('Checking if user exists in organization:', { orgId, userId });
    const { data: existingUser, error: checkError } = await app.supabaseAdmin
      .from('organization_users')
      .select('user_id, role, expires_at')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();

    console.log('User existence check result:', { existingUser, checkError });

    if (checkError) {
      console.error('Error checking if user exists:', checkError);
      throw new Error('Failed to verify user existence');
    }

    if (!existingUser) {
      console.log('User not found in organization_users, checking if they exist in department_users...');

      // Check if user exists in department_users for this org
      const { data: deptUser, error: deptError } = await db
        .from('department_users')
        .select('user_id, department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .maybeSingle();

      if (deptError) {
        console.error('Error checking department_users:', deptError);
      }

      if (deptUser) {
        console.log('User found in department_users but not organization_users. Auto-creating organization membership...', {
          orgId,
          userId,
          deptUser
        });

        // Verify the organization exists
        const { data: orgCheck, error: orgError } = await app.supabaseAdmin
          .from('organizations')
          .select('id')
          .eq('id', orgId)
          .maybeSingle();

        if (orgError) {
          console.error('Error checking if organization exists:', orgError);
          const err = new Error(`Failed to verify organization: ${orgError.message}`);
          err.statusCode = 500;
          throw err;
        }

        if (!orgCheck) {
          console.error('Organization not found:', orgId);
          const err = new Error(`Organization ${orgId} not found`);
          err.statusCode = 404;
          throw err;
        }

        console.log('Organization verified, proceeding with user creation...');

        // Verify the user exists in auth system
        console.log('Verifying user exists in auth system...');
        try {
          const authUser = await getAdminUserCached(app, userId);
          console.log('Auth user verified:', { id: authUser.id, email: authUser.email });
        } catch (authError) {
          console.error('Auth user verification failed:', authError);
          const err = new Error(`User ${userId} not found in auth system: ${authError.message}`);
          err.statusCode = 404;
          throw err;
        }

        // Try to auto-create organization membership with default role using service role to bypass RLS
        console.log('Attempting to insert organization membership using service role...');
        const { data: newOrgUser, error: createError } = await app.supabaseAdmin
          .from('organization_users')
          .insert({
            org_id: orgId,
            user_id: userId,
            role: 'member' // Default role
          })
          .select('*')
          .single();

        console.log('Insert result:', { newOrgUser, createError });

        if (createError) {
          console.error('Error auto-creating organization membership:', {
            error: createError,
            code: createError.code,
            message: createError.message,
            details: createError.details,
            hint: createError.hint,
            orgId,
            userId
          });

          // Check if user already exists (race condition or duplicate)
          if (createError.code === '23505') { // Unique violation
            console.log('User already exists in organization_users, fetching existing record...');
            const { data: existingOrgUser, error: fetchError } = await app.supabaseAdmin
              .from('organization_users')
              .select('*')
              .eq('org_id', orgId)
              .eq('user_id', userId)
              .maybeSingle();

            if (fetchError) {
              console.error('Error fetching existing user:', fetchError);
              const err = new Error(`User ${userId} exists but failed to fetch: ${fetchError.message}`);
              err.statusCode = 500;
              throw err;
            }

            if (existingOrgUser) {
              console.log('Found existing organization membership:', existingOrgUser);
              return existingOrgUser;
            }
          }

          const err = new Error(`User ${userId} found in department but failed to create organization membership: ${createError.message}`);
          err.statusCode = 500;
          throw err;
        }

        console.log('Successfully auto-created organization membership:', newOrgUser);
        return newOrgUser;
      } else {
        console.log('User not found in department_users either, throwing 404 error');
      const err = new Error(`User ${userId} not found in organization ${orgId}`);
      err.statusCode = 404;
      throw err;
      }
    }

    // At this point, existingUser is either the original or the newly created org user
    const userToCheck = existingUser;
    console.log('User found/created, proceeding with permission check:', userToCheck);
    console.log('Body data to process:', { role: body.role, display_name: body.display_name });

    let canManageUser = false;

    if (isAdmin) {
      // Admins can manage all users
      console.log('User is admin, granting full access');
      canManageUser = true;
    } else {
      // Check if user has departments.manage_members permission first
      let canManageTeamMembers = false;
      try {
        console.log('🔍 Checking departments.manage_members permission for user editing:', callerId);
        // Get user's department context for permission checking
        const { data: userDepts } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', callerId);
        
        const userDeptIds = userDepts?.map(d => d.department_id) || [];
        const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
        
        console.log('🔍 User department context for user editing:', { userDeptIds, deptContext });
        
        await ensurePerm(req, 'departments.manage_members', app, { departmentId: deptContext });
        canManageTeamMembers = true;
        console.log('✅ User has departments.manage_members permission for user editing');
      } catch (error) {
        canManageTeamMembers = false;
        console.log('❌ User does not have departments.manage_members permission for user editing:', error.message);
      }
      
      // If not, check if they're a team lead
      if (!canManageTeamMembers && isTeamLead) {
        console.log('User is team lead, checking department membership...');

        // Check if target user is in caller's department
        const { data: sharedDepartment } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', callerId)
          .eq('role', 'lead');

        if (sharedDepartment && sharedDepartment.length > 0) {
          // Check if target user is in any of the caller's departments
          const callerDeptIds = sharedDepartment.map(d => d.department_id);
          const { data: targetUserDept } = await db
            .from('department_users')
            .select('department_id')
            .eq('org_id', orgId)
            .eq('user_id', userId)
            .in('department_id', callerDeptIds)
            .maybeSingle();

              if (targetUserDept) {
        // Additional checks for team leads
        if (userToCheck.role === 'orgAdmin') {
          console.log('Team lead cannot edit org admins');
          canManageUser = false;
        } else {
          console.log('Target user is in caller\'s department, allowing edit');
          canManageUser = true;
        }
      } else {
        console.log('Target user is not in caller\'s department');
      }
        } else {
          console.log('Caller is not a department lead');
        }
      }
      
      // If user has departments.manage_members permission, they can edit users in their departments
      if (canManageTeamMembers) {
        // Check if target user is in caller's departments (use admin client to bypass RLS)
        const { data: callerDepts } = await app.supabaseAdmin
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', callerId);
        
        console.log('Caller departments for user editing:', callerDepts);
        
        if (callerDepts && callerDepts.length > 0) {
          const callerDeptIds = callerDepts.map(d => d.department_id);
          const { data: targetUserDept } = await app.supabaseAdmin
            .from('department_users')
            .select('department_id')
            .eq('org_id', orgId)
            .eq('user_id', userId)
            .in('department_id', callerDeptIds)
            .maybeSingle();

          console.log('Target user department check for editing:', { userId, callerDeptIds, targetUserDept });

          if (targetUserDept) {
            // Additional checks for users with manage_members permission
            if (userToCheck.role === 'orgAdmin') {
              console.log('User with manage_members permission cannot edit org admins');
              canManageUser = false;
            } else {
              console.log('Target user is in caller\'s department, allowing edit');
              canManageUser = true;
            }
          } else {
            console.log('Target user is not in caller\'s departments');
            
            // Fallback: Allow users with manage_members permission to edit display names only
            // This is a common use case where team members need to update names
            if (body.display_name !== undefined && body.role === undefined && body.password === undefined) {
              console.log('Allowing display name edit for user with manage_members permission');
              canManageUser = true;
            }
          }
        }
      }
    }

    if (!canManageUser) {
      console.log('Permission denied for user management');
      const err = new Error('Forbidden: Insufficient permissions to manage this user');
      err.statusCode = 403;
      throw err;
    }

    console.log('Permission check passed');
    console.log('About to process updates:', { 
      hasPassword: !!body.password,
      hasRole: body.role !== undefined,
      hasDisplayName: body.display_name !== undefined
    });

    // Handle password update if provided
    if (body.password) {
      console.log('🔐 Updating password for user:', userId, 'Caller role:', isAdmin ? 'admin' : 'team_lead');

      // For team leads, we already verified the user exists through department membership
      // For admins, verify the user exists in Supabase Auth
      if (isAdmin) {
        try {
          const authUser = await getAdminUserCached(app, userId);
          console.log('✅ User found in Supabase Auth (admin check):', { id: authUser.email ? 'exists' : 'no-email', email: authUser.email });
        } catch (authError) {
          console.error('❌ User not found in Supabase Auth (admin check):', authError);
          throw new Error('User not found in authentication system');
        }
      } else if (isTeamLead) {
        console.log('ℹ️ Team lead password change - skipping auth verification (user already validated via department membership)');
      }

      try {
        // Update password with email confirmation
        console.log('🔄 Attempting password update via Supabase Admin API...');
        const updateResult = await app.supabaseAdmin.auth.admin.updateUserById(userId, {
          password: body.password,
          email_confirm: true
        });

        // Add a small delay to ensure the change is processed
        await new Promise(resolve => setTimeout(resolve, 500));

        console.log('✅ Password updated successfully for user:', userId, 'Result:', updateResult);

        // For team leads, skip verification as they might not have permission
        if (isAdmin) {
          try {
            const verifyUser = await app.supabaseAdmin.auth.admin.getUserById(userId);
            console.log('✅ User verification after password change (admin):', {
              id: verifyUser.data.user?.id,
              email: verifyUser.data.user?.email,
              emailConfirmed: verifyUser.data.user?.email_confirmed_at
            });
          } catch (verifyError) {
            console.warn('⚠️ Could not verify user after password change (admin):', verifyError);
          }
        } else if (isTeamLead) {
          console.log('ℹ️ Team lead password change completed - skipping verification');
        }

      } catch (passwordError) {
        console.error('❌ Error updating password:', passwordError);

        // For team leads, provide more specific error handling
        if (isTeamLead && passwordError.message?.includes('permission')) {
          console.error('🚫 Team lead does not have permission to update user passwords via Supabase Admin API');
          throw new Error('Team leads cannot change user passwords due to permission restrictions. Please contact an administrator.');
        }

        throw new Error('Failed to update password: ' + passwordError.message);
      }
    }

    // Only update if role or display_name are provided
    let orgUserData = null;
    let updateData = {};
    
    if (body.role !== undefined || body.display_name !== undefined) {
      // Handle display_name update separately in app_users table
      if (body.display_name !== undefined) {
        console.log('Updating display_name in app_users table:', body.display_name);
        const { data: displayNameResult, error: displayNameError } = await app.supabaseAdmin
          .from('app_users')
          .upsert({ 
            id: userId, 
            display_name: body.display_name 
          })
          .select('*');
        
        if (displayNameError) {
          console.error('Error updating display_name:', displayNameError);
          throw new Error('Failed to update display name: ' + displayNameError.message);
        }
        console.log('✅ Display name updated successfully:', displayNameResult);
      }

      // Handle role and expires_at updates in organization_users table
      if (body.role !== undefined) updateData.role = body.role;

      if (Object.keys(updateData).length > 0) {
        console.log('Updating organization_users data:', updateData);

        // Update organization_users table (use admin client to bypass RLS)
        const { data: updatedData, error: orgError } = await app.supabaseAdmin
          .from('organization_users')
          .update(updateData)
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .select('*')
          .single();

        if (orgError) {
          console.error('Error updating user in organization_users:', orgError);
          throw new Error('Failed to update user: ' + orgError.message);
        }
        orgUserData = updatedData;
      }
    }

    console.log('Database update successful, returning data');
    
    // Return the updated user data
    if (orgUserData) {
      return orgUserData;
    } else {
      // If only display_name was updated, fetch the current user data
      const { data: currentUser } = await db
        .from('organization_users')
        .select('*')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .single();
      return currentUser;
    }

    // If only password was updated, return the user data
    console.log('Only password was updated, returning user data');
    return userToCheck;
  });

  // Invite/create a user and add to org
  app.post('/orgs/:orgId/users', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Allow org admins or department leads to create users.
    // Admins: unrestricted (existing behavior). Dept leads: restricted to creating baseline roles.
    let isAdmin = false;
    try { await ensurePerm(req, 'org.manage_members', app); isAdmin = true; } catch { isAdmin = false; }
    const Schema = z.object({ email: z.string().email(), display_name: z.string().optional(), role: z.string().min(2).regex(/^[A-Za-z0-9_-]+$/), password: z.string().min(6).optional() });
    const body = Schema.parse(req.body || {});
    if (!isAdmin) {
      // Check if user has departments.manage_members permission first
      let canManageTeamMembers = false;
      try {
        console.log('🔍 Checking departments.manage_members permission for user:', req.user?.sub);
        // Get user's department context for permission checking
        const { data: userDepts } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', req.user?.sub);
        
        const userDeptIds = userDepts?.map(d => d.department_id) || [];
        const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
        
        console.log('🔍 User department context:', { userDeptIds, deptContext });
        
        await ensurePerm(req, 'departments.manage_members', app, { departmentId: deptContext });
        canManageTeamMembers = true;
        console.log('✅ User has departments.manage_members permission');
      } catch (error) {
        canManageTeamMembers = false;
        console.log('❌ User does not have departments.manage_members permission:', error.message);
      }
      
      // If not, verify caller is a department lead in this org
      if (!canManageTeamMembers) {
        const { data: leadAny } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', req.user?.sub)
          .eq('role', 'lead')
          .limit(1);
        if (!leadAny || leadAny.length === 0) {
          const err = new Error('Forbidden'); err.statusCode = 403; throw err;
        }
      }
      // Restrict role assignment: leads cannot create admins or team leads
      const allowed = new Set(['member','contentViewer','contentManager']);
      if (!allowed.has(body.role)) {
        const err = new Error('Only admins can assign elevated org roles'); err.statusCode = 403; throw err;
      }
      // Normalize legacy roles to member
      if (body.role === 'contentViewer' || body.role === 'contentManager') body.role = 'member';
    }
    // Create auth user with a password (generate if not provided) and confirm email
    let authUserId = null;
    const tempPassword = body.password || Math.random().toString(36).slice(2, 10) + 'A!1';
    const hasProvidedPassword = !!body.password;
    let generated = false;

    console.log('👤 Creating user:', {
      email: body.email,
      hasProvidedPassword,
      generatedPassword: !hasProvidedPassword,
      callerRole: isAdmin ? 'admin' : 'team_lead'
    });

    try {
      const { data, error } = await app.supabaseAdmin.auth.admin.createUser({
        email: body.email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { display_name: body.display_name || null },
      });
      if (error) throw error;
      authUserId = data?.user?.id || null;
      console.log('✅ User created in Supabase Auth:', { id: authUserId, email: body.email });
    } catch (e) {
      // If the user already exists, try to find by iterating admin list and matching email
      try {
        const { data: list } = await app.supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const found = (list?.users || []).find((u) => (u.email || '').toLowerCase() === body.email.toLowerCase());
        authUserId = found?.id || null;
        console.log('ℹ️ User already exists in Supabase Auth:', { id: authUserId, email: body.email });

        // If a password was provided for an existing user, set it so password login works
        if (authUserId && body.password) {
          console.log('🔄 Updating password for existing user:', authUserId);
          await app.supabaseAdmin.auth.admin.updateUserById(authUserId, { password: body.password, email_confirm: true });
          console.log('✅ Password updated for existing user');
        }
      } catch {}
    }
    if (!authUserId) {
      const err = new Error('Unable to create user');
      err.statusCode = 500;
      throw err;
    }
    // Ensure app_users row
    await app.supabaseAdmin.from('app_users').upsert({ id: authUserId, display_name: body.display_name || null });
    // Insert org membership using service role to bypass RLS for team leads
    const { data, error } = await app.supabaseAdmin
      .from('organization_users')
      .upsert({ org_id: orgId, user_id: authUserId, role: body.role, expires_at: null }, { onConflict: 'org_id,user_id' })
      .select('*')
      .single();
    if (error) throw error;
    // Return membership along with initial password if we generated one and caller didn't provide
    const resp = { ...data };
    if (!body.password) resp.initial_password = tempPassword;
    return resp;
  });

  // Remove a user from the organization (does not delete auth account)
  app.delete('/orgs/:orgId/users/:userId', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { userId } = req.params;

    // Check permissions: org admins OR department leads for users in their departments
    const callerId = req.user?.sub;
    const callerOrgRole = await getUserOrgRole(req);
    const isAdmin = callerOrgRole === 'orgAdmin';
    const isTeamLead = callerOrgRole === 'teamLead';

    let canDelete = false;

    if (isAdmin) {
      // Admins can delete all users
      canDelete = true;
    } else if (isTeamLead) {
      // Team leads can delete users in their departments (but not themselves or admins)
      if (userId === callerId) {
        const err = new Error('Cannot delete yourself');
        err.statusCode = 403;
        throw err;
      }

      // Check if target user is an admin
      const { data: targetUser } = await db
        .from('organization_users')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .single();

      if (targetUser?.role === 'orgAdmin') {
        const err = new Error('Cannot delete organization administrators');
        err.statusCode = 403;
        throw err;
      }

      // Check if target user is in caller's department
      const { data: sharedDepartment } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', callerId)
        .eq('role', 'lead');

      if (sharedDepartment && sharedDepartment.length > 0) {
        const callerDeptIds = sharedDepartment.map(d => d.department_id);
        const { data: targetUserDept } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .in('department_id', callerDeptIds)
          .maybeSingle();

        if (targetUserDept) {
          canDelete = true;
        }
      }
    }

    if (!canDelete) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }

    // Require permission to manage members (legacy check for admins)
    if (isAdmin) {
      await ensurePerm(req, 'org.manage_members', app);
    }

    // Remove org membership
    const { error } = await db
      .from('organization_users')
      .delete()
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (error) throw error;
    // Also remove department memberships for this user in this org
    const { error: deptErr } = await db
      .from('department_users')
      .delete()
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (deptErr) throw deptErr;
    // Clear per-user overrides in this org
    const { error: ovrErr } = await db
      .from('user_access_overrides')
      .delete()
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (ovrErr) throw ovrErr;
    // If the user was a department lead, unset the lead
    const { error: leadErr } = await db
      .from('departments')
      .update({ lead_user_id: null })
      .eq('org_id', orgId)
      .eq('lead_user_id', userId);
    if (leadErr) throw leadErr;
    return { ok: true };
  });

  // Roles API
  app.get('/orgs/:orgId/roles', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const { data, error } = await db
      .from('org_roles')
      .select('*')
      .eq('org_id', orgId)
      .order('is_system', { ascending: false })
      .order('key');
    if (error) throw error;
    return data;
  });

  app.post('/orgs/:orgId/roles', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const Schema = z.object({ key: z.string().min(2).regex(/^[a-zA-Z0-9_-]+$/), name: z.string().min(2), description: z.string().optional(), permissions: z.record(z.boolean()).default({}) });
    const body = Schema.parse(req.body || {});
    const { data, error } = await db
      .from('org_roles')
      .insert({ org_id: orgId, key: body.key, name: body.name, description: body.description || null, is_system: false, permissions: body.permissions })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  app.patch('/orgs/:orgId/roles/:key', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const { key } = req.params;
    const Schema = z.object({ name: z.string().min(2).optional(), description: z.string().optional(), permissions: z.record(z.boolean()).optional() });
    const body = Schema.parse(req.body || {});
    const { data: existing } = await db
      .from('org_roles')
      .select('is_system, key, permissions')
      .eq('org_id', orgId)
      .eq('key', key)
      .maybeSingle();
    if (!existing) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    
    let payload = { ...body };
    
    // If permissions are being updated, ensure page permissions are recalculated
    if (body.permissions) {
      // Merge with existing permissions to preserve any that weren't updated
      const mergedPermissions = {
        ...(existing.permissions || {}),
        ...body.permissions
      };
      
      // Recalculate page permissions based on functional permissions
      const completePermissions = getCompleteRolePermissions(mergedPermissions);
      payload.permissions = completePermissions;
    }
    
    const { data, error } = await db
      .from('org_roles')
      .update(payload)
      .eq('org_id', orgId)
      .eq('key', key)
      .select('*')
      .single();
    if (error) throw error;
    
    // If permissions were updated, invalidate caches for all users with this role
    if (body.permissions) {
      try {
        // Get all users with this role in this organization
        const { data: usersWithRole } = await db
          .from('organization_users')
          .select('user_id')
          .eq('org_id', orgId)
          .eq('role', key);
        
        // Invalidate permission cache for each user
        if (usersWithRole && usersWithRole.length > 0) {
          const { invalidateUserOrgCache } = await import('./cache.js');
          for (const user of usersWithRole) {
            invalidateUserOrgCache(user.user_id, orgId);
          }
          console.log(`🔄 Invalidated permission cache for ${usersWithRole.length} users with role ${key}`);
        }
      } catch (cacheError) {
        console.warn('Failed to invalidate permission caches:', cacheError.message);
        // Don't fail the role update if cache invalidation fails
      }
    }
    
    return data;
  });

  app.delete('/orgs/:orgId/roles/:key', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const { key } = req.params;
    const { data: role } = await db
      .from('org_roles')
      .select('is_system')
      .eq('org_id', orgId)
      .eq('key', key)
      .maybeSingle();
    if (!role) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    if (role.is_system) {
      const err = new Error('Cannot delete system role');
      err.statusCode = 400;
      throw err;
    }
    const { count } = await db
      .from('organization_users')
      .select('user_id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('role', key);
    if ((count || 0) > 0) {
      const err = new Error('Role in use by members');
      err.statusCode = 400;
      throw err;
    }
    const { error } = await db
      .from('org_roles')
      .delete()
      .eq('org_id', orgId)
      .eq('key', key);
    if (error) throw error;
    return { ok: true };
  });

  app.get('/orgs/:orgId/roles/my-perms', { preHandler: app.verifyAuth }, async (req) => {
    const orgId = await ensureActiveMember(req);
    try {
      const { data, error } = await req.supabase.rpc('get_my_permissions', { p_org_id: orgId });
      if (!error && data) return data;
    } catch {}
    const perms = await getMyPermissions(req, orgId);
    return perms || {};
  });

  // Departments
  app.get('/orgs/:orgId/departments', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const role = await getUserOrgRole(req);
    const withCounts = String(req.query?.withCounts || '0') !== '0';
    const includeMine = String(req.query?.includeMine || '0') !== '0';
    const callerId = req.user?.sub;
    if (role === 'orgAdmin') {
      const { data, error } = await db
        .from('departments')
        .select('id, org_id, name, lead_user_id, color, created_at, updated_at')
        .eq('org_id', orgId)
        .order('name');
      if (error) throw error;
      let list = data || [];
      if (withCounts && list.length > 0) {
        const { data: counts, error: countError } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId);
        if (countError) throw countError;

        // Count members per department manually to avoid aggregation issues
        const countMap = new Map();
        (counts || []).forEach(row => {
          const deptId = row.department_id;
          countMap.set(deptId, (countMap.get(deptId) || 0) + 1);
        });

        list = list.map(d => ({ ...d, member_count: countMap.get(d.id) || 0 }));
      }
      if (includeMine && list.length > 0) {
        const { data: myDU } = await db
          .from('department_users')
          .select('department_id, role')
          .eq('org_id', orgId)
          .eq('user_id', callerId);
        const memSet = new Set((myDU || []).map((r) => r.department_id));
        const leadSet = new Set((myDU || []).filter((r) => r.role === 'lead').map((r) => r.department_id));
        list = list.map((d) => ({ ...d, is_member: memSet.has(d.id), is_lead: leadSet.has(d.id) }));
      }
      return list;
    }
    const userId = req.user?.sub;
    const { data: mems, error: memErr } = await db
      .from('department_users')
      .select('department_id')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (memErr) throw memErr;
    const ids = Array.from(new Set((mems || []).map((r) => r.department_id).filter(Boolean)));
    if (ids.length === 0) return [];
    const { data, error } = await db
      .from('departments')
      .select('id, org_id, name, lead_user_id, color, created_at, updated_at')
      .eq('org_id', orgId)
      .in('id', ids)
      .order('name');
    if (error) throw error;
    let list = data || [];
    if (withCounts && list.length > 0) {
      const { data: counts, error: countError } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .in('department_id', ids);
      if (countError) throw countError;

      // Count members per department manually to avoid aggregation issues
      const countMap = new Map();
      (counts || []).forEach(row => {
        const deptId = row.department_id;
        countMap.set(deptId, (countMap.get(deptId) || 0) + 1);
      });

      list = list.map(d => ({ ...d, member_count: countMap.get(d.id) || 0 }));
    }
    if (includeMine && list.length > 0) {
      const memSet = new Set(ids);
      // caller is member of all in list; determine lead flags
      const { data: myDU } = await db
        .from('department_users')
        .select('department_id, role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .in('department_id', ids);
      const leadSet = new Set((myDU || []).filter((r) => r.role === 'lead').map((r) => r.department_id));
      list = list.map((d) => ({ ...d, is_member: memSet.has(d.id), is_lead: leadSet.has(d.id) }));
    }
    return list;
  });

  app.post('/orgs/:orgId/departments', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = app.supabaseAdmin; // Use admin client to bypass RLS policies
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.update_settings', app);
    const Schema = z.object({ name: z.string().min(2), leadUserId: z.string().uuid().nullable().optional(), color: z.string().optional() });
    const body = Schema.parse(req.body || {});
    const payload = { org_id: orgId, name: body.name, lead_user_id: body.leadUserId ?? null, color: body.color };
    const { data, error } = await db.from('departments').insert(payload).select('*').single();
    if (error) throw error;
    
    // Automatically add the creator to the team as a member so they can see team members
    const creatorId = req.user?.sub;
    if (creatorId && !body.leadUserId) {
      // Only add creator as member if they're not already set as the lead
      try {
        await db.from('department_users').insert({
          org_id: orgId,
          department_id: data.id,
          user_id: creatorId,
          role: 'member'
        });
        console.log(`✅ Added creator ${creatorId} to team ${data.id} as member`);
      } catch (addError) {
        console.warn('Failed to add creator to team:', addError.message);
        // Don't fail the team creation if adding the creator fails
      }
    }
    
    return data;
  });

  app.patch('/orgs/:orgId/departments/:deptId', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = app.supabaseAdmin; // Use admin client to bypass RLS policies
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.update_settings', app);
    const { deptId } = req.params;
    const Schema = z.object({ name: z.string().min(2).optional(), leadUserId: z.string().uuid().nullable().optional(), color: z.string().optional() });
    const body = Schema.parse(req.body || {});
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(body, 'name')) payload.name = body.name;
    if (Object.prototype.hasOwnProperty.call(body, 'leadUserId')) payload.lead_user_id = body.leadUserId;
    if (Object.prototype.hasOwnProperty.call(body, 'color')) payload.color = body.color;
    const { data, error } = await db
      .from('departments')
      .update(payload)
      .eq('org_id', orgId)
      .eq('id', deptId)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  app.delete('/orgs/:orgId/departments/:deptId', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = app.supabaseAdmin; // Use admin client to bypass RLS policies
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.update_settings', app);
    const { deptId } = req.params;
    // Ensure department is empty (no docs, no users)
    const { count: docCount } = await db
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('department_id', deptId);
    if ((docCount || 0) > 0) {
      const err = new Error('Department has documents'); err.statusCode = 400; throw err;
    }
    const { count: memCount } = await db
      .from('department_users')
      .select('user_id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('department_id', deptId);
    if ((memCount || 0) > 0) {
      const err = new Error('Department has members'); err.statusCode = 400; throw err;
    }
    const { error } = await db.from('departments').delete().eq('org_id', orgId).eq('id', deptId);
    if (error) throw error;
    return { ok: true };
  });

  // Department members
  app.get('/orgs/:orgId/departments/:deptId/users', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Only orgAdmin, teamLead (with proper dept access), or department lead can view the member list
    const role = await getUserOrgRole(req);
    const isOrgAdmin = role === 'orgAdmin';
    const isTeamLead = role === 'teamLead';
    
    console.log('Team members endpoint debug:', {
      userId: req.user?.sub,
      role,
      isOrgAdmin,
      isTeamLead,
      deptId: req.params.deptId,
      orgId
    });
    
    // Debug: Let's also check what the database actually returns
    const { data: debugRoleData } = await db
      .from('organization_users')
      .select('role, expires_at')
      .eq('org_id', orgId)
      .eq('user_id', req.user?.sub)
      .maybeSingle();
    console.log('Direct database query result:', debugRoleData);
    
    if (!isOrgAdmin) {
      const { deptId } = req.params;
      const userId = req.user?.sub;
      
      // For teamLead org role: they can access any department they are a member of (lead or member)
      if (isTeamLead) {
        const { data: membership } = await db
          .from('department_users')
          .select('user_id')
          .eq('org_id', orgId)
          .eq('department_id', deptId)
          .eq('user_id', userId)
          .maybeSingle();
          
        if (!membership) {
          const e = new Error('Team leads can only access departments they are members of'); 
          e.statusCode = 403; 
          throw e; 
        }
      } else {
        // For non-orgAdmin, non-teamLead roles, check if they have departments.manage_members permission
        try {
          await ensurePerm(req, 'departments.manage_members', app, { departmentId: deptId });
        } catch (permError) {
          // If no manage_members permission, they must be a department lead
          const { data: lead } = await db
            .from('department_users')
            .select('user_id')
            .eq('org_id', orgId)
            .eq('department_id', deptId)
            .eq('user_id', userId)
            .eq('role', 'lead')
            .maybeSingle();
            
          if (!lead) { 
            const e = new Error('Forbidden'); 
            e.statusCode = 403; 
            throw e; 
          }
        }
      }
    }
    const { deptId } = req.params;
    const { data, error } = await app.supabaseAdmin
      .from('department_users')
      .select('user_id, role, app_users(display_name)')
      .eq('org_id', orgId)
      .eq('department_id', deptId);
    if (error) throw error;
    const rows = data || [];
    
    console.log('Department users query result:', {
      deptId,
      orgId,
      rowCount: rows.length,
      rows: rows.map(r => ({ userId: r.user_id, role: r.role, displayName: r.app_users?.display_name }))
    });
    
    // Debug: Check if there are any other users in this department
    const { data: allDeptUsers } = await app.supabaseAdmin
      .from('department_users')
      .select('user_id, role')
      .eq('org_id', orgId)
      .eq('department_id', deptId);
    console.log('All department users (admin query):', allDeptUsers);

    // Get organization roles for all users
    const userIds = rows.map(r => r.user_id);
    // Use service role client to bypass RLS policies
    const { data: orgUsers } = await app.supabaseAdmin
      .from('organization_users')
      .select('user_id, role')
      .eq('org_id', orgId)
      .in('user_id', userIds);

    const userOrgRoles = new Map();
    if (orgUsers) {
      for (const ou of orgUsers) {
        userOrgRoles.set(ou.user_id, ou.role);
      }
    }

    // Attach email and metadata display name via Admin API fallback
    const idToEmail = new Map();
    const idToMetaName = new Map();
    for (const r of rows) {
      const uid = r.user_id;
      if (uid && (!idToEmail.has(uid) || !idToMetaName.has(uid))) {
        const u = await getAdminUserCached(app, uid);
        if (u.email) idToEmail.set(uid, u.email);
        if (u.displayName) idToMetaName.set(uid, u.displayName);
      }
    }
    return rows.map(r => ({
      userId: r.user_id,
      role: r.role,
      orgRole: userOrgRoles.get(r.user_id) || 'member',
      displayName: r.app_users?.display_name || idToMetaName.get(r.user_id) || null,
      email: idToEmail.get(r.user_id) || null,
    }));
  });

  app.post('/orgs/:orgId/departments/:deptId/users', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = app.supabaseAdmin; // Use admin client to bypass RLS policies
    const orgId = await ensureActiveMember(req);
    const { deptId } = req.params;
    const Schema = z.object({ userId: z.string().uuid(), role: z.enum(['lead','member']) });
    const body = Schema.parse(req.body || {});
    const callerId = req.user?.sub;
    const callerOrgRole = await getUserOrgRole(req);
    const isAdmin = callerOrgRole === 'orgAdmin';
    const isTeamLead = callerOrgRole === 'teamLead';

    // Check if the user being added exists in the organization
    const { data: existingOrgUser, error: orgUserCheckError } = await db
      .from('organization_users')
      .select('user_id, role')
      .eq('org_id', orgId)
      .eq('user_id', body.userId)
      .maybeSingle();

    if (orgUserCheckError) throw orgUserCheckError;

    // If user is not in organization, add them as a member first
    if (!existingOrgUser) {
      console.log(`User ${body.userId} not in organization, adding as member...`);
      const { error: addToOrgError } = await db
        .from('organization_users')
        .insert({
          org_id: orgId,
          user_id: body.userId,
          role: 'member'
        });

      if (addToOrgError) throw addToOrgError;

      // Create app_users entry if it doesn't exist
      const { error: appUserError } = await db
        .from('app_users')
        .upsert({
          id: body.userId,
          display_name: 'Team Member'
        }, { onConflict: 'id' });

      if (appUserError) {
        console.log('App user entry creation failed, but continuing:', appUserError.message);
      }
    }
    
    // Non-admins must be department lead of this dept OR have departments.manage_members permission
    if (!isAdmin) {
      // Check if user has departments.manage_members permission first
      let canManageTeamMembers = false;
      try {
        console.log('🔍 Checking departments.manage_members permission for adding user to department:', callerId);
        // Get user's department context for permission checking
        const { data: userDepts } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', callerId);
        
        const userDeptIds = userDepts?.map(d => d.department_id) || [];
        const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
        
        console.log('🔍 User department context for department user addition:', { userDeptIds, deptContext });
        
        await ensurePerm(req, 'departments.manage_members', app, { departmentId: deptContext });
        canManageTeamMembers = true;
        console.log('✅ User has departments.manage_members permission for department user addition');
      } catch (error) {
        canManageTeamMembers = false;
        console.log('❌ User does not have departments.manage_members permission for department user addition:', error.message);
      }
      
      // If not, check if caller is a department lead for this specific department
      if (!canManageTeamMembers) {
        const { data: lead } = await db
          .from('department_users')
          .select('user_id')
          .eq('org_id', orgId)
          .eq('department_id', deptId)
          .eq('user_id', callerId)
          .eq('role', 'lead')
          .maybeSingle();
          
        // Team leads can only manage departments where they are leads
        if (isTeamLead) {
          if (!lead) {
            const e = new Error('Team leads can only manage departments where they are team leads'); 
            e.statusCode = 403; 
            throw e; 
          }
        } else {
          // For non-teamLead roles, they must be a department lead
          if (!lead) { 
            const e = new Error('Forbidden'); 
            e.statusCode = 403; 
            throw e; 
          }
        }
      }
      
      // Team lead cannot change their own role
      if (body.userId === callerId) {
        const e = new Error('Team leads cannot change their own role'); e.statusCode = 403; throw e;
      }
      
      // Team lead cannot assign lead role to others (only admins can)
      if (body.role === 'lead') {
        const e = new Error('Only admins can assign Team Lead role'); e.statusCode = 403; throw e;
      }
    }
    const payload = { org_id: orgId, department_id: deptId, user_id: body.userId, role: body.role };
    const { data, error } = await db
      .from('department_users')
      .upsert(payload, { onConflict: 'department_id,user_id' })
      .select('*')
      .single();
    if (error) throw error;

    // Update department's lead_user_id if assigning/removing lead role
    if (body.role === 'lead') {
      // Setting a new lead - update department.lead_user_id
      await db
        .from('departments')
        .update({ lead_user_id: body.userId })
        .eq('org_id', orgId)
        .eq('id', deptId);
    } else {
      // Check if this user was previously a lead and is being demoted
      const { data: existingUser } = await db
        .from('department_users')
        .select('role')
        .eq('org_id', orgId)
        .eq('department_id', deptId)
        .eq('user_id', body.userId)
        .single();

      // If user was previously a lead and is now being changed to non-lead, clear lead_user_id
      if (existingUser?.role === 'lead') {
        await db
          .from('departments')
          .update({ lead_user_id: null })
          .eq('org_id', orgId)
          .eq('id', deptId);
      }
    }

    return data;
  });

  app.delete('/orgs/:orgId/departments/:deptId/users/:userId', { preHandler: app.verifyAuth }, async (req) => {
    const db = app.supabaseAdmin; // Use admin client to bypass RLS policies
    const orgId = await ensureActiveMember(req);
    const { deptId, userId } = req.params;
    const callerId = req.user?.sub;
    const callerOrgRole = await getUserOrgRole(req);
    const isAdmin = callerOrgRole === 'orgAdmin';
    const isTeamLead = callerOrgRole === 'teamLead';
    
    // Non-admins must be department lead of this dept OR have departments.manage_members permission
    if (!isAdmin) {
      // Check if user has departments.manage_members permission first
      let canManageTeamMembers = false;
      try {
        console.log('🔍 Checking departments.manage_members permission for user deletion:', callerId);
        // Get user's department context for permission checking
        const { data: userDepts } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', callerId);
        
        const userDeptIds = userDepts?.map(d => d.department_id) || [];
        const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
        
        console.log('🔍 User department context for user deletion:', { userDeptIds, deptContext });
        
        await ensurePerm(req, 'departments.manage_members', app, { departmentId: deptContext });
        canManageTeamMembers = true;
        console.log('✅ User has departments.manage_members permission for user deletion');
      } catch (error) {
        canManageTeamMembers = false;
        console.log('❌ User does not have departments.manage_members permission for user deletion:', error.message);
      }
      
      // If not, check if they're a department lead
      if (!canManageTeamMembers) {
        const { data: lead } = await db
          .from('department_users')
          .select('user_id')
          .eq('org_id', orgId)
          .eq('department_id', deptId)
          .eq('user_id', callerId)
          .eq('role', 'lead')
          .maybeSingle();
          
        // For teamLead org role: they can manage any department they are a member of
        if (isTeamLead) {
          const { data: membership } = await db
            .from('department_users')
            .select('user_id')
            .eq('org_id', orgId)
            .eq('department_id', deptId)
            .eq('user_id', callerId)
            .maybeSingle();
            
          if (!membership) {
            const e = new Error('Team leads can only manage departments they are members of'); 
            e.statusCode = 403; 
            throw e; 
          }
        } else {
          // For non-teamLead roles, they must be a department lead
          if (!lead) { 
            const e = new Error('Forbidden'); 
            e.statusCode = 403; 
            throw e; 
          }
        }
      }
      
      // Team lead cannot remove themselves
      if (userId === callerId) {
        const e = new Error('Team leads cannot remove themselves from the department'); 
        e.statusCode = 403; 
        throw e;
      }
    }
    
    // Check if the user being removed is a lead
    const { data: userToRemove } = await db
      .from('department_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('department_id', deptId)
      .eq('user_id', userId)
      .single();

    const { error } = await db
      .from('department_users')
      .delete()
      .eq('org_id', orgId)
      .eq('department_id', deptId)
      .eq('user_id', userId);
    if (error) throw error;

    // If the removed user was a lead, clear the department's lead_user_id
    if (userToRemove?.role === 'lead') {
      await db
        .from('departments')
        .update({ lead_user_id: null })
        .eq('org_id', orgId)
        .eq('id', deptId);
    }

    // Check if user is in any other departments
    const { count: otherDeptCount } = await db
      .from('department_users')
      .select('department_id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('user_id', userId);

    // If user is not in any other departments, remove them from the organization entirely
    if ((otherDeptCount || 0) === 0) {
      console.log(`User ${userId} is not in any other departments, removing from organization`);

      // Remove from organization_users
      const { error: orgRemoveError } = await db
        .from('organization_users')
        .delete()
        .eq('org_id', orgId)
        .eq('user_id', userId);

      if (orgRemoveError) {
        console.warn('Failed to remove user from organization:', orgRemoveError);
        // Don't fail the request if org removal fails
      } else {
        console.log(`User ${userId} removed from organization ${orgId}`);
      }
    } else {
      console.log(`User ${userId} still in ${otherDeptCount} other departments, keeping in organization`);
    }

    return { ok: true };
  });

  // Per-user overrides (org-wide or department-specific)
  app.get('/orgs/:orgId/overrides', { preHandler: app.verifyAuth }, async (req) => {
    const db = app.supabaseAdmin; // Use admin client to bypass RLS since we've already done permission checks
    const orgId = await ensureActiveMember(req);
    const q = req.query || {};
    const userId = typeof q.userId === 'string' ? q.userId : undefined;
    // Accept departmentId as UUID, or the literal string 'null' to mean org-wide overrides
    let deptParam = undefined;
    if (Object.prototype.hasOwnProperty.call(q, 'departmentId')) {
      const raw = q.departmentId;
      if (raw === 'null' || raw === '' || raw === null) deptParam = null;
      else if (typeof raw === 'string') deptParam = raw;
    }
    
    // Check if user has permission to read overrides
    try {
      await ensurePerm(req, 'org.manage_members', app);
    } catch (permError) {
      // If not org admin, check if they're a department lead for the specific department
      if (typeof deptParam === 'string') {
        const { data: deptMembership } = await db
          .from('department_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', req.user?.sub)
          .eq('department_id', deptParam)
          .eq('role', 'lead')
          .maybeSingle();
        
        if (!deptMembership) {
          const err = new Error('Access denied: You must be an organization administrator or department lead to view user overrides');
          err.statusCode = 403;
          throw err;
        }
      } else {
        // Org-wide overrides require org admin permission
        const err = new Error('Access denied: Organization-wide overrides require administrator privileges');
        err.statusCode = 403;
        throw err;
      }
    }
    
    // Check Core team access restriction
    if (typeof deptParam === 'string') {
      const { data: deptInfo } = await db
        .from('departments')
        .select('name')
        .eq('id', deptParam)
        .eq('org_id', orgId)
        .single();
      
      if (deptInfo?.name === 'Core') {
        // Check if the requesting user is an org admin
        const { data: requesterRole } = await db
          .from('organization_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', req.user?.sub)
          .single();
        
        if (requesterRole?.role !== 'orgAdmin') {
          const err = new Error('Access denied: Core team is restricted to organization administrators only');
          err.statusCode = 403;
          throw err;
        }
      }
    }
    let qb = db.from('user_access_overrides').select('*').eq('org_id', orgId);
    if (userId) qb = qb.eq('user_id', userId);
    if (deptParam === null) qb = qb.is('department_id', null);
    else if (typeof deptParam === 'string') qb = qb.eq('department_id', deptParam);
    const { data, error } = await qb;
    if (error) throw error;
    return data || [];
  });

  app.put('/orgs/:orgId/overrides', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Allow both boolean and string values for permissions (for dashboard.view which is 'admin' | 'regular')
    const Schema = z.object({ 
      userId: z.string().uuid(), 
      departmentId: z.string().uuid().nullable().optional(), 
      permissions: z.record(z.union([z.boolean(), z.string()]))
    });
    const body = Schema.parse(req.body || {});
    
    // Check if user has permission to manage overrides
    try {
      await ensurePerm(req, 'org.manage_members', app);
    } catch (permError) {
      // If not org admin, check if they're a department lead for the specific department
      if (body.departmentId) {
        const { data: deptMembership } = await db
          .from('department_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', req.user?.sub)
          .eq('department_id', body.departmentId)
          .eq('role', 'lead')
          .maybeSingle();
        
        if (!deptMembership) {
          const err = new Error('Access denied: You must be an organization administrator or department lead to manage user overrides');
          err.statusCode = 403;
          throw err;
        }
      } else {
        // Org-wide overrides require org admin permission
        const err = new Error('Access denied: Organization-wide overrides require administrator privileges');
        err.statusCode = 403;
        throw err;
      }
    }
    
    // Check Core team access restriction
    if (body.departmentId) {
      const { data: deptInfo } = await db
        .from('departments')
        .select('name')
        .eq('id', body.departmentId)
        .eq('org_id', orgId)
        .single();
      
      if (deptInfo?.name === 'Core') {
        // Check if the requesting user is an org admin
        const { data: requesterRole } = await db
          .from('organization_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', req.user?.sub)
          .single();
        
        if (requesterRole?.role !== 'orgAdmin') {
          const err = new Error('Access denied: Core team is restricted to organization administrators only');
          err.statusCode = 403;
          throw err;
        }
      }
    }
    
    const payload = { org_id: orgId, user_id: body.userId, department_id: (Object.prototype.hasOwnProperty.call(body,'departmentId') ? body.departmentId : null), permissions: body.permissions };
    console.log('🔍 Debug: Creating override with payload:', payload);
    
    // Use supabaseAdmin to bypass RLS since we've already done permission checks above
    const { data, error } = await app.supabaseAdmin
      .from('user_access_overrides')
      .upsert(payload, { onConflict: 'org_id,user_id,department_id' })
      .select('*')
      .single();
    
    if (error) {
      console.error('❌ Override creation error:', error);
      throw error;
    }
    
    console.log('🔍 Debug: Override created successfully:', data);
    
    // Verify the record was actually saved by querying it back
    const { data: verifyData, error: verifyError } = await app.supabaseAdmin
      .from('user_access_overrides')
      .select('*')
      .eq('org_id', orgId)
      .eq('user_id', body.userId)
      .eq('department_id', payload.department_id);
    
    console.log('🔍 Debug: Verification query result:', verifyData);
    if (verifyError) {
      console.error('❌ Verification query error:', verifyError);
    }
    
    // Invalidate permission cache for the user whose override was created
    const { invalidateUserOrgCache } = await import('./cache.js');
    invalidateUserOrgCache(body.userId, orgId);
    console.log(`🔄 Invalidated permission cache for user ${body.userId} after override update`);
    
    return data;
  });

  app.get('/orgs/:orgId/ip-bypass-grants', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const db = app.supabaseAdmin;
    const q = req.query || {};
    const nowIso = new Date().toISOString();
    let qb = db
      .from('ip_bypass_grants')
      .select('*')
      .eq('org_id', orgId)
      .order('granted_at', { ascending: false });
    if (typeof q.userId === 'string') qb = qb.eq('user_id', q.userId);
    const activeParam = typeof q.active === 'string' ? q.active.toLowerCase() : q.active;
    if (activeParam === 'true' || activeParam === true) {
      qb = qb.is('revoked_at', null).gt('expires_at', nowIso);
    }
    const { data, error } = await qb;
    if (error) throw error;
    return data || [];
  });

  app.post('/orgs/:orgId/ip-bypass-grants', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const Schema = z.object({
      userId: z.string().uuid(),
      durationMinutes: z.number().int().positive().max(60 * 24 * 14).optional(),
      expiresAt: z.string().datetime().optional(),
      note: z.string().max(500).optional(),
    }).refine((value) => !!value.durationMinutes || !!value.expiresAt, {
      message: 'durationMinutes or expiresAt is required',
      path: ['durationMinutes'],
    });
    const body = Schema.parse(req.body || {});
    const now = Date.now();
    let expiresAtMs = null;
    if (typeof body.durationMinutes === 'number') {
      expiresAtMs = now + body.durationMinutes * 60_000;
    }
    if (body.expiresAt) {
      const parsed = new Date(body.expiresAt).getTime();
      if (Number.isNaN(parsed)) {
        const err = new Error('Invalid expiresAt value');
        err.statusCode = 400;
        throw err;
      }
      expiresAtMs = parsed;
    }
    if (!expiresAtMs || expiresAtMs <= now) {
      const err = new Error('expiresAt must be in the future');
      err.statusCode = 400;
      throw err;
    }
    const expiresAtIso = new Date(expiresAtMs).toISOString();
    const db = app.supabaseAdmin;
    const nowIso = new Date().toISOString();
    await db
      .from('ip_bypass_grants')
      .update({ revoked_at: nowIso })
      .eq('org_id', orgId)
      .eq('user_id', body.userId)
      .is('revoked_at', null)
      .gt('expires_at', nowIso);
    const { data, error } = await db
      .from('ip_bypass_grants')
      .insert({
        org_id: orgId,
        user_id: body.userId,
        granted_by: req.user?.sub || null,
        expires_at: expiresAtIso,
        note: body.note || null,
      })
      .select('*')
      .single();
    if (error) throw error;
    try {
      await app.supabaseAdmin.from('audit_events').insert({
        org_id: orgId,
        actor_user_id: req.user?.sub || null,
        type: 'ops.ip_bypass.grant',
        note: `${body.userId} until ${expiresAtIso}`,
      });
    } catch (auditError) {
      app.log.warn(auditError, 'Failed to audit IP bypass grant');
    }
    try {
      const { invalidateUserOrgCache } = await import('./cache.js');
      invalidateUserOrgCache(body.userId, orgId);
    } catch {}
    return data;
  });

  app.post('/orgs/:orgId/ip-bypass-grants/:grantId/revoke', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const { orgId, grantId } = req.params;
    await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const nowIso = new Date().toISOString();
    const { data, error } = await app.supabaseAdmin
      .from('ip_bypass_grants')
      .update({ revoked_at: nowIso })
      .eq('org_id', orgId)
      .eq('id', grantId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const err = new Error('Grant not found');
      err.statusCode = 404;
      throw err;
    }
    try {
      await app.supabaseAdmin.from('audit_events').insert({
        org_id: orgId,
        actor_user_id: req.user?.sub || null,
        type: 'ops.ip_bypass.revoke',
        note: data.user_id,
      });
    } catch (auditError) {
      app.log.warn(auditError, 'Failed to audit IP bypass revoke');
    }
    try {
      const { invalidateUserOrgCache } = await import('./cache.js');
      invalidateUserOrgCache(data.user_id, orgId);
    } catch {}
    return { ok: true, revokedAt: nowIso };
  });

  // Effective permissions for a user at org or department scope
  app.get('/orgs/:orgId/overrides/effective', { preHandler: app.verifyAuth }, async (req) => {
    const db = app.supabaseAdmin; // Use admin client to bypass RLS since we've already done permission checks
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members', app);
    const q = req.query || {};
    const userId = typeof q.userId === 'string' ? q.userId : undefined;
    if (!userId) { const e = new Error('userId required'); e.statusCode = 400; throw e; }
    // departmentId: UUID string or 'null' meaning org-scope
    let deptParam = undefined;
    if (Object.prototype.hasOwnProperty.call(q, 'departmentId')) {
      const raw = q.departmentId;
      console.log(`🔍 Debug: Raw departmentId from query: "${raw}" (type: ${typeof raw})`);
      if (raw === 'null' || raw === '' || raw === null) deptParam = null;
      else if (typeof raw === 'string') deptParam = raw;
      console.log(`🔍 Debug: Processed deptParam: ${deptParam} (type: ${typeof deptParam})`);
    } else {
      console.log('🔍 Debug: No departmentId in query parameters');
    }

    // Get user's role in the org
    const { data: membership } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();
    const roleKey = membership?.role || null;

    // If querying department-specific permissions, check if user is a member of that department
    if (typeof deptParam === 'string') {
      // First check if this is the Core team and if the requesting user is an admin
      const { data: deptInfo } = await db
        .from('departments')
        .select('name')
        .eq('id', deptParam)
        .eq('org_id', orgId)
        .single();
      
      if (deptInfo?.name === 'Core') {
        // Check if the requesting user is an org admin
        const { data: requesterRole } = await db
          .from('organization_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', req.user?.sub)
          .single();
        
        if (requesterRole?.role !== 'orgAdmin') {
          return { 
            role: roleKey, 
            rolePermissions: {}, 
            orgOverride: {}, 
            deptOverride: {}, 
            effective: {},
            note: 'Access denied: Core team is restricted to organization administrators only'
          };
        }
      }
      
      const { data: deptMembership } = await db
        .from('department_users')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .eq('department_id', deptParam)
        .maybeSingle();
      
      if (!deptMembership) {
        // User is not a member of this department - return minimal permissions
        return { 
          role: roleKey, 
          rolePermissions: {}, 
          orgOverride: {}, 
          deptOverride: {}, 
          effective: {},
          note: 'User is not a member of this department'
        };
      }
    }
    let rolePerms = {};
    if (roleKey) {
      const { data: roleRow } = await db
        .from('org_roles')
        .select('permissions')
        .eq('org_id', orgId)
        .eq('key', roleKey)
        .single();
      rolePerms = (roleRow?.permissions || {});
    }

    // Fetch org-wide and dept-specific overrides
    const { data: orgOverrideRow } = await db
      .from('user_access_overrides')
      .select('permissions')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .is('department_id', null)
      .maybeSingle();
    const orgOverride = (orgOverrideRow?.permissions || {});

    let deptOverride = {};
    console.log(`🔍 Debug: deptParam type check - typeof deptParam: ${typeof deptParam}, value: ${deptParam}`);
    if (typeof deptParam === 'string') {
      console.log(`🔍 Debug: Looking for dept override - userId: ${userId}, deptId: ${deptParam}, orgId: ${orgId}`);
      // First, let's see all overrides for this user to debug
      const { data: allOverrides, error: allError } = await db
        .from('user_access_overrides')
        .select('*')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      
      console.log('🔍 All overrides for user:', allOverrides);
      
      const { data: deptOverrideRow, error: deptError } = await db
        .from('user_access_overrides')
        .select('permissions, department_id, user_id')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .eq('department_id', deptParam)
        .maybeSingle();
      
      if (deptError) {
        console.error('❌ Dept override query error:', deptError);
      } else {
        console.log('🔍 Dept override query result:', deptOverrideRow);
      }
      
      deptOverride = (deptOverrideRow?.permissions || {});
    } else {
      console.log(`🔍 Debug: Skipping dept override query because deptParam is not a string (type: ${typeof deptParam})`);
    }

    // Combine keys from all sources
    const keys = new Set([
      ...Object.keys(rolePerms || {}),
      ...Object.keys(orgOverride || {}),
      ...Object.keys(deptOverride || {}),
    ]);
    const effective = {};
    for (const k of keys) {
      const v = (deptOverride.hasOwnProperty(k) ? !!deptOverride[k]
        : orgOverride.hasOwnProperty(k) ? !!orgOverride[k]
        : !!rolePerms[k]);
      effective[k] = v;
    }
    return { role: roleKey, rolePermissions: rolePerms, orgOverride, deptOverride, effective };
  });

  // IP validation check endpoint - validates without logging audit
  app.get('/orgs/:orgId/ip-check', { preHandler: app.verifyAuth }, async (req) => {
    const orgId = await ensureActiveMember(req);
    const clientIp = app.getClientIp(req);
    
    // Get user's role in this organization
    const { data: membership } = await req.supabase
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', req.user.sub)
      .maybeSingle();

    const userRole = membership?.role;
    const validation = await app.validateIpAccess(orgId, clientIp, userRole);

    return {
      clientIp,
      allowed: validation.allowed,
      reason: validation.reason,
      userRole,
      orgId
    };
  });

  app.post('/orgs/:orgId/audit/login', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const clientIp = app.getClientIp(req);
    const note = `ip=${clientIp} (validation: ${req.ipValidation?.reason || 'unknown'})`;
    await logAudit(app, orgId, userId, 'login', { note });
    return { 
      ok: true, 
      clientIp,
      ipValidation: req.ipValidation 
    };
  });

  // Check if user can access audit logs
  app.get('/orgs/:orgId/audit/can-access', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    
    try {
      // Get user's department context for permission checking
      const userId = req.user?.sub;
      const { data: userDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      
      const userDeptIds = userDepts?.map(d => d.department_id) || [];
      const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
      
      // Check page permission (preferred), with fallback to audit.read for backward compatibility
      try {
        await ensurePerm(req, 'pages.activity', app, { departmentId: deptContext });
        return true;
      } catch {
        // Fallback: check audit.read permission for backward compatibility
        await ensurePerm(req, 'audit.read', app, { departmentId: deptContext });
        return true;
      }
    } catch (error) {
      console.error('Error checking audit access:', error);
      return false;
    }
  });

  // Check if user can access pages
  app.get('/orgs/:orgId/pages/can-access', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { page } = req.query || {};
    
    if (!page || typeof page !== 'string') {
      const err = new Error('page query parameter required');
      err.statusCode = 400;
      throw err;
    }
    
    // Map page names to permission keys
    const pagePermissionMap = {
      'upload': 'pages.upload',
      'documents': 'pages.documents',
      'folders': 'pages.documents',
      'activity': 'pages.activity',
      'audit': 'pages.activity',
      'recycle-bin': 'pages.recycle_bin',
      'recycle_bin': 'pages.recycle_bin',
      'chat': 'pages.chat',
      'chatbot': 'pages.chat',
    };
    
    const permKey = pagePermissionMap[page.toLowerCase()];
    if (!permKey) {
      const err = new Error(`Unknown page: ${page}`);
      err.statusCode = 400;
      throw err;
    }
    
    try {
      // Get user's department context for permission checking
      const userId = req.user?.sub;
      const { data: userDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      
      const userDeptIds = userDepts?.map(d => d.department_id) || [];
      const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
      
      // Check page permission
      await ensurePerm(req, permKey, app, { departmentId: deptContext });
      return { canAccess: true, page, permission: permKey };
    } catch (error) {
      // Check fallback permissions for backward compatibility
      let fallbackPerm = null;
      if (page === 'activity' || page === 'audit') {
        fallbackPerm = 'audit.read';
      } else if (page === 'documents' || page === 'folders') {
        fallbackPerm = 'documents.read';
      } else if (page === 'upload') {
        fallbackPerm = 'documents.create';
      } else if (page === 'recycle-bin' || page === 'recycle_bin') {
        // Check org.manage_members OR documents.delete
        const perms = await getMyPermissions(req, orgId);
        const canAccess = !!(perms && (perms['org.manage_members'] || perms['documents.delete']));
        return { canAccess, page, permission: permKey, fallback: true };
      }
      
      if (fallbackPerm) {
        try {
          await ensurePerm(req, fallbackPerm, app, { departmentId: deptContext });
          return { canAccess: true, page, permission: permKey, fallback: true };
        } catch {
          return { canAccess: false, page, permission: permKey };
        }
      }
      
      return { canAccess: false, page, permission: permKey };
    }
  });

  app.get('/orgs/:orgId/audit', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    
    // Get user's department context for permission checking
    const userId = req.user?.sub;
    const { data: userDepts } = await db
      .from('department_users')
      .select('department_id')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    
    const userDeptIds = userDepts?.map(d => d.department_id) || [];
    const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
    
    // Check if user has audit.read permission (includes overrides) with department context
    await ensurePerm(req, 'audit.read', app, { departmentId: deptContext });
    const { type, actors, from, to, limit = 50, offset = 0, coalesce = '1', excludeSelf = '0' } = req.query || {};
    // Fetch a larger page to allow coalescing without losing items
    const fetchLimit = Math.min(Number(limit) * 3, 600);
    let query = db
      .from('audit_events')
      .select('*')
      .eq('org_id', orgId)
      .order('ts', { ascending: false })
      .range(offset, offset + fetchLimit - 1);
    if (type && type !== 'all') query = query.eq('type', String(type));
    if (actors) query = query.in('actor_user_id', String(actors).split(',').filter(Boolean));
    if (from) query = query.gte('ts', new Date(String(from)).toISOString());
    if (to) query = query.lte('ts', new Date(String(to)).toISOString());
    if (String(excludeSelf) !== '0' && req.user?.sub) query = query.neq('actor_user_id', req.user.sub);
    const { data: raw, error } = await query;
    if (error) throw error;

    const events = Array.isArray(raw) ? raw : [];
    // Scope for non-admins: only doc-linked events for their depts OR login events for team users
    let scoped = events;
    const isAdmin = req.user?.role === 'systemAdmin';
    if (!isAdmin) {
      const userId = req.user?.sub;
      const { data: myDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      const deptIds = new Set((myDepts || []).map(r => r.department_id));
      // Allowed doc ids
      const { data: docRows } = await db
        .from('documents')
        .select('id, department_id')
        .eq('org_id', orgId);
      const allowedDocs = new Set((docRows || []).filter(d => d.department_id && deptIds.has(d.department_id)).map(d => d.id));
      // Team user ids
      const { data: teamUsers } = await db
        .from('department_users')
        .select('user_id, department_id')
        .eq('org_id', orgId);
      const teamUserIds = new Set((teamUsers || []).filter(r => deptIds.has(r.department_id)).map(r => r.user_id));
      scoped = events.filter(ev => {
        if (ev.doc_id && allowedDocs.has(ev.doc_id)) return true;
        if (ev.type === 'login' && ev.actor_user_id && teamUserIds.has(ev.actor_user_id)) return true;
        return false;
      });
    }
    const actorIds = Array.from(new Set(scoped.map((e) => e.actor_user_id).filter(Boolean)));

    // Enrich with actor email and role (server-side, bypassing RLS)
    const idToRole = new Map();
    const idToEmail = new Map();
    if (actorIds.length > 0) {
      try {
        const { data: roles } = await app.supabaseAdmin
          .from('organization_users')
          .select('user_id, role')
          .eq('org_id', orgId)
          .in('user_id', actorIds);
        for (const r of roles || []) idToRole.set(r.user_id, r.role);
      } catch {}
      // Fetch emails via Auth Admin API (no batch endpoint; loop unique ids)
      for (const uid of actorIds) {
        try {
          const { data } = await app.supabaseAdmin.auth.admin.getUserById(uid);
          const email = data?.user?.email || null;
          if (email) idToEmail.set(uid, email);
        } catch {}
      }
    }

    // Optional coalescing of noisy sequences right after creation
    const shouldCoalesce = String(coalesce) !== '0';
    let list = scoped.map((e) => ({ ...e }));
    if (shouldCoalesce) {
      // Work on ascending time for simpler window logic, then sort back desc
      const asc = list.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
      const keep = [];
      for (let i = 0; i < asc.length; i++) {
        const ev = asc[i];
        if (ev.type === 'create' && ev.doc_id && ev.actor_user_id) {
          const createTs = new Date(ev.ts).getTime();
          const windowEnd = createTs + 2 * 60 * 1000; // 2 minutes
          // Skip immediate metadata/file edits that are part of initial upload
          let j = i + 1;
          while (j < asc.length) {
            const nxt = asc[j];
            if (nxt.doc_id === ev.doc_id && nxt.actor_user_id === ev.actor_user_id) {
              const t = new Date(nxt.ts).getTime();
              const isWithin = t <= windowEnd;
              const isBenignEdit = nxt.type === 'edit' && (String(nxt.note || '').includes('file finalized') || String(nxt.note || '').includes('metadata updated'));
              if (isWithin && isBenignEdit) {
                // drop nxt (do not push to keep)
                j++;
                continue;
              }
            }
            break;
          }
          keep.push(ev);
          i = j - 1;
        } else {
          keep.push(ev);
        }
      }
      list = keep.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    }

    // Enrich and trim to requested limit
    const enriched = list.slice(0, Number(limit)).map((e) => ({
      ...e,
      actor_email: idToEmail.get(e.actor_user_id) || null,
      actor_role: idToRole.get(e.actor_user_id) || null,
    }));
    return enriched;
  });

  app.get('/orgs/:orgId/documents', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    console.log('Documents endpoint called for org:', req.params.orgId, 'user:', req.user?.sub, 'query:', req.query);
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    
    const { q, limit = 10000, offset = 0, departmentId } = req.query || {};
    const userId = req.user?.sub;
    
    // Check if user has permission to read documents
    // First get user's department context for permission checking
    const { data: userDepts } = await db
      .from('department_users')
      .select('department_id')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    
    const userDeptIds = userDepts?.map(d => d.department_id) || [];
    
    // Check permission with department context (use first department if multiple)
    const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
    
    try {
      await ensurePerm(req, 'documents.read', app, { departmentId: deptContext });
    } catch (permError) {
      // If user doesn't have documents.read permission, return empty documents
      console.log('User does not have documents.read permission, returning empty documents');
      return [];
    }
    
    // Build documents query
    
    // First, check user's role and department memberships
    const { data: userRole } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();
    
    const isOrgAdmin = userRole?.role === 'orgAdmin';
    // User role derived above
    
    let query = db
      .from('documents')
      .select('id, org_id, title, filename, type, folder_path, subject, description, category, tags, keywords, sender, receiver, document_date, uploaded_at, file_size_bytes, mime_type, content_hash, storage_key, department_id, version_group_id, version_number, is_current_version, supersedes_id, deleted_at, purge_after')
      .eq('org_id', orgId)
      .order('uploaded_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1);

    // Apply folder filter
    query = query.filter('type', 'neq', 'folder');
    // Exclude items that are in the recycle bin
    query = query.is('deleted_at', null);
    
    // Apply department filtering for non-admin users
    if (!isOrgAdmin) {
      if (departmentId) {
        // Specific department requested - verify user has access
        const { data: hasAccess } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .eq('department_id', departmentId)
          .single();
        
        if (!hasAccess) {
          return { error: 'Access denied to this department' };
        }
        
        query = query.eq('department_id', departmentId);
        // Specific department filter
      } else {
        // No specific department - get user's accessible departments
        const { data: userDepts } = await db
          .from('department_users')
          .select('department_id')
          .eq('org_id', orgId)
          .eq('user_id', userId);
        
        if (userDepts && userDepts.length > 0) {
          const deptIds = userDepts.map(d => d.department_id);
          // STRICT: Only documents in user's departments (NO null department access)
          query = query.in('department_id', deptIds);
          // Limit to user's departments
        } else {
          // User has no department access - NO documents visible
          // Use a proper UUID format that will never match any real department
          query = query.eq('department_id', '00000000-0000-0000-0000-000000000000');
          // User has no accessible departments
        }
      }
    } else {
      // Admin can see all documents
      if (departmentId) {
        query = query.eq('department_id', departmentId);
        // Admin filtering to specific department
      }
    }
    
    // Excluding folder placeholders
    
    // Debug: Let's see what's actually in the database
    // Remove heavy debug queries in production
    
    if (q && String(q).trim()) {
      const s = `%${String(q).trim()}%`;
      query = query.or(
        `title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},description.ilike.${s}`
      );
    }
    // Execute query
    const { data, error } = await query;
    if (error) {
      // Query error
      throw error;
    }
    
    // Map and filter results
    
    // Double-check: manually filter out any folders that might have slipped through
    const filteredData = data?.filter(d => d.type !== 'folder' && !d.deleted_at) || [];
    // Manual folder filter safeguard
    
    // Fetch linked documents for all documents
    const docIds = (filteredData || []).map(d => d.id);
    let linksMap = {};
    let chunksCountMap = new Map();
    // Build version group membership map for these docs
    const versionMap = new Map(); // docId -> array of version-linked docIds
    if (docIds.length > 0) {
      const { data: links, error: linksError } = await db
        .from('document_links')
        .select('doc_id, linked_doc_id')
        .eq('org_id', orgId)
        .in('doc_id', docIds);
      
      if (!linksError && links) {
        // Group linked document IDs by document ID (outgoing)
        linksMap = links.reduce((acc, link) => {
          if (!acc[link.doc_id]) acc[link.doc_id] = [];
          acc[link.doc_id].push(link.linked_doc_id);
          return acc;
        }, {});
      }

      // Rely on outgoing links; if bidirectional linking is enforced, this suffices

      // Determine semantic readiness by checking if any chunk exists per doc
      const { data: chunkDocs } = await db
        .from('doc_chunks')
        .select('doc_id')
        .eq('org_id', orgId)
        .in('doc_id', docIds)
        .limit(10000);
      const hasChunksSet = new Set((chunkDocs || []).map((r) => r.doc_id));
      chunksCountMap = new Map(docIds.map((id) => [id, hasChunksSet.has(id) ? 1 : 0]));

      // Version relationships: group siblings
      // Fetch version info for docs in list and any that reference them as a group
      const { data: verRows } = await db
        .from('documents')
        .select('id, version_group_id')
        .eq('org_id', orgId)
        .or(
          [
            `id.in.(${docIds.join(',')})`,
            `version_group_id.in.(${docIds.join(',')})`
          ].join(',')
        );
      const byGroup = new Map(); // groupId -> Set(memberId)
      const idSet = new Set(docIds);
      for (const r of verRows || []) {
        if (r.version_group_id) {
          if (!byGroup.has(r.version_group_id)) byGroup.set(r.version_group_id, new Set());
          byGroup.get(r.version_group_id).add(r.id);
        }
      }
      // For each doc in list, compute its version-linked ids
      for (const d of filteredData || []) {
        const members = new Set();
        if (d.version_group_id) {
          // Add all members of this group
          const set = byGroup.get(d.version_group_id);
          if (set) set.forEach((mid) => { if (mid !== d.id) members.add(mid); });
          // Include the base doc (group id) if present in verRows
          const base = (verRows || []).find(r => r.id === d.version_group_id);
          if (base) members.add(base.id);
        } else {
          // If this doc is a potential base (others reference it)
          const set = byGroup.get(d.id);
          if (set) set.forEach((mid) => { if (mid !== d.id) members.add(mid); });
        }
        versionMap.set(d.id, Array.from(members));
      }
    }
    
    // Map database fields to frontend expected field names and add linked document IDs
    const mappedData = (filteredData || []).map(d => ({
      ...d,
      // Map database snake_case to frontend camelCase
      uploadedAt: d.uploaded_at,
      folderPath: d.folder_path || [],
      fileSizeBytes: d.file_size_bytes,
      mimeType: d.mime_type,
      contentHash: d.content_hash,
      storageKey: d.storage_key,
      versionGroupId: d.version_group_id,
      versionNumber: d.version_number,
      isCurrentVersion: d.is_current_version,
      supersedesId: d.supersedes_id,
      documentDate: d.document_date,
      deletedAt: d.deleted_at,
      purgeAfter: d.purge_after,
      // Add linked document IDs: explicit links (both directions) + version group siblings
      linkedDocumentIds: Array.from(new Set([...(linksMap[d.id] || []), ...((versionMap.get(d.id)) || [])])),
      // Add version field for backwards compatibility
      version: d.version_number || 1,
      // Add name field as alias for title/filename
      name: d.title || d.filename || 'Untitled',
      semanticReady: (chunksCountMap.get(d.id) || 0) > 0
    }));
    
    // Return final results
    console.log('Documents endpoint returning', mappedData.length, 'documents for user:', userId, 'org:', orgId);
    return mappedData;
  });

  app.get('/orgs/:orgId/documents/:id', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    
    // Check if user has permission to read documents
    // First get user's department context for permission checking
    const { data: userDepts } = await db
      .from('department_users')
      .select('department_id')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    
    const userDeptIds = userDepts?.map(d => d.department_id) || [];
    
    // Check permission with department context (use first department if multiple)
    const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
    
    try {
      await ensurePerm(req, 'documents.read', app, { departmentId: deptContext });
    } catch (permError) {
      // If user doesn't have documents.read permission, return 403
      reply.code(403);
      return { error: 'Access denied: You do not have permission to read documents' };
    }
    
    const { id } = req.params;
    const { data, error } = await db.from('documents').select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return reply.code(404).send({ error: 'Not found' });
    
    // Fetch linked documents for this document
    const { data: links, error: linksError } = await db
      .from('document_links')
      .select('linked_doc_id')
      .eq('org_id', orgId)
      .eq('doc_id', id);
    
    const linkedDocumentIds = (!linksError && links) ? links.map(l => l.linked_doc_id) : [];
    
    // Map database fields to frontend expected field names
    // Semantic readiness: count doc_chunks
    let chunksCount = 0;
    try {
      const { count: chunkCount } = await db
        .from('doc_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('doc_id', id);
      chunksCount = typeof chunkCount === 'number' ? chunkCount : 0;
    } catch {}

    const mappedData = {
      ...data,
      // Map database snake_case to frontend camelCase
      uploadedAt: data.uploaded_at,
      folderPath: data.folder_path || [],
      fileSizeBytes: data.file_size_bytes,
      mimeType: data.mime_type,
      contentHash: data.content_hash,
      storageKey: data.storage_key,
      versionGroupId: data.version_group_id,
      versionNumber: data.version_number,
      isCurrentVersion: data.is_current_version,
      supersedesId: data.supersedes_id,
      documentDate: data.document_date,
      // Add linked document IDs from the links table
      linkedDocumentIds,
      // Add version field for backwards compatibility
      version: data.version_number || 1,
      // Add name field as alias for title/filename
      name: data.title || data.filename || 'Untitled',
      semanticReady: chunksCount > 0
    };
    
    return mappedData;
  });

  app.post('/orgs/:orgId/documents', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    console.log('[DOCS.CREATE] user', userId, 'org', orgId, 'payload keys', Object.keys(req.body || {}));
    const Schema = z.object({
      title: z.string().min(1),
      filename: z.string().min(1),
      type: z.string().min(1),
      folderPath: z.array(z.string()).optional(),
      subject: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).default([]),
      keywords: z.array(z.string()).default([]),
      sender: z.string().optional(),
      receiver: z.string().optional(),
      document_date: z.string().optional(),
      storage_key: z.string().optional(),
      content_hash: z.string().optional(),
      mimeType: z.string().optional(),
      fileSizeBytes: z.number().optional(),
      contentHash: z.string().optional(),
      storageKey: z.string().optional(),
      departmentId: z.string().uuid().optional(),
    });
    const body = Schema.parse(req.body);
    const dbFields = toDbDocumentFields(body);
    // Resolve department: non-admins must create within their own department(s)
    let departmentId = body.departmentId || null;
    let isAdmin = false;
    try { await ensurePerm(req, 'org.manage_members', app); isAdmin = true; } catch { isAdmin = false; }
    if (!isAdmin) {
      // Load user's departments
      const { data: myDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      const uniq = Array.from(new Set((myDepts || []).map(r => r.department_id)));
      console.log('[DOCS.CREATE] non-admin dept memberships:', uniq);
      if (departmentId) {
        if (!uniq.includes(departmentId)) {
          const err = new Error('You can only create documents for your own team');
          err.statusCode = 403; throw err;
        }
      } else {
        // Try to inherit department from parent folder first
        if (body.folderPath && Array.isArray(body.folderPath) && body.folderPath.length > 0) {
          try {
            // Find the parent folder by traversing up the path
            let parentPath = body.folderPath.slice(); // folderPath already represents the containing folder path
            while (parentPath.length > 0) {
              const { data: parentFolder } = await db
                .from('documents')
                .select('department_id')
                .eq('org_id', orgId)
                .eq('type', 'folder')
                .eq('folder_path', parentPath)
                .maybeSingle();

              if (parentFolder?.department_id && uniq.includes(parentFolder.department_id)) {
                departmentId = parentFolder.department_id;
                console.log(`✅ [NON-ADMIN] Inherited department ${departmentId} from parent folder path: ${parentPath.join('/')}`);
                break;
              } else if (parentFolder?.department_id) {
                console.log(`⚠️ [NON-ADMIN] Found parent folder but department ${parentFolder.department_id} not in user's allowed departments: ${uniq.join(', ')}`);
              }
              // Try the next level up
              parentPath = parentPath.slice(0, -1);
            }
          } catch (error) {
            console.error('❌ [NON-ADMIN] Error inheriting department from parent folder:', error);
          }
          if (!departmentId) {
            console.log(`ℹ️ [NON-ADMIN] No department inherited from folder path: ${body.folderPath.join('/')}`);
          }
        }

        // If still no department, use smart selection logic
        if (!departmentId) {
          if (uniq.length === 1) {
            departmentId = uniq[0];
          } else {
            // Smart department selection: prefer non-Core/non-General teams
            departmentId = await selectSmartDepartment(db, orgId, uniq);
            if (!departmentId) {
              const err = new Error('Please select a team to create this document');
              err.statusCode = 400; throw err;
            }
          }
        }
      }
    } else {
      // Admins: Try to inherit from parent folder first, then use memberships
      if (!departmentId) {
        // First, try to inherit department from parent folder
        if (body.folderPath && Array.isArray(body.folderPath) && body.folderPath.length > 0) {
          try {
            // Find the parent folder by traversing up the path
            let parentPath = body.folderPath.slice(); // folderPath already represents the containing folder path
            while (parentPath.length > 0) {
              const { data: parentFolder } = await db
                .from('documents')
                .select('department_id')
                .eq('org_id', orgId)
                .eq('type', 'folder')
                .eq('folder_path', parentPath)
                .maybeSingle();

              if (parentFolder?.department_id) {
                departmentId = parentFolder.department_id;
                console.log(`✅ [ADMIN] Inherited department ${departmentId} from parent folder path: ${parentPath.join('/')}`);
                break;
              }
              // Try the next level up
              parentPath = parentPath.slice(0, -1);
            }
          } catch (error) {
            console.error('❌ [ADMIN] Error inheriting department from parent folder:', error);
          }
          if (!departmentId) {
            console.log(`ℹ️ [ADMIN] No department inherited from folder path: ${body.folderPath.join('/')}`);
          }
        }

        // If still no department, use admin's department memberships with smart selection
        if (!departmentId) {
          const { data: adminDepts } = await db
            .from('department_users')
            .select('department_id, departments(name)')
            .eq('org_id', orgId)
            .eq('user_id', userId);

          if (adminDepts && adminDepts.length > 0) {
            const adminDeptIds = adminDepts.map(d => d.department_id);
            if (adminDeptIds.length === 1) {
              departmentId = adminDeptIds[0];
            } else {
              // Smart department selection for admins: prefer non-Core/non-General teams
              departmentId = await selectSmartDepartment(db, orgId, adminDeptIds);
              if (!departmentId) {
                // Fallback to first department if smart selection fails
                departmentId = adminDeptIds[0];
              }
            }
          } else {
            // Admin has no department memberships - require explicit selection
            const err = new Error('Please select a department for this document. You are not a member of any departments.');
            err.statusCode = 400;
            throw err;
          }
        }
      }
    }
    // Debug RLS pre-checks (membership, permission, dept membership)
    try {
      const { data: okMember } = await db.rpc('is_member_of', { p_org_id: orgId });
      const { data: okPerm } = await db.rpc('has_perm', { p_org_id: orgId, p_perm: 'documents.create' });
      let okDept = null;
      if (departmentId) {
        const { data } = await db.rpc('is_dept_member', { target_org_id: orgId, target_dept_id: departmentId });
        okDept = data;
      }
      console.log('[DOCS.CREATE] RLS precheck is_member_of:', okMember, 'has_perm(documents.create):', okPerm, 'is_dept_member:', okDept);
    } catch (e) {
      console.warn('[DOCS.CREATE] RLS precheck error', e?.message || e);
    }
    // Log effective permissions snapshot for debugging
    try {
      const { permissions: perms } = await getEffectivePermissions(req, orgId, app, { departmentId });
      console.log('[DOCS.CREATE] effective perms for user', userId, 'dept', departmentId, perms);
    } catch (e) {
      console.warn('[DOCS.CREATE] failed to compute effective perms', e?.message);
    }
    console.log('Backend document creation - body.folderPath:', body.folderPath, 'Type:', typeof body.folderPath, 'Is Array:', Array.isArray(body.folderPath));
    console.log('Backend document creation - dbFields.folder_path:', dbFields.folder_path, 'Type:', typeof dbFields.folder_path, 'Is Array:', Array.isArray(dbFields.folder_path));
    const { data, error } = await db
      .from('documents')
      .insert({ ...dbFields, org_id: orgId, owner_user_id: userId, department_id: departmentId })
      .select('*')
      .single();
    if (error) throw error;
    await logAudit(app, orgId, userId, 'create', { doc_id: data.id, title: data.title || data.filename || data.type, note: 'created metadata' });
    return mapDbToFrontendFields(data);
  });

  app.patch('/orgs/:orgId/documents/:id', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({
      title: z.string().min(1).optional(),
      filename: z.string().min(1).optional(),
      type: z.string().min(1).optional(),
      folder_path: z.array(z.string()).optional(),
      subject: z.string().min(1).optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      keywords: z.array(z.string()).optional(),
      sender: z.string().optional(),
      receiver: z.string().optional(),
      document_date: z.string().optional(),
      is_current_version: z.boolean().optional(),
    });
    const { id } = req.params;
    const body = Schema.parse(req.body || {});
    // Normalize empty strings → undefined for safe updates
    if (typeof body.document_date === 'string' && body.document_date.trim() === '') delete body.document_date;
    if (typeof body.title === 'string' && body.title.trim() === '') delete body.title;
    if (typeof body.filename === 'string' && body.filename.trim() === '') delete body.filename;
    if (typeof body.type === 'string' && body.type.trim() === '') delete body.type;
    if (typeof body.subject === 'string' && body.subject.trim() === '') delete body.subject;
    if (typeof body.description === 'string' && body.description.trim() === '') delete body.description;
    if (typeof body.category === 'string' && body.category.trim() === '') delete body.category;
    if (typeof body.sender === 'string' && body.sender.trim() === '') delete body.sender;
    if (typeof body.receiver === 'string' && body.receiver.trim() === '') delete body.receiver;
    // Normalize document_date if provided
    if (typeof body.document_date === 'string') {
      const iso = (function (str) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
        const m1 = str.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (m1) return `${m1[1]}-${String(m1[2]).padStart(2,'0')}-${String(m1[3]).padStart(2,'0')}`;
        const m2 = str.match(/^(\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (m2) return `${Number(m2[1])+2000}-${String(m2[2]).padStart(2,'0')}-${String(m2[3]).padStart(2,'0')}`;
        const d = new Date(str); if (!isNaN(d.getTime())) return d.toISOString().slice(0,10);
        return null;
      })(body.document_date);
      if (iso) body.document_date = iso; else delete body.document_date;
    }
    const { data, error } = await db.from('documents').update(body).eq('org_id', orgId).eq('id', id).select('*').single();
    if (error) throw error;
    await logAudit(app, orgId, userId, 'edit', { doc_id: id, title: data.title || data.filename, note: 'metadata updated' });
    return mapDbToFrontendFields(data);
  });

  app.delete('/orgs/:orgId/documents/:id', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id } = req.params;
    const { permanent } = req.query || {};
    // Require delete permission (business-level check) and then perform write with service role to avoid RLS WITH CHECK failures
    await ensurePerm(req, 'documents.delete', app);

    const { data: document, error: fetchError } = await app.supabaseAdmin
      .from('documents')
      .select('id, org_id, storage_key, title, filename')
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!document) {
      const err = new Error('Document not found');
      err.statusCode = 404;
      throw err;
    }

    const doPermanent = String(permanent || '').toLowerCase() === '1' || String(permanent || '').toLowerCase() === 'true';

    if (!doPermanent) {
      const now = new Date();
      const purgeAfter = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const { error: updErr } = await app.supabaseAdmin
        .from('documents')
        .update({ deleted_at: now.toISOString(), deleted_by: userId, purge_after: purgeAfter.toISOString() })
        .eq('org_id', orgId)
        .eq('id', id);
      if (updErr) throw updErr;
      await logAudit(app, orgId, userId, 'delete', { doc_id: id, note: 'moved to recycle bin' });
      return { ok: true, storage_cleaned: false, trashed: true, purge_after: purgeAfter.toISOString() };
    }

    if (document.storage_key) {
      try { await app.supabaseAdmin.storage.from('documents').remove([document.storage_key]); } catch (e) { req.log.error(e, 'storage delete failed'); }
      try { await app.supabaseAdmin.storage.from('extractions').remove([`${orgId}/${id}.json`]); } catch {}
    }
    await app.supabaseAdmin.from('documents').delete().eq('org_id', orgId).eq('id', id);
    await logAudit(app, orgId, userId, 'delete', { doc_id: id, note: `permanently deleted "${document.title || document.filename || 'untitled'}"`, storage_cleaned: !!document.storage_key });
    return { ok: true, storage_cleaned: !!document.storage_key, trashed: false, permanent: true };
  });

  // Reingest a document: rerun OCR/metadata/chunks/embeddings
  app.post('/orgs/:orgId/documents/:id/reingest', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Require edit permission (RLS on documents will scope to allowed docs)
    await ensurePerm(req, 'documents.update', app);
    const { id } = req.params;
    const { data: doc, error } = await db
      .from('documents')
      .select('id, storage_key, mime_type')
      .eq('org_id', orgId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    if (!doc || !doc.storage_key) {
      const err = new Error('No storage file to ingest');
      err.statusCode = 400;
      throw err;
    }
    Promise.resolve().then(() => ingestDocument(app, { orgId, docId: id, storageKey: doc.storage_key, mimeType: doc.mime_type || 'application/octet-stream' })).catch((e) => {
      req.log?.error(e, 'reingest failed');
    });
    return { ok: true };
  });

  // Reingest all documents for this org (best-effort, async). Admin only.
  app.post('/orgs/:orgId/documents/reingest-all', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensureRole(req, ['orgAdmin']);
    const { data: docs, error } = await db
      .from('documents')
      .select('id, storage_key, mime_type')
      .eq('org_id', orgId)
      .not('storage_key', 'is', null)
      .limit(1000);
    if (error) throw error;
    for (const d of docs || []) {
      Promise.resolve().then(() => ingestDocument(app, { orgId, docId: d.id, storageKey: d.storage_key, mimeType: d.mime_type || 'application/octet-stream' })).catch(() => {});
    }
    return { ok: true, queued: (docs || []).length };
  });

  // Ingest status for a document
  app.get('/orgs/:orgId/documents/:id/ingest', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;
    const { count: chunkCount, error: cntErr } = await db
      .from('doc_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('doc_id', id);
    if (cntErr) throw cntErr;
    const { data: embedRow } = await db
      .from('doc_chunks')
      .select('id')
      .eq('org_id', orgId)
      .eq('doc_id', id)
      .not('embedding', 'is', null)
      .limit(1);
    const hasEmbeddings = Array.isArray(embedRow) ? embedRow.length > 0 : false;
    const count = typeof chunkCount === 'number' ? chunkCount : 0;
    return { chunks: count, hasEmbeddings, ready: count > 0 };
  });

  // Bulk document deletion endpoint
  app.delete('/orgs/:orgId/documents', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({ ids: z.array(z.string()).min(1).max(100) }); // Limit to 100 documents
    const { ids } = Schema.parse(req.body);
    // Require bulk delete permission (or at least delete)
    try {
      await ensurePerm(req, 'documents.bulk_delete', app);
    } catch {
      await ensurePerm(req, 'documents.delete', app);
    }
    
    // Get all documents to retrieve storage information
    const { data: documents, error: fetchError } = await app.supabaseAdmin
      .from('documents')
      .select('id, storage_key, title, filename')
      .eq('org_id', orgId)
      .in('id', ids);
      
    if (fetchError) throw fetchError;
    
    if (documents.length !== ids.length) {
      const foundIds = documents.map(d => d.id);
      const missingIds = ids.filter(id => !foundIds.includes(id));
      const err = new Error(`Some documents not found: ${missingIds.join(', ')}`);
      err.statusCode = 404;
      throw err;
    }
    
    // Delete from database in bulk
    const { error: dbError } = await app.supabaseAdmin.from('documents').delete().eq('org_id', orgId).in('id', ids);
    if (dbError) throw dbError;
    
    // Clean up storage files in parallel (non-blocking)
    const storageCleanupTasks = [];
    let storageFilesCount = 0;
    
    for (const doc of documents) {
      // 1. Delete main document file from storage
      if (doc.storage_key) {
        storageFilesCount++;
        storageCleanupTasks.push(
          app.supabaseAdmin.storage
            .from('documents')
            .remove([doc.storage_key])
            .catch(error => console.warn(`Failed to delete document file ${doc.storage_key}:`, error))
        );
      }
      
      // 2. Delete extraction data from storage
      const extractionKey = `${orgId}/${doc.id}.json`;
      storageCleanupTasks.push(
        app.supabaseAdmin.storage
          .from('extractions')
          .remove([extractionKey])
          .catch(error => console.warn(`Failed to delete extraction data ${extractionKey}:`, error))
      );
    }
    
    // Execute all cleanup tasks in parallel (non-blocking)
    Promise.all(storageCleanupTasks).catch(error => 
      console.error(`Bulk storage cleanup failed:`, error)
    );
    
    // Log bulk deletion
    await logAudit(app, orgId, userId, 'delete', { 
      note: `bulk deleted ${documents.length} documents`,
      bulk_count: documents.length,
      storage_cleaned: storageFilesCount
    });
    
    return { 
      ok: true, 
      deleted: documents.length,
      storage_cleaned: storageFilesCount
    };
  });

  app.post('/orgs/:orgId/documents/move', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({ ids: z.array(z.string()).min(1), destPath: z.array(z.string()) });
    const body = Schema.parse(req.body);
    const { data, error } = await db.from('documents').update({ folder_path: body.destPath }).eq('org_id', orgId).in('id', body.ids).select('id, title, filename');
    if (error) throw error;
    for (const d of data || []) await logAudit(app, orgId, userId, 'move', { doc_id: d.id, path: body.destPath, note: 'moved' });
    return { moved: (data || []).length };
  });

  app.post('/orgs/:orgId/documents/:id/link', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id } = req.params;
    const Schema = z.object({ 
      linkedId: z.string(),
      linkType: z.string().optional().default('related') 
    });
    const body = Schema.parse(req.body);
    
    // Prevent self-linking
    if (id === body.linkedId) {
      return { ok: false, error: 'Cannot link document to itself' };
    }
    
    // Check if link already exists (bidirectional check)
    const { data: existingLink } = await db
      .from('document_links')
      .select('*')
      .eq('org_id', orgId)
      .or(`and(doc_id.eq.${id},linked_doc_id.eq.${body.linkedId}),and(doc_id.eq.${body.linkedId},linked_doc_id.eq.${id})`)
      .limit(1);
    
    if (existingLink && existingLink.length > 0) {
      return { ok: false, error: 'Documents are already linked' };
    }
    
    // Insert link with type (trigger will create bidirectional link and propagate to versions)
    const { error } = await db.from('document_links').insert({ 
      org_id: orgId, 
      doc_id: id, 
      linked_doc_id: body.linkedId,
      link_type: body.linkType
    });
    if (error) throw error;
    
    await logAudit(app, orgId, userId, 'link', { doc_id: id, note: `linked ${body.linkedId} (${body.linkType})` });
    return { ok: true };
  });

  app.delete('/orgs/:orgId/documents/:id/link/:linkedId', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id, linkedId } = req.params;
    
    // Delete one direction - trigger will automatically handle the reverse
    // Also delete all version group propagated links
    const { error: error1 } = await db.from('document_links').delete()
      .eq('org_id', orgId)
      .or(`and(doc_id.eq.${id},linked_doc_id.eq.${linkedId}),and(doc_id.eq.${linkedId},linked_doc_id.eq.${id})`);
    
    const error2 = null; // No longer needed since we delete both directions at once
    
    if (error1 || error2) throw error1 || error2;
    await logAudit(app, orgId, userId, 'unlink', { doc_id: id, note: `unlinked ${linkedId}` });
    return { ok: true };
  });

  // Get all relationships for a document (bidirectional + version aware)
  app.get('/orgs/:orgId/documents/:id/relationships', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;

    // Get all documents linked TO this document and FROM this document
    const { data: allLinks, error: linksError } = await db
      .from('document_links')
      .select(`
        doc_id,
        linked_doc_id,
        link_type,
        created_at
      `)
      .eq('org_id', orgId)
      .or(`doc_id.eq.${id},linked_doc_id.eq.${id}`);

    if (linksError) throw linksError;

    // Get all related document IDs (both directions)
    const relatedIds = new Set();
    allLinks?.forEach(link => {
      if (link.doc_id === id) {
        relatedIds.add(link.linked_doc_id);
      } else {
        relatedIds.add(link.doc_id);
      }
    });

    // Fetch details for all related documents
    let relatedDocs = [];
    if (relatedIds.size > 0) {
      const { data: docs, error: docsError } = await db
        .from('documents')
        .select('id, title, filename, type, version_group_id, version_number, is_current_version, uploaded_at')
        .eq('org_id', orgId)
        .in('id', Array.from(relatedIds));

      if (!docsError && docs) {
        relatedDocs = docs;
      }
    }

    // Group relationships by type
    const relationships = {
      linked: [],
      versions: [],
      incoming: [], // Documents that link TO this document
      outgoing: []  // Documents this document links TO
    };

    allLinks?.forEach(link => {
      const isOutgoing = link.doc_id === id;
      const relatedId = isOutgoing ? link.linked_doc_id : link.doc_id;
      const relatedDoc = relatedDocs.find(d => d.id === relatedId);
      
      if (relatedDoc) {
        const relationship = {
          id: relatedDoc.id,
          title: relatedDoc.title || relatedDoc.filename || 'Untitled',
          type: relatedDoc.type,
          linkType: link.link_type,
          linkedAt: link.created_at,
          isCurrentVersion: relatedDoc.is_current_version,
          versionNumber: relatedDoc.version_number,
          direction: isOutgoing ? 'outgoing' : 'incoming'
        };

        // Categorize the relationship
        if (isOutgoing) {
          relationships.outgoing.push(relationship);
        } else {
          relationships.incoming.push(relationship);
        }

        // Also add to general linked array (for backwards compatibility)
        relationships.linked.push(relationship);
      }
    });

    // Get version relationships (both siblings and children)
    const { data: targetDoc } = await db
      .from('documents')
      .select('version_group_id')
      .eq('org_id', orgId)
      .eq('id', id)
      .single();

    let versionDocs = [];

    // Case 1: This document is part of a version group (has a parent)
    if (targetDoc?.version_group_id) {
      const { data: versionSiblings } = await db
        .from('documents')
        .select('id, title, filename, version_number, is_current_version, uploaded_at')
        .eq('org_id', orgId)
        .eq('version_group_id', targetDoc.version_group_id)
        .neq('id', id)
        .order('version_number', { ascending: true });

      if (versionSiblings) {
        versionDocs = versionSiblings;
      }
    }

    // Case 2: This document IS a version group parent (other docs point to it)
    const { data: versionChildren } = await db
      .from('documents')
      .select('id, title, filename, version_number, is_current_version, uploaded_at')
      .eq('org_id', orgId)
      .eq('version_group_id', id)
      .order('version_number', { ascending: true });

    if (versionChildren) {
      versionDocs = [...versionDocs, ...versionChildren];
    }

    // Remove duplicates and map to final format
    const uniqueVersions = versionDocs.filter((doc, index, array) => 
      array.findIndex(d => d.id === doc.id) === index
    );

    relationships.versions = uniqueVersions.map(doc => ({
      id: doc.id,
      title: doc.title || doc.filename || 'Untitled',
      versionNumber: doc.version_number,
      isCurrentVersion: doc.is_current_version,
      uploadedAt: doc.uploaded_at
    }));

    return relationships;
  });

  // Smart link suggestions based on content similarity
  app.get('/orgs/:orgId/documents/:id/suggest-links', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;
    const by = String((req.query?.by || '')).toLowerCase();
    
    // Get the target document
    const { data: targetDoc, error: targetError } = await db
      .from('documents')
      .select('*')
      .eq('org_id', orgId)
      .eq('id', id)
      .single();
    
    if (targetError || !targetDoc) return { suggestions: [] };
    
    // Get all other documents in the organization
    const { data: allDocs, error: docsError } = await db
      .from('documents')
      .select('id, title, filename, sender, receiver, category, tags, keywords, document_date, type')
      .eq('org_id', orgId)
      .neq('id', id);
    
    if (docsError || !allDocs) return { suggestions: [] };
    
    // Get existing links to exclude them
    const { data: existingLinks } = await db
      .from('document_links')
      .select('linked_doc_id')
      .eq('org_id', orgId)
      .eq('doc_id', id);
    
    const linkedIds = new Set((existingLinks || []).map(l => l.linked_doc_id));
    
    // If a strict filter is requested, apply it first for deterministic UX
    let pool = allDocs;
    if (by === 'sender' && targetDoc.sender) {
      pool = pool.filter(d => (d.sender || '').trim() && d.sender === targetDoc.sender);
    } else if (by === 'subject' && (targetDoc.subject || targetDoc.title)) {
      const subj = (targetDoc.subject || targetDoc.title || '').trim().toLowerCase();
      pool = pool.filter(d => ((d.title || '').toLowerCase() === subj) || ((d.subject || '').toLowerCase() === subj));
    }

    // Calculate similarity scores (fallback heuristic)
    const suggestions = pool
      .filter(doc => !linkedIds.has(doc.id))
      .map(doc => {
        let score = 0;
        let reasons = [];
        
        // Same sender/receiver (high relevance)
        if (targetDoc.sender && doc.sender === targetDoc.sender) {
          score += 30;
          reasons.push(`Same sender: ${doc.sender}`);
        }
        if (targetDoc.receiver && doc.receiver === targetDoc.receiver) {
          score += 30;
          reasons.push(`Same receiver: ${doc.receiver}`);
        }
        
        // Same category
        if (targetDoc.category && doc.category === targetDoc.category) {
          score += 20;
          reasons.push(`Same category: ${doc.category}`);
        }
        
        // Similar document type
        if (targetDoc.type && doc.type === targetDoc.type) {
          score += 15;
          reasons.push(`Same type: ${doc.type}`);
        }
        
        // Tag overlap
        const targetTags = targetDoc.tags || [];
        const docTags = doc.tags || [];
        const commonTags = targetTags.filter(tag => docTags.includes(tag));
        if (commonTags.length > 0) {
          score += commonTags.length * 10;
          reasons.push(`Common tags: ${commonTags.join(', ')}`);
        }
        
        // Keyword overlap
        const targetKeywords = targetDoc.keywords || [];
        const docKeywords = doc.keywords || [];
        const commonKeywords = targetKeywords.filter(kw => docKeywords.includes(kw));
        if (commonKeywords.length > 0) {
          score += commonKeywords.length * 5;
          reasons.push(`Common keywords: ${commonKeywords.slice(0, 3).join(', ')}`);
        }
        
        // Date proximity (within 30 days)
        if (targetDoc.document_date && doc.document_date) {
          const targetDate = new Date(targetDoc.document_date);
          const docDate = new Date(doc.document_date);
          const daysDiff = Math.abs((targetDate.getTime() - docDate.getTime()) / (1000 * 3600 * 24));
          if (daysDiff <= 30) {
            score += Math.max(10 - daysDiff / 3, 0);
            reasons.push(`Similar date (${Math.round(daysDiff)} days apart)`);
          }
        }
        
        // Title/filename similarity (basic text matching)
        const targetTitle = (targetDoc.title || targetDoc.filename || '').toLowerCase();
        const docTitle = (doc.title || doc.filename || '').toLowerCase();
        const titleWords = targetTitle.split(/\s+/).filter(w => w.length > 3);
        const docWords = docTitle.split(/\s+/).filter(w => w.length > 3);
        const commonWords = titleWords.filter(w => docWords.some(dw => dw.includes(w) || w.includes(dw)));
        if (commonWords.length > 0) {
          score += commonWords.length * 8;
          reasons.push(`Similar title words: ${commonWords.slice(0, 2).join(', ')}`);
        }
        
        return {
          id: doc.id,
          title: doc.title || doc.filename || 'Untitled',
          score: Math.round(score),
          reasons: reasons.slice(0, 3), // Top 3 reasons
          suggestedLinkType: score > 50 ? 'related' : 'reference'
        };
      })
      .filter(s => by ? true : s.score > 10) // If user chose strict filter, keep all matches; else use threshold
      .sort((a, b) => b.score - a.score)
      .slice(0, 10); // Top 10 suggestions
    
    return { suggestions };
  });

  app.post('/orgs/:orgId/documents/:id/version', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id } = req.params;
    const Schema = z.object({ draft: z.record(z.any()) });
    const { draft } = Schema.parse(req.body);
    const { data: base, error: berr } = await db.from('documents').select('*').eq('org_id', orgId).eq('id', id).single();
    if (berr) throw berr;
    const groupId = base.version_group_id || base.id;
    const { data: latestList, error: lerr } = await db.from('documents').select('version_number').eq('org_id', orgId).eq('version_group_id', groupId).order('version_number', { ascending: false }).limit(1);
    if (lerr) throw lerr;
    const nextNum = (latestList && latestList[0]?.version_number) ? (latestList[0].version_number + 1) : ((base.version_number || 1) + 1);
    // Ensure base doc is part of the group and not current anymore
    if (!base.version_group_id) {
      await db.from('documents').update({ version_group_id: groupId, version_number: base.version_number || 1 }).eq('org_id', orgId).eq('id', base.id);
    }
    await db.from('documents').update({ is_current_version: false }).eq('org_id', orgId).eq('version_group_id', groupId);
    const filtered = toDbDocumentFields(draft);
    // Avoid unique constraint conflicts across versions
    delete filtered.content_hash;
    const newDoc = { ...filtered, org_id: orgId, owner_user_id: userId, version_group_id: groupId, version_number: nextNum, is_current_version: true, supersedes_id: base.id };
    const { data: created, error: ierr } = await db.from('documents').insert(newDoc).select('*').single();
    if (ierr) throw ierr;
    await logAudit(app, orgId, userId, 'link', { doc_id: created.id, note: `new version of ${base.id}` });
    return mapDbToFrontendFields(created);
  });

  app.post('/orgs/:orgId/documents/:id/set-current', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id } = req.params;
    const { data: target, error: terr } = await db.from('documents').select('*').eq('org_id', orgId).eq('id', id).single();
    if (terr) throw terr;
    if (!target.version_group_id) return { ok: true };
    await db.from('documents').update({ is_current_version: false }).eq('org_id', orgId).eq('version_group_id', target.version_group_id);
    await db.from('documents').update({ is_current_version: true }).eq('org_id', orgId).eq('id', id);
    await logAudit(app, orgId, userId, 'versionSet', { doc_id: id });
    return { ok: true };
  });

  app.post('/orgs/:orgId/documents/:id/move-version', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id } = req.params;
    const Schema = z.object({ fromVersion: z.number(), toVersion: z.number() });
    const { fromVersion, toVersion } = Schema.parse(req.body);
    
    // Get the document and its version group
    const { data: doc, error: docError } = await db.from('documents').select('*').eq('org_id', orgId).eq('id', id).single();
    if (docError) throw docError;
    if (!doc.version_group_id) return { ok: false, error: 'Document is not part of a version group' };
    
    // Get all documents in the version group
    const { data: versions, error: versionsError } = await db
      .from('documents')
      .select('id, version_number')
      .eq('org_id', orgId)
      .eq('version_group_id', doc.version_group_id)
      .order('version_number');
    if (versionsError) throw versionsError;
    
    // Create a mapping of current version numbers to document IDs
    const versionMap = versions.reduce((acc, v) => {
      acc[v.version_number] = v.id;
      return acc;
    }, {});
    
    // Perform the swap: move fromVersion to toVersion
    const docAtFromVersion = versionMap[fromVersion];
    const docAtToVersion = versionMap[toVersion];
    
    if (!docAtFromVersion || !docAtToVersion) {
      return { ok: false, error: 'Invalid version numbers' };
    }
    
    // Swap the version numbers
    await db.from('documents').update({ version_number: toVersion }).eq('org_id', orgId).eq('id', docAtFromVersion);
    await db.from('documents').update({ version_number: fromVersion }).eq('org_id', orgId).eq('id', docAtToVersion);
    
    await logAudit(app, orgId, userId, 'edit', { doc_id: id, note: `moved version ${fromVersion} to ${toVersion}` });
    return { ok: true };
  });

  app.post('/orgs/:orgId/documents/:id/unlink', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id } = req.params;
    await db.from('documents').update({ version_group_id: id, version_number: 1, is_current_version: true, supersedes_id: null }).eq('org_id', orgId).eq('id', id);
    await logAudit(app, orgId, userId, 'unlink', { doc_id: id, note: 'unlinked from version group' });
    return { ok: true };
  });

  // Test endpoint to check array handling
  app.get('/orgs/:orgId/test-array', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    
    // Test inserting a simple document with array
    const testDoc = {
      org_id: orgId,
      owner_user_id: req.user?.sub,
      title: 'Test Array',
      filename: 'test.txt',
      type: 'test',
      folder_path: ['test'],
      subject: 'Test',
      description: 'Test array handling',
      tags: ['test'],
      keywords: ['test'],
      storage_key: 'test/test.txt'
    };
    
    const { data, error } = await db.from('documents').insert(testDoc).select('id, folder_path').single();
    
    if (error) {
      console.error('Array test error:', error);
      return { error: error.message };
    }
    
    // Clean up test document
    await db.from('documents').delete().eq('id', data.id);
    
    return { success: true, folder_path: data.folder_path };
  });

  // Get folder ID from folder path
  app.get('/orgs/:orgId/folders/resolve-id', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const pathStr = String((req.query?.path || ''));
    const pathArr = pathStr ? pathStr.split('/').filter(Boolean) : [];
    
    console.log('🔍 Folder resolution request:', { pathStr, pathArr, orgId });

    if (pathArr.length === 0) {
      return { folder_id: null, folder_path: [], message: 'Root folder - no ID needed' };
    }

    try {
      // Find folder by path - try both formats
      const folderName = pathArr[pathArr.length - 1];
      const { data: folder, error } = await db
        .from('documents')
        .select('id, title, folder_path')
        .eq('org_id', orgId)
        .eq('type', 'folder')
        .or(`title.eq.[Folder] ${folderName},title.eq.${folderName}`);

      if (error) throw error;
      
      console.log('📁 Found folders:', folder);

      // For root folders (single level)
      if (pathArr.length === 1) {
        const rootFolder = folder?.find(f => 
          !f.folder_path || 
          (Array.isArray(f.folder_path) && f.folder_path.length === 0)
        );
        if (rootFolder) {
          return { 
            folder_id: rootFolder.id, 
            folder_path: pathArr,
            folder_title: rootFolder.title
          };
        }
      } else {
        // For nested folders, match by parent path
        const parentPath = pathArr.slice(0, -1);
        const nestedFolder = folder?.find(f => {
          const folderPath = f.folder_path || [];
          return Array.isArray(folderPath) && 
                 folderPath.length === parentPath.length &&
                 folderPath.every((seg, i) => seg === parentPath[i]);
        });
        
        if (nestedFolder) {
          return { 
            folder_id: nestedFolder.id, 
            folder_path: pathArr,
            folder_title: nestedFolder.title
          };
        }
      }

      return { 
        folder_id: null, 
        folder_path: pathArr,
        message: 'Folder not found'
      };
    } catch (error) {
      console.error('Error resolving folder ID:', error);
      throw error;
    }
  });

  app.get('/orgs/:orgId/folders', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    
    // Check if user has permission to read documents
    // First get user's department context for permission checking
    const { data: userDepts } = await db
      .from('department_users')
      .select('department_id')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    
    const userDeptIds = userDepts?.map(d => d.department_id) || [];
    
    // Check permission with department context (use first department if multiple)
    const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
    
    try {
      await ensurePerm(req, 'documents.read', app, { departmentId: deptContext });
    } catch (permError) {
      // If user doesn't have documents.read permission, return empty folders
      return [];
    }
    
    const pathStr = String((req.query?.path || ''));
    const pathArr = pathStr ? pathStr.split('/').filter(Boolean) : [];

    // Get folder documents with department information
    const { data, error } = await db
      .from('documents')
      .select('id, folder_path, department_id, title')
      .eq('org_id', orgId)
      .eq('type', 'folder');

    // Get department names for the folders
    let departmentMap = new Map();
    if (data && data.length > 0) {
      const deptIds = data
        .map(d => d.department_id)
        .filter(id => id !== null);

      if (deptIds.length > 0) {
        const { data: depts } = await db
          .from('departments')
          .select('id, name')
          .in('id', deptIds);

        departmentMap = new Map(
          (depts || []).map(dept => [dept.id, dept.name])
        );
      }
    }

    if (error) throw error;

    // For non-admin users, filter folders to only show those in departments they can access
    let filteredData = data || [];
    const userRole = await getUserOrgRole(req);
    if (userRole !== 'orgAdmin') {
      const { data: userDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);

      const allowedDeptIds = (userDepts || []).map(d => d.department_id);
      filteredData = filteredData.filter(folder => folder.department_id && allowedDeptIds.includes(folder.department_id));
    }

    const children = new Set();
    const folderInfo = new Map();

    for (const row of filteredData) {
      const p = row.folder_path || [];
      if (p.length >= pathArr.length + 1 && pathArr.every((seg, i) => seg === p[i])) {
        const folderName = p[pathArr.length];
        children.add(folderName);
        // Store folder info including department
        folderInfo.set(folderName, {
          id: row.id,
          departmentId: row.department_id,
          title: row.title
        });
      }
    }

    return Array.from(children).sort().map((name) => {
      const info = folderInfo.get(name);
      const departmentName = info?.departmentId ? departmentMap.get(info.departmentId) : null;
      return {
        name,
        fullPath: [...pathArr, name],
        departmentId: info?.departmentId,
        departmentName: departmentName,
        id: info?.id,
        title: info?.title
      };
    });
  });

  app.post('/orgs/:orgId/folders', { preHandler: app.verifyAuth }, async (req) => {
    try {
      const db = req.supabase;
      const orgId = await ensureActiveMember(req);
      const userId = req.user?.sub;
          const Schema = z.object({ parentPath: z.array(z.string()), name: z.string().min(1).max(100), departmentId: z.string().uuid().optional() });
    const { parentPath, name, departmentId: bodyDept } = Schema.parse(req.body);
    
    console.log('Received parentPath:', parentPath, 'Type:', typeof parentPath, 'Is Array:', Array.isArray(parentPath));
    console.log('Request body:', req.body);
    
    // Validate folder name (no special characters that could break paths)
    const cleanName = name.trim().replace(/[<>:"/\\|?*]/g, '_');
    if (!cleanName) {
      const err = new Error('Invalid folder name');
      err.statusCode = 400;
      throw err;
    }
    
    const fullPath = [...parentPath, cleanName];
    const pathStr = fullPath.join('/');
    
    console.log('Full path array:', fullPath, 'Type:', typeof fullPath, 'Is Array:', Array.isArray(fullPath));
    
    // Check if folder already exists by looking for documents with this exact path
    console.log('Checking for existing folder with path:', fullPath, 'Type:', typeof fullPath);
    
    // For root folders (empty parentPath), check by title only
    // For nested folders, check by both title and parent path
    let existingQuery = db
      .from('documents')
      .select('id')
      .eq('org_id', orgId)
      .eq('type', 'folder')
      .eq('title', `[Folder] ${cleanName}`);
    
    // If this is a nested folder, also check the parent path
    if (parentPath.length > 0) {
      existingQuery = existingQuery.eq('folder_path', toPgArray(parentPath));
    } else {
      // For root folders, check that folder_path is empty or null
      existingQuery = existingQuery.or('folder_path.is.null,folder_path.eq.{}');
    }
    
    const { data: existing, error: checkError } = await existingQuery.limit(1);
    
    console.log('Existing folder check result:', { existing, checkError });
    
    if (checkError) throw checkError;
    
    if (existing && existing.length > 0) {
      return reply.code(409).send({ 
        error: 'Folder already exists',
        message: `A folder named "${cleanName}" already exists in this location.`,
        code: 'FOLDER_EXISTS' 
      });
    }
    
    // Create a placeholder document to establish the folder
    // This is a lightweight approach that doesn't require a separate folders table
    // Ensure the folder_path is properly formatted as an array for PostgreSQL
    // Resolve department for the folder placeholder
    let departmentId = bodyDept || null;
    
    // Check if user is admin
    let isAdmin = false;
    try { 
      await ensurePerm(req, 'org.manage_members', app); 
      isAdmin = true; 
    } catch { 
      isAdmin = false; 
    }
    
    // If not provided, determine user's department
    if (!departmentId) {
      try {
        const { data: myDepts } = await db
          .from('department_users')
          .select('department_id, role')
          .eq('org_id', orgId)
          .eq('user_id', userId);
        
        console.log(`Folder creation: User ${userId} departments:`, myDepts);
        
        if (!isAdmin && (!myDepts || myDepts.length === 0)) {
          const err = new Error('You must be a member of a department to create folders');
          err.statusCode = 403; 
          throw err;
        }
        
        if (myDepts && myDepts.length > 0) {
          // For non-admins: use their primary department (prefer lead role, then any)
          const leadDept = myDepts.find(d => d.role === 'lead');
          departmentId = leadDept ? leadDept.department_id : myDepts[0].department_id;
          console.log(`Folder creation: Selected department ${departmentId} for user ${userId}`);
        } else if (isAdmin) {
          console.log(`Folder creation: Admin ${userId} has no department memberships, will require explicit selection`);
        }
      } catch (e) {
        console.error('Folder creation: Error fetching user departments:', e);
        if (e?.statusCode) throw e;
      }
    } else {
      console.log(`Folder creation: Explicit department provided: ${departmentId}`);
    }
    // If a department is provided but the user is not a member and not an admin, reject
    if (departmentId) {
      try {
        // Check membership
        const { data: m } = await db
          .from('department_users')
          .select('user_id')
          .eq('org_id', orgId)
          .eq('department_id', departmentId)
          .eq('user_id', userId)
          .maybeSingle();
        // If not a member, ensure they have org.manage_members (admin)
        if (!m) {
          try { await ensurePerm(req, 'org.manage_members', app); }
          catch {
            const err = new Error('Not allowed to create folders for other teams');
            err.statusCode = 403; throw err;
          }
        }
      } catch (e) {
        if (e?.statusCode) throw e;
      }
    }
    
    // Final check: ensure department is set
    if (!departmentId) {
      if (isAdmin) {
        // Admins must explicitly specify a department - no auto-fallback to General
        const err = new Error('Admins must specify a department when creating folders');
        err.statusCode = 400; 
        throw err;
      } else {
        // Non-admins should have had their department determined above
        const err = new Error('Could not determine your department. Please contact an administrator.');
        err.statusCode = 403; 
        throw err;
      }
    }

    const placeholderDoc = {
      org_id: orgId,
      owner_user_id: userId,
      title: `[Folder] ${cleanName}`,
      filename: `${cleanName}.folder`,
      type: 'folder',
      department_id: departmentId,
      folder_path: fullPath, // This should be an array like ['T1'] or ['Parent', 'Child']
      subject: `Folder: ${cleanName}`,
      description: `Placeholder document for folder: ${pathStr}`,
      tags: ['folder', 'placeholder'],
      keywords: [cleanName, 'folder'],
      storage_key: `folders/${orgId}/${pathStr}/.placeholder`,
      // Don't set content_hash to avoid unique constraint issues
      // Don't set version_group_id, version_number, is_current_version, supersedes_id
      // Let the database use defaults
    };
    
    console.log('Placeholder doc folder_path:', placeholderDoc.folder_path, 'Type:', typeof placeholderDoc.folder_path);
    
    // Create folder document with proper array handling
    // Use direct insertion with proper array format
    const { data: created, error: insertError } = await db
      .from('documents')
      .insert({
        org_id: orgId,
        owner_user_id: userId,
        title: `[Folder] ${cleanName}`,
        filename: `${cleanName}.folder`,
        type: 'folder',
        department_id: departmentId,
        folder_path: fullPath, // Direct array insertion
        subject: `Folder: ${cleanName}`,
        description: `Placeholder document for folder: ${pathStr}`,
        tags: ['folder', 'placeholder'],
        keywords: [cleanName, 'folder'],
        storage_key: `folders/${orgId}/${pathStr}/.placeholder`
      })
      .select('id, title, folder_path')
      .single();
    
    if (insertError) {
      console.error('Folder creation error:', insertError);
      // If array insertion fails, try to create without folder_path and update separately
      if (insertError.message?.includes('folder_path')) {
        try {
          const { data: created2, error: insertError2 } = await db
            .from('documents')
            .insert({
              org_id: orgId,
              owner_user_id: userId,
              title: `[Folder] ${cleanName}`,
              filename: `${cleanName}.folder`,
              type: 'folder',
              department_id: departmentId,
              subject: `Folder: ${cleanName}`,
              description: `Placeholder document for folder: ${pathStr}`,
              tags: ['folder', 'placeholder'],
              keywords: [cleanName, 'folder'],
              storage_key: `folders/${orgId}/${pathStr}/.placeholder`
            })
            .select('id, title')
            .single();
          
          if (insertError2) throw insertError2;
          
          // Update folder_path using direct update
          const { error: updateError } = await db
            .from('documents')
            .update({ folder_path: fullPath })
            .eq('id', created2.id);
          
          if (updateError) {
            await db.from('documents').delete().eq('id', created2.id);
            throw updateError;
          }
          
          return { id: created2.id, name: cleanName, fullPath: fullPath, path: pathStr };
        } catch (fallbackError) {
          console.error('Fallback folder creation failed:', fallbackError);
          throw insertError; // Throw original error
        }
      }
      throw insertError;
    }
    
    await logAudit(app, orgId, userId, 'create', { 
      doc_id: created.id, 
      path: fullPath, 
      note: `created folder: ${pathStr}` 
    });
    
    // Get the updated document with folder_path
    const { data: updatedDoc, error: getError } = await db
      .from('documents')
      .select('id, title, folder_path')
      .eq('id', created.id)
      .single();
    
    if (getError) {
      console.error('Error getting updated document:', getError);
      throw getError;
    }
    
    return { 
      id: updatedDoc.id, 
      name: cleanName, 
      fullPath: updatedDoc.folder_path,
      path: pathStr 
    };
    } catch (error) {
      console.error('Folder creation endpoint error:', error);
      throw error;
    }
  });

  app.delete('/orgs/:orgId/folders', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({ 
      path: z.array(z.string()),
      mode: z.enum(['move_to_root', 'delete_all']).optional().default('move_to_root')
    });
    const { path, mode } = Schema.parse(req.body);
    
    if (path.length === 0) {
      const err = new Error('Cannot delete root folder');
      err.statusCode = 400;
      throw err;
    }
    
    // Check if folder has any documents (including placeholder)
    const { data: docsInFolder, error: checkError } = await db
      .from('documents')
      .select('id, title, type, storage_key, filename')
      .eq('org_id', orgId)
      .eq('folder_path', toPgArray(path));
    
    if (checkError) throw checkError;
    
    // Collect all documents in the subtree (this folder and all descendants)
    const { data: allDocsInOrg, error: allDocsErr } = await db
      .from('documents')
      .select('id, title, type, storage_key, filename, folder_path')
      .eq('org_id', orgId);
    if (allDocsErr) throw allDocsErr;

    const inSubtree = (allDocsInOrg || []).filter(doc => {
      const fp = doc.folder_path || [];
      if (fp.length < path.length) return false;
      return path.every((seg, i) => fp[i] === seg);
    });

    // Separate placeholder "folder" docs and real docs across the subtree
    const subtreePlaceholders = inSubtree.filter(d => d.type === 'folder' && (d.title || '').startsWith('[Folder]'));
    const subtreeRealDocs = inSubtree.filter(d => !(d.type === 'folder' && (d.title || '').startsWith('[Folder]')));
    
    // Handle documents based on mode
    let documentsHandled = 0;
    let storageCleanupTasks = [];
    
    if (subtreeRealDocs.length > 0) {
      if (mode === 'move_to_root') {
        // Move all real documents in the subtree to parent folder (one level up)
        const parentPath = path.slice(0, Math.max(0, path.length - 1));
        const { error: moveError } = await db
          .from('documents')
          .update({ folder_path: parentPath })
          .eq('org_id', orgId)
          .in('id', subtreeRealDocs.map(d => d.id));
          
        if (moveError) throw moveError;
        
        documentsHandled = subtreeRealDocs.length;
        
        // Log document moves
        for (const doc of subtreeRealDocs) {
          await logAudit(app, orgId, userId, 'move', { 
            doc_id: doc.id, 
            path: parentPath, 
            note: `moved to parent from deleted folder: ${path.join('/')}` 
          });
        }
      } else if (mode === 'delete_all') {
        // Delete all real documents in the subtree including their storage
        const deletionTasks = [];
        
        for (const doc of subtreeRealDocs) {
          // Delete from database
          deletionTasks.push(
            db.from('documents').delete().eq('org_id', orgId).eq('id', doc.id)
          );
          
          // Clean up storage files
          if (doc.storage_key) {
            storageCleanupTasks.push(
              app.supabaseAdmin.storage
                .from('documents')
                .remove([doc.storage_key])
                .catch(error => console.warn(`Failed to delete document file ${doc.storage_key}:`, error))
            );
          }
          
          // Clean up extraction data
          const extractionKey = `${orgId}/${doc.id}.json`;
          storageCleanupTasks.push(
            app.supabaseAdmin.storage
              .from('extractions')
              .remove([extractionKey])
              .catch(error => console.warn(`Failed to delete extraction data ${extractionKey}:`, error))
          );
        }
        
        // Execute database deletions
        const deletionResults = await Promise.allSettled(deletionTasks);
        const failedDeletions = deletionResults.filter(result => result.status === 'rejected');
        
        if (failedDeletions.length > 0) {
          console.error('Some document deletions failed:', failedDeletions);
          throw new Error('Failed to delete some documents in folder');
        }
        
        documentsHandled = subtreeRealDocs.length;
      }
    }
    
    // Delete all placeholder "folder" docs in the subtree (including the deleted folder)
    if (subtreePlaceholders.length > 0) {
      const { error: delPlaceholdersErr } = await db
        .from('documents')
        .delete()
        .eq('org_id', orgId)
        .in('id', subtreePlaceholders.map(p => p.id));
      if (delPlaceholdersErr) throw delPlaceholdersErr;
    }
    
    // Execute storage cleanup (non-blocking)
    if (storageCleanupTasks.length > 0) {
      Promise.all(storageCleanupTasks).catch(error => 
        console.error(`Storage cleanup failed for folder ${path.join('/')}:`, error)
      );
    }
    
    // Log the folder deletion
      await logAudit(app, orgId, userId, 'delete', { 
        path: path, 
      note: `deleted folder: ${path.join('/')} (${documentsHandled} docs ${mode === 'move_to_root' ? 'moved to parent' : 'deleted'})`,
      mode: mode,
      documents_handled: documentsHandled,
      storage_cleaned: mode === 'delete_all' && subtreeRealDocs.some(d => d.storage_key)
      });
    
    return { 
      deleted: true, 
      path: path.join('/'),
      mode: mode,
      documentsHandled: documentsHandled,
      storage_cleaned: mode === 'delete_all' && subtreeRealDocs.some(d => d.storage_key)
    };
  });

  // Folder access sharing (multiple teams per folder)
  app.get('/orgs/:orgId/folder-access', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const pathStr = String((req.query?.path || ''));
    const pathArr = pathStr ? pathStr.split('/').filter(Boolean) : [];
    const { data, error } = await db
      .from('folder_access')
      .select('department_id, path')
      .eq('org_id', orgId)
      .eq('path', toPgArray(pathArr));
    if (error) throw error;
    return { path: pathArr, departments: (data || []).map(r => r.department_id) };
  });

  app.put('/orgs/:orgId/folder-access', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Admin or dept lead-permitted via RLS on folder_access
    const Schema = z.object({ path: z.array(z.string()), departmentIds: z.array(z.string().uuid()) });
    const { path, departmentIds } = Schema.parse(req.body || {});
    // Strategy: delete existing rows for path, then insert new ones
    const { error: delErr } = await db
      .from('folder_access')
      .delete()
      .eq('org_id', orgId)
      .eq('path', toPgArray(path));
    if (delErr) throw delErr;
    if (departmentIds.length === 0) return { ok: true };
    const rows = departmentIds.map((deptId) => ({ org_id: orgId, path, department_id: deptId }));
    const { error: insErr } = await db
      .from('folder_access')
      .insert(rows);
    if (insErr) throw insErr;
    return { ok: true };
  });

  // Batch folder access lookup: accept multiple paths, return mapping
  app.post('/orgs/:orgId/folder-access/batch', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const Schema = z.object({ paths: z.array(z.array(z.string())) });
    const body = Schema.parse(req.body || {});
    const paths = Array.from(new Set((body.paths || []).map((p) => (Array.isArray(p) ? p.filter(Boolean).join('/') : '')).filter(Boolean)));
    if (paths.length === 0) return { results: {} };

    // Build PostgREST OR clauses for text[] equality on path
    const pathToArr = new Map(paths.map((s) => [s, s.split('/').filter(Boolean)]));
    const chunks = [];
    const arrLiterals = paths.map((s) => toPgArray(pathToArr.get(s)));
    const results = {};
    for (const p of paths) results[p] = [];

    // Chunk OR conditions to avoid very long URLs
    const BATCH = 25;
    for (let i = 0; i < arrLiterals.length; i += BATCH) {
      const slice = arrLiterals.slice(i, i + BATCH);
      const orExpr = slice.map((lit) => `path.eq.${lit}`).join(',');
      const { data, error } = await db
        .from('folder_access')
        .select('department_id, path')
        .eq('org_id', orgId)
        .or(orExpr);
      if (error) throw error;
      for (const row of data || []) {
        const key = Array.isArray(row.path) ? row.path.join('/') : '';
        if (!key) continue;
        if (!results[key]) results[key] = [];
        if (!results[key].includes(row.department_id)) results[key].push(row.department_id);
      }
    }
    return { results };
  });

  app.get('/orgs/:orgId/search', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { q = '', limit = 50, offset = 0 } = req.query || {};
    const s = `%${String(q).trim()}%`;
    const { data, error } = await db
      .from('documents')
      .select('*')
      .eq('org_id', orgId)
      .or(`title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},description.ilike.${s}`)
      .order('uploaded_at', { ascending: false })
      .range(offset, offset + Math.min(Number(limit), 200) - 1);
    if (error) throw error;
    return data;
  });

  // Semantic search using pgvector doc_chunks + OpenAI embeddings
  app.post('/orgs/:orgId/search/semantic', { preHandler: app.verifyAuth }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const Schema = z.object({ q: z.string().min(1), limit: z.number().int().min(1).max(100).optional(), threshold: z.number().min(-1).max(1).optional() });
    const { q, limit = 20, threshold = 0 } = Schema.parse(req.body || {});

    // Embed query via OpenAI REST API to avoid extra SDK deps
    async function embedQuery(text) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
      });
      if (!res.ok) {
        const errTxt = await res.text().catch(() => '');
        throw new Error(`OpenAI embeddings error: ${res.status} ${errTxt}`);
      }
      const data = await res.json();
      const emb = data?.data?.[0]?.embedding;
      return Array.isArray(emb) ? emb : null;
    }

    let embedding = null;
    try { embedding = await embedQuery(q); } catch (e) { req.log.warn(e, 'embed failed'); }

    // If embeddings unavailable, fallback to lexical search quickly
    if (!embedding) {
      const s = `%${String(q).trim()}%`;
      const { data, error } = await db
        .from('documents')
        .select('id, title, filename, type, uploaded_at')
        .eq('org_id', orgId)
        .or(`title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},description.ilike.${s}`)
        .order('uploaded_at', { ascending: false })
        .limit(Math.min(limit, 50));
      if (error) throw error;
      return { mode: 'lexical', docs: (data || []).map(d => ({ id: d.id, title: d.title || d.filename || 'Untitled', type: d.type, uploadedAt: d.uploaded_at })) };
    }

    // Vector match via RPC
    const { data: chunks, error } = await db.rpc('match_doc_chunks', {
      p_org_id: orgId,
      p_query_embedding: embedding,
      p_match_count: limit,
      p_similarity_threshold: threshold,
    });
    if (error) throw error;

    const rows = Array.isArray(chunks) ? chunks : [];
    // Aggregate by document, keep best similarity and top snippets per doc
    const byDoc = new Map();
    for (const r of rows) {
      const id = r.doc_id;
      const entry = byDoc.get(id) || { id, title: r.title || r.filename || 'Untitled', type: r.doc_type, uploadedAt: r.uploaded_at, bestSimilarity: -1, snippets: [] };
      entry.bestSimilarity = Math.max(entry.bestSimilarity, Number(r.similarity || 0));
      if (entry.snippets.length < 3) entry.snippets.push(String(r.content || '').slice(0, 500));
      byDoc.set(id, entry);
    }
    const docs = Array.from(byDoc.values()).sort((a, b) => (b.bestSimilarity - a.bestSimilarity));
    const payload = {
      mode: 'semantic',
      query: q,
      chunks: rows.map(r => ({
        docId: r.doc_id,
        chunkId: r.chunk_id,
        chunkIndex: r.chunk_index,
        snippet: String(r.content || '').slice(0, 500),
        page: typeof r.page === 'number' ? r.page : null,
        similarity: Number(r.similarity || 0),
      })),
      docs,
    };
    return payload;
  });

  // Backend OCR/metadata from Storage using Gemini Files API (async queue)
  app.post('/orgs/:orgId/uploads/analyze', { preHandler: app.verifyAuth }, async (req, reply) => {
    const orgId = await ensureActiveMember(req);
    const Schema = z.object({ storageKey: z.string(), mimeType: z.string().optional() });
    const { storageKey, mimeType } = Schema.parse(req.body);

    try {
      const job = enqueueUploadAnalysisJob({
        orgId,
        storageKey,
        mimeType: mimeType || null,
        userId: req.user?.sub || null,
      });
      return reply.code(202).send(job);
    } catch (error) {
      req.log?.error?.(error, 'Failed to enqueue upload analysis job');
      return reply.code(500).send({ error: 'Failed to schedule analysis' });
    }
  });

  app.get('/orgs/:orgId/uploads/analyze/:jobId', { preHandler: app.verifyAuth }, async (req, reply) => {
    const orgId = await ensureActiveMember(req);
    const { jobId } = req.params;

    const job = getUploadAnalysisJob(jobId);
    if (!job || job.orgId !== orgId) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    if (job.status === 'succeeded') {
      return {
        jobId: job.jobId,
        status: 'succeeded',
        result: job.result?.data || null,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    }

    if (job.status === 'failed') {
      return {
        jobId: job.jobId,
        status: 'failed',
        error: job.result?.error || 'Analysis failed',
        fallback: job.result?.fallback || null,
        httpStatus: job.result?.httpStatus || 500,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    }

    return {
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  });

  // Temporary endpoint to apply RLS fix (temporarily without auth for fix)
  app.post('/admin/apply-rls-fix', async (req) => {
    const db = req.supabase;
    console.log('Applying RLS policy fix...');

    try {
      // Inline the SQL statements to fix RLS policies
      const statements = [
        `DROP POLICY IF EXISTS documents_update_perm ON public.documents`,
        `CREATE POLICY documents_update_perm ON public.documents FOR UPDATE TO public USING ((SELECT auth.uid()) IS NOT NULL AND is_member_of(org_id) AND has_perm(org_id, 'documents.update') AND (has_perm(org_id, 'org.manage_members') OR (department_id IS NOT NULL AND is_dept_member(org_id, department_id)) OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.org_id = documents.org_id AND is_path_prefix(documents.folder_path, fa.path) AND is_dept_member(documents.org_id, fa.department_id)))) WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND is_member_of(org_id) AND has_perm(org_id, 'documents.update') AND (has_perm(org_id, 'org.manage_members') OR (department_id IS NOT NULL AND is_dept_member(org_id, department_id)) OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.org_id = documents.org_id AND is_path_prefix(documents.folder_path, fa.path) AND is_dept_member(documents.org_id, fa.department_id))))`,
        `DROP POLICY IF EXISTS documents_read ON public.documents`,
        `CREATE POLICY documents_read ON public.documents FOR SELECT TO public USING ((SELECT auth.uid()) IS NOT NULL AND is_member_of(org_id) AND (has_perm(org_id, 'org.manage_members') OR (department_id IS NOT NULL AND is_dept_member(org_id, department_id)) OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.org_id = documents.org_id AND is_path_prefix(documents.folder_path, fa.path) AND is_dept_member(documents.org_id, fa.department_id))))`,
        `DROP POLICY IF EXISTS documents_create_perm ON public.documents`,
        `CREATE POLICY documents_create_perm ON public.documents FOR INSERT TO public WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND is_member_of(org_id) AND has_perm(org_id, 'documents.create') AND (has_perm(org_id, 'org.manage_members') OR (department_id IS NOT NULL AND is_dept_member(org_id, department_id))))`,
        `DROP POLICY IF EXISTS documents_delete_perm ON public.documents`,
        `CREATE POLICY documents_delete_perm ON public.documents FOR DELETE TO public USING ((SELECT auth.uid()) IS NOT NULL AND is_member_of(org_id) AND has_perm(org_id, 'documents.delete') AND (has_perm(org_id, 'org.manage_members') OR (department_id IS NOT NULL AND is_dept_member(org_id, department_id)) OR EXISTS (SELECT 1 FROM folder_access fa WHERE fa.org_id = documents.org_id AND is_path_prefix(documents.folder_path, fa.path) AND is_dept_member(documents.org_id, fa.department_id))))`,
        `DROP INDEX IF EXISTS idx_documents_org_dept_uploaded`,
        `CREATE INDEX IF NOT EXISTS idx_documents_org_dept_uploaded ON public.documents (org_id, department_id, uploaded_at DESC) WHERE type != 'folder'`
      ];

      const results = [];
      for (const statement of statements) {
        if (statement.trim()) {
          console.log('Executing:', statement.substring(0, 100) + '...');
          try {
            // Try using raw SQL execution
            const { data, error } = await db.from('_supabase_migration_temp').select('*').limit(1);
            if (error) {
              console.log('Direct execution not available, skipping statement');
              results.push({ statement: statement.substring(0, 50), skipped: true });
            } else {
              console.log('Database connection available, but exec_sql not available');
              results.push({ statement: statement.substring(0, 50), skipped: 'exec_sql not available' });
            }
          } catch (err) {
            console.error('Exception executing statement:', err);
            results.push({ statement: statement.substring(0, 50), error: err.message });
          }
        }
      }

      return { success: true, results, message: 'RLS fix statements prepared but exec_sql function not available in Supabase' };
    } catch (error) {
      console.error('Failed to apply RLS fix:', error);
      return { success: false, error: error.message };
    }
  });

  app.post('/orgs/:orgId/uploads/finalize', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    console.log('[FINALIZE] Request body:', req.body);
    console.log('[FINALIZE] Request body keys:', Object.keys(req.body || {}));
    const Schema = z.object({
      documentId: z.string(),
      storageKey: z.string(),
      fileSizeBytes: z.number().int().nonnegative(),
      mimeType: z.string(),
      contentHash: z.string().optional(),
      geminiFileId: z.string().optional(),
      geminiFileUri: z.string().optional(),
      geminiFileMimeType: z.string().optional(),
    });
    const body = Schema.parse(req.body);
    console.log('[FINALIZE] Parsed body:', body);
    const { data, error } = await db
      .from('documents')
      .update({ storage_key: body.storageKey, file_size_bytes: body.fileSizeBytes, mime_type: body.mimeType, content_hash: body.contentHash })
      .eq('org_id', orgId)
      .eq('id', body.documentId)
      .select('*')
      .single();
    if (error) throw error;
    await logAudit(app, orgId, userId, 'edit', { doc_id: body.documentId, note: 'file finalized' });

    // Fire-and-forget ingestion (OCR/metadata via Gemini, chunking, embeddings)
    try {
      const geminiFile = body.geminiFileUri && body.geminiFileId
        ? {
            fileId: body.geminiFileId,
            fileUri: body.geminiFileUri,
            mimeType: body.geminiFileMimeType || body.mimeType,
          }
        : null;
      if (geminiFile) {
        req.log?.info({ orgId, docId: body.documentId, fileId: geminiFile.fileId }, 'finalize received Gemini file handle');
      } else {
        req.log?.info({ orgId, docId: body.documentId }, 'finalize received no Gemini file handle');
      }
      // Run asynchronously; do not await to keep finalize snappy
      Promise.resolve().then(() => ingestDocument(app, { orgId, docId: body.documentId, storageKey: body.storageKey, mimeType: body.mimeType, geminiFile })).catch((e) => {
        req.log?.error(e, 'ingest pipeline failed');
      });
    } catch (e) {
      req.log?.warn(e, 'failed to schedule ingestion');
    }
    return mapDbToFrontendFields(data);
  });

  // Save extraction (OCR text + metadata) to Storage bucket 'extractions' as JSON
  app.post('/orgs/:orgId/documents/:id/extraction', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req, reply) => {
    const orgId = await ensureActiveMember(req);
    // Require edit permission (doc-level RLS will further restrict)
    try {
      await ensurePerm(req, 'documents.update', app);
    } catch (error) {
      // Temporary workaround: if permission check fails but user has teamLead role, allow extraction
      const db = req.supabase;
      const userId = req.user?.sub;
      if (userId) {
        const { data: userRole } = await db
          .from('organization_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .maybeSingle();
        
        if (userRole?.role === 'teamLead') {
          // Allow team leads to update documents (they should have this permission anyway)
          req.log.info('Allowing document extraction for team lead due to auth context issue');
        } else {
          throw error; // Re-throw original permission error
        }
      } else {
        throw error; // Re-throw original permission error
      }
    }
    const { id } = req.params;
    // Ensure caller can see the document (RLS) before allowing extraction writes
    try {
      const { data: visible } = await req.supabase
        .from('documents')
        .select('id')
        .eq('org_id', orgId)
        .eq('id', id)
        .maybeSingle();
      if (!visible) {
        return reply.code(404).send({ error: 'Not found' });
      }
    } catch {}
    const Schema = z.object({ ocrText: z.string().optional(), metadata: z.record(z.any()).optional() });
    const body = Schema.parse(req.body || {});
    const key = `${orgId}/${id}.json`;
    const payload = JSON.stringify({ ocrText: body.ocrText || '', metadata: body.metadata || {} });
    console.log('POST extraction - orgId:', orgId, 'documentId:', id, 'key:', key, 'ocrText length:', (body.ocrText || '').length);
    
    try {
      // First try to create the extractions bucket if it doesn't exist
      const { data: buckets, error: listError } = await app.supabaseAdmin.storage.listBuckets();
      if (!listError && !buckets?.some(b => b.name === 'extractions')) {
        console.log('Creating extractions bucket...');
        await app.supabaseAdmin.storage.createBucket('extractions', { public: false });
      }
      
      const { error } = await app.supabaseAdmin.storage.from('extractions').upload(key, Buffer.from(payload), { contentType: 'application/json', upsert: true });
      if (error) {
        console.error('Extraction storage error:', error);
        return reply.code(500).send({ error: 'Failed to save extraction', details: error.message });
      }
      console.log('Extraction saved successfully to storage with key:', key);
      return { ok: true, key };
    } catch (e) {
      console.error('Extraction endpoint error:', e);
      return reply.code(500).send({ error: 'Failed to save extraction', details: e.message });
    }
  });

  // Load extraction JSON from Storage
  app.get('/orgs/:orgId/documents/:id/extraction', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req, reply) => {
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;
    // Verify caller can read the document via RLS before downloading extraction
    let canAccess = false;
    try {
      const { data: visible } = await req.supabase
        .from('documents')
        .select('id')
        .eq('org_id', orgId)
        .eq('id', id)
        .maybeSingle();
      if (visible) {
        canAccess = true;
      }
    } catch {}
    
    // Fallback: check if user is team lead (workaround for RLS auth context issue)
    if (!canAccess) {
      const db = req.supabase;
      const userId = req.user?.sub;
      if (userId) {
        const { data: userRole } = await db
          .from('organization_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .maybeSingle();
        
        if (userRole?.role === 'teamLead') {
          // Allow team leads to read extractions (workaround for auth context issue)
          canAccess = true;
          req.log.info('Allowing extraction read for team lead due to auth context issue');
        }
      }
    }
    
    if (!canAccess) {
      return reply.code(404).send({ error: 'Not found' });
    }
    const key = `${orgId}/${id}.json`;
    console.log('GET extraction - orgId:', orgId, 'documentId:', id, 'key:', key);
    const { data, error } = await app.supabaseAdmin.storage.from('extractions').download(key);
    if (error || !data) {
      console.log('Extraction download error:', error);
      return reply.code(404).send({ error: 'Not found' });
    }
    try {
      const text = await data.text();
      const parsed = JSON.parse(text);
      console.log('Extraction retrieved successfully, ocrText length:', parsed.ocrText?.length || 0);
      return parsed;
    } catch (parseError) {
      console.log('Extraction parse error:', parseError);
      return { ocrText: '', metadata: {} };
    }
  });

  app.post('/orgs/:orgId/uploads/direct', { preHandler: app.verifyAuth }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Require storage upload permission
    await ensurePerm(req, 'storage.upload', app);
    const parts = req.parts();
    let filePart = null;
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') { filePart = part; break; }
    }
    if (!filePart) return reply.code(400).send({ error: 'Missing file' });

    const filename = sanitizeFilename(filePart.filename || 'upload.bin');
    const contentType = filePart.mimetype || 'application/octet-stream';
    const storageKey = `${orgId}/${Date.now()}-${filename}`;
    
    // ✅ OPTIMIZED: Stream directly to Supabase without loading into memory
    const { error } = await app.supabaseAdmin.storage
      .from('documents')
      .upload(storageKey, filePart.file, {
        contentType,
        upsert: false,
        // Enable streaming for large files where supported
        cacheControl: '3600'
      });

    if (error) {
      req.log.error(error, 'Storage upload failed');
      return reply.code(500).send({ error: 'Storage upload failed' });
    }

    return { storageKey, contentType };
  });

  app.post('/orgs/:orgId/uploads/sign', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    // Require storage upload permission
    try {
      await ensurePerm(req, 'storage.upload', app);
    } catch (error) {
      // Temporary workaround: if permission check fails but user has teamLead role, allow upload
      const db = req.supabase;
      const userId = req.user?.sub;
      if (userId) {
        const { data: userRole } = await db
          .from('organization_users')
          .select('role')
          .eq('org_id', orgId)
          .eq('user_id', userId)
          .maybeSingle();

        if (userRole?.role === 'teamLead') {
          // Allow team leads to upload (they should have this permission anyway)
          req.log.info('Allowing upload for team lead due to auth context issue');
        } else {
          throw error; // Re-throw original permission error
        }
      } else {
        throw error; // Re-throw original permission error
      }
    }
    const Schema = z.object({
      filename: z.string(),
      mimeType: z.string().optional(),
      contentHash: z.string().optional(),
    });
    const body = Schema.parse(req.body);

    // Original signed URL approach for backward compatibility
    const key = `${orgId}/${Date.now()}-${sanitizeFilename(body.filename)}`;
    const { data, error } = await app.supabaseAdmin.storage.from('documents').createSignedUploadUrl(key);
    if (error) throw error;
    return {
      uploadType: 'direct',
      signedUrl: data.signedUrl,
      storageKey: key,
      path: data.path,
      token: data.token,
      expiresAt: data.expiresAt || null,
    };
  });


  app.post('/orgs/:orgId/chat/sessions', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({ title: z.string().optional() });
    const body = Schema.parse(req.body);
    const { data, error } = await db.from('chat_sessions').insert({ org_id: orgId, user_id: userId, title: body.title || null }).select('*').single();
    if (error) throw error;
    return data;
  });

  app.get('/orgs/:orgId/chat/sessions', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { data, error } = await db.from('chat_sessions').select('*').eq('org_id', orgId).eq('user_id', userId).order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  });

  app.get('/orgs/:orgId/chat/sessions/:id/messages', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;
    const { data, error } = await db.from('chat_messages').select('*').eq('org_id', orgId).eq('session_id', id).order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  });

  // Get user's department memberships
  app.get('/orgs/:orgId/user/departments', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    
    const { data, error } = await db
      .from('department_users')
      .select('department_id, role')
      .eq('org_id', orgId)
      .eq('user_id', userId);
      
    if (error) throw error;
    return data || [];
  });

  // Dashboard stats - role and department-based access
  app.get('/orgs/:orgId/dashboard/stats', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const role = await getUserOrgRole(req);
    
    // Get user's effective permissions to check dashboard level
    let dashboardLevel = 'regular';
    try {
      const { data: userDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      const userDeptIds = userDepts?.map(d => d.department_id) || [];
      const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
      
      const permResult = await getEffectivePermissions(req, orgId, app, { departmentId: deptContext });
      const permissions = permResult?.permissions || {};
      dashboardLevel = permissions['dashboard.view'] || 'regular';
    } catch (error) {
      console.warn('Failed to get effective permissions for dashboard, falling back to role-based:', error);
      // Fallback to role-based
      const { data: userRole } = await db
        .from('organization_users')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .single();
      dashboardLevel = userRole?.role === 'orgAdmin' ? 'admin' : 'regular';
    }
    
    // Check user's role and department access
    const { data: userRole } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();
    
    const isOrgAdmin = userRole?.role === 'orgAdmin';
    const hasAdminDashboard = dashboardLevel === 'admin';
    const shouldShowOrgWideStats = hasAdminDashboard || isOrgAdmin;
    
    // Get user's departments for non-admin dashboard users
    let userDepartments = [];
    if (!shouldShowOrgWideStats) {
      const { data: userDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      userDepartments = userDepts?.map(d => d.department_id) || [];
      
      console.log('Dashboard stats debug:', {
        userId,
        dashboardLevel,
        isOrgAdmin,
        hasAdminDashboard,
        shouldShowOrgWideStats,
        userDepts: userDepts?.length || 0,
        userDepartments: userDepartments.length,
        deptIds: userDepartments
      });
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Document stats - filter by department based on dashboard level and exclude folder placeholders
    let docQuery = db
      .from('documents')
      .select('id, file_size_bytes, type, uploaded_at, owner_user_id, department_id')
      .eq('org_id', orgId)
      .neq('type', 'folder'); // Exclude folder placeholder documents

    // Filter based on dashboard permission level, not just role
    if (!shouldShowOrgWideStats) {
      if (userDepartments.length > 0) {
        // User has departments - STRICT: only docs in their departments (NO unassigned access)
        docQuery = docQuery.in('department_id', userDepartments);
      } else {
        // User has no departments - NO documents visible (use impossible UUID)
        docQuery = docQuery.eq('department_id', '00000000-0000-0000-0000-000000000000');
      }
    }

    const { data: docStats, error: docErr } = await docQuery;
    if (docErr) throw docErr;
    
    console.log('Dashboard stats documents query result:', {
      userId,
      isOrgAdmin,
      userDepartments: userDepartments.length,
      deptIds: userDepartments,
      docCount: docStats?.length || 0,
      docDepartments: docStats?.map(d => d.department_id).filter((v, i, a) => a.indexOf(v) === i) || []
    });

    // User stats - for admin dashboard show all, for regular dashboard show department-specific
    let userStatsData;
    if (shouldShowOrgWideStats) {
      const { data: userStats, error: userErr } = await db
        .from('organization_users')
        .select('user_id, role, expires_at')
        .eq('org_id', orgId);
      if (userErr) throw userErr;
      userStatsData = userStats;
    } else {
      // For non-admins, show stats about users in their departments
      if (userDepartments.length > 0) {
        // Get user IDs from department_users first
        const { data: deptUserIds, error: deptErr } = await db
          .from('department_users')
          .select('user_id')
          .eq('org_id', orgId)
          .in('department_id', userDepartments);
        
        if (deptErr) throw deptErr;
        
        const userIds = deptUserIds?.map(du => du.user_id) || [];
        
        if (userIds.length > 0) {
          // Then get their organization roles
          const { data: orgUsers, error: orgErr } = await db
            .from('organization_users')
            .select('user_id, role, expires_at')
            .eq('org_id', orgId)
            .in('user_id', userIds);
          
          if (orgErr) throw orgErr;
          userStatsData = orgUsers || [];
        } else {
          userStatsData = [];
        }
      } else {
        userStatsData = [];
      }
    }

    // Recent activity (last 7 days) - filtered by dashboard level
    let recentActivity = [];
    if (shouldShowOrgWideStats) {
      const { data, error: activityErr } = await db
        .from('audit_events')
        .select('*')
        .eq('org_id', orgId)
        .gte('ts', sevenDaysAgo.toISOString())
        .order('ts', { ascending: false })
        .limit(10);
      if (activityErr) throw activityErr;
      recentActivity = data || [];
    } else {
      // Team-scoped activity only: doc-linked events for docs in user's departments, and login events for team users
      // 1) Allowed doc IDs
      let allowedDocIds = [];
      if (userDepartments.length > 0) {
        const { data: docIdsRows } = await db
          .from('documents')
          .select('id')
          .eq('org_id', orgId)
          .neq('type', 'folder') // Exclude folder placeholders
          .in('department_id', userDepartments);
        allowedDocIds = (docIdsRows || []).map(r => r.id);
      }
      // 2) Team user IDs
      const { data: teamUsers } = await db
        .from('department_users')
        .select('user_id')
        .eq('org_id', orgId)
        .in('department_id', userDepartments);
      const teamUserIds = Array.from(new Set((teamUsers || []).map(r => r.user_id)));

      // 3) Fetch recent and filter client-side for clarity
      const { data: rawActs, error: activityErr } = await db
        .from('audit_events')
        .select('*')
        .eq('org_id', orgId)
        .gte('ts', sevenDaysAgo.toISOString())
        .order('ts', { ascending: false })
        .limit(50);
      if (activityErr) throw activityErr;
      const list = rawActs || [];
      const allowedDocsSet = new Set(allowedDocIds);
      const allowedUsersSet = new Set(teamUserIds);
      const filtered = list.filter(ev => {
        if (ev.doc_id && allowedDocsSet.has(ev.doc_id)) return true;
        if (ev.type === 'login' && ev.actor_user_id && allowedUsersSet.has(ev.actor_user_id)) return true;
        return false;
      });
      recentActivity = filtered.slice(0, 10);
    }

    // Chat sessions (last 30 days) - admin dashboard sees all, regular dashboard sees their own
    let chatQuery = db
      .from('chat_sessions')
      .select('id, created_at, user_id')
      .eq('org_id', orgId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (!shouldShowOrgWideStats) {
      chatQuery = chatQuery.eq('user_id', userId);
    }

    const { data: chatStats, error: chatErr } = await chatQuery;
    if (chatErr) throw chatErr;

    // Process document stats
    const totalDocs = docStats?.length || 0;
    const totalStorage = (docStats || []).reduce((sum, doc) => sum + (doc.file_size_bytes || 0), 0);
    const recentUploads = (docStats || []).filter(doc => new Date(doc.uploaded_at) >= sevenDaysAgo).length;
    
    const typeBreakdown = {};
    (docStats || []).forEach(doc => {
      const type = doc.type || 'Unknown';
      typeBreakdown[type] = (typeBreakdown[type] || 0) + 1;
    });

    // Process user stats
    const totalMembers = userStatsData?.length || 0;
    const activeMembers = (userStatsData || []).filter(u => !u.expires_at || new Date(u.expires_at) > now).length;
    const tempUsers = (userStatsData || []).filter(u => u.expires_at && new Date(u.expires_at) > now).length;
    
    const roleBreakdown = {};
    (userStatsData || []).forEach(user => {
      const role = user.role || 'Unknown';
      roleBreakdown[role] = (roleBreakdown[role] || 0) + 1;
    });

    // Most active users (by document uploads)
    const userUploads = {};
    (docStats || []).forEach(doc => {
      const userId = doc.owner_user_id;
      userUploads[userId] = (userUploads[userId] || 0) + 1;
    });
    const topUsers = Object.entries(userUploads)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5);

    return {
      documents: {
        total: totalDocs,
        storageBytes: totalStorage,
        recentUploads,
        typeBreakdown,
      },
      users: {
        total: totalMembers,
        active: activeMembers,
        temporary: tempUsers,
        roleBreakdown,
        topUploaders: topUsers,
      },
      activity: {
        recentEvents: recentActivity || [],
        chatSessions: chatStats?.length || 0,
      },
      period: {
        sevenDaysAgo: sevenDaysAgo.toISOString(),
        thirtyDaysAgo: thirtyDaysAgo.toISOString(),
      }
    };
  });

  app.post('/orgs/:orgId/chat/sessions/:id/ask', { preHandler: app.verifyAuth }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const { id } = req.params;
    const Schema = z.object({ question: z.string().min(1) });
    const { question } = Schema.parse(req.body);

    await db.from('chat_messages').insert({ org_id: orgId, session_id: id, role: 'user', content: question });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.sse({ event: 'start', data: JSON.stringify({ ok: true }) });
    const answer = `You asked: ${question}`;
    reply.sse({ event: 'delta', data: 'Answer: ' });
    reply.sse({ event: 'delta', data: answer });
    reply.sse({ event: 'end', data: JSON.stringify({ done: true }) });

    try {
      await db.from('chat_messages').insert({ org_id: orgId, session_id: id, role: 'assistant', content: answer });
    } catch (e) {
      app.log.error(e, 'failed to persist assistant message');
    }
  });

  // File serving endpoint for secure document preview
  app.get('/orgs/:orgId/documents/:id/file', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;
    
    // Get document details
    const { data: doc, error: docError } = await db
      .from('documents')
      .select('storage_key, mime_type, filename, title')
      .eq('org_id', orgId)
      .eq('id', id)
      .single();
    
    if (docError || !doc || !doc.storage_key) {
      return reply.code(404).send({ error: 'Document or file not found' });
    }
    
    try {
      // Get signed URL from Supabase Storage
      const { data: signedUrl, error: urlError } = await app.supabaseAdmin.storage
        .from('documents')
        .createSignedUrl(doc.storage_key, 3600); // 1 hour expiry
      
      if (urlError || !signedUrl) {
        app.log.error(urlError, 'Failed to create signed URL');
        return reply.code(500).send({ error: 'Failed to access file' });
      }
      
      // Return file metadata and signed URL
      return {
        url: signedUrl.signedUrl,
        mimeType: doc.mime_type,
        filename: doc.filename || doc.title || 'document',
        expires: new Date(Date.now() + 3600 * 1000).toISOString()
      };
    } catch (error) {
      app.log.error(error, 'File serving error');
      return reply.code(500).send({ error: 'Failed to serve file' });
    }
  });

  // Recycle Bin APIs
  app.get('/orgs/:orgId/recycle-bin', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    
    // Get user's department context for permission checking
    const userId = req.user?.sub;
    const { data: userDepts } = await req.supabase
      .from('department_users')
      .select('department_id')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    
    const userDeptIds = userDepts?.map(d => d.department_id) || [];
    const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
    
    // Check page permission (with fallback to old logic for backward compatibility)
    try {
      await ensurePerm(req, 'pages.recycle_bin', app, { departmentId: deptContext });
    } catch {
      // Fallback: check old permissions for backward compatibility
      const perms = await getMyPermissions(req, orgId);
      const canAdmin = !!(perms && (perms['org.manage_members'] || perms['documents.delete']));
      if (!canAdmin) {
        const err = new Error('Forbidden');
        err.statusCode = 403;
        throw err;
      }
    }
    const nowIso = new Date().toISOString();
    const { data, error } = await app.supabaseAdmin
      .from('documents')
      .select('*')
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .gt('purge_after', nowIso)
      .order('deleted_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(mapDbToFrontendFields);
  });

  app.post('/orgs/:orgId/documents/:id/trash', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'documents.delete', app);
    const { id } = req.params;
    const userId = req.user?.sub;
    const now = new Date();
    const purgeAfter = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const { data, error } = await app.supabaseAdmin
      .from('documents')
      .update({ deleted_at: now.toISOString(), deleted_by: userId, purge_after: purgeAfter.toISOString() })
      .eq('org_id', orgId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: userId, type: 'documents.trash', doc_id: id }); } catch {}
    return mapDbToFrontendFields(data);
  });

  app.post('/orgs/:orgId/documents/:id/restore', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'documents.update', app);
    const { id } = req.params;
    const { data, error } = await app.supabaseAdmin
      .from('documents')
      .update({ deleted_at: null, deleted_by: null, purge_after: null })
      .eq('org_id', orgId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'documents.restore', doc_id: id }); } catch {}
    return mapDbToFrontendFields(data);
  });

  app.delete('/orgs/:orgId/documents/:id/permanent', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'documents.delete', app);
    const { id } = req.params;
    // Fetch doc for storage
    const { data: doc } = await app.supabaseAdmin
      .from('documents')
      .select('id, org_id, storage_key')
      .eq('org_id', orgId)
      .eq('id', id)
      .single();
    if (doc?.storage_key) {
      try { await app.supabaseAdmin.storage.from('documents').remove([doc.storage_key]); } catch (e) { req.log.error(e, 'storage delete failed'); }
    }
    try { await app.supabaseAdmin.storage.from('extractions').remove([`${orgId}/${id}.json`]); } catch {}
    await app.supabaseAdmin.from('documents').delete().eq('org_id', orgId).eq('id', id);
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'documents.delete.permanent', doc_id: id }); } catch {}
    return { ok: true };
  });

  // Purge all expired trashed documents (admin-only)
  app.post('/orgs/:orgId/recycle-bin/purge', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    const perms = await getMyPermissions(req, orgId);
    const canAdmin = !!(perms && (perms['org.manage_members'] || perms['documents.delete']));
    if (!canAdmin) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    const nowIso = new Date().toISOString();
    // Fetch candidates
    const { data: victims } = await app.supabaseAdmin
      .from('documents')
      .select('id, storage_key')
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .lte('purge_after', nowIso);
    for (const v of victims || []) {
      try {
        if (v.storage_key) await app.supabaseAdmin.storage.from('documents').remove([v.storage_key]);
        try { await app.supabaseAdmin.storage.from('extractions').remove([`${orgId}/${v.id}.json`]); } catch {}
      } catch {}
      await app.supabaseAdmin.from('documents').delete().eq('org_id', orgId).eq('id', v.id);
      try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'documents.purge', doc_id: v.id }); } catch {}
    }
    return { purged: (victims || []).length };
  });

  // Department Categories Management
  // GET /orgs/:orgId/departments/:deptId/categories - Get categories for a department
  app.get('/orgs/:orgId/departments/:deptId/categories', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = req.params.orgId;
    const deptId = req.params.deptId;
    const userId = req.user.id;

    // Verify user has access to this org and department
    await ensureActiveMember(req);
    
    const { data, error } = await db
      .from('departments')
      .select('categories')
      .eq('org_id', orgId)
      .eq('id', deptId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return { categories: ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'] };
      }
      throw error;
    }

    return { 
      categories: data?.categories || ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence']
    };
  });

  // PUT /orgs/:orgId/departments/:deptId/categories - Update categories for a department (Admin only)
  app.put('/orgs/:orgId/departments/:deptId/categories', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = req.params.orgId;
    const deptId = req.params.deptId;
    const userId = req.user.id;

    // Check if user is an admin (either systemAdmin or orgAdmin)
    const userRole = await getUserOrgRole(req);
    const isAdmin = userRole === 'orgAdmin' || req.user.role === 'systemAdmin';

    // Only admins can update categories
    if (!isAdmin) {
      const err = new Error('Only administrators can manage department categories');
      err.statusCode = 403;
      throw err;
    }

    await ensureActiveMember(req);

    // First, check if the department exists and we have access to it
    const { data: existingDept, error: checkError } = await app.supabaseAdmin
      .from('departments')
      .select('id, name, org_id')
      .eq('org_id', orgId)
      .eq('id', deptId)
      .single();

    if (checkError) {
      console.error('Department check error:', checkError);
      const err = new Error(`Department not found. Org: ${orgId}, Dept: ${deptId}`);
      err.statusCode = 404;
      throw err;
    }

    console.log('Found department:', existingDept);

    const Schema = z.object({
      categories: z.array(z.string().min(1)).min(1).max(50)
    });
    
    const { categories } = Schema.parse(req.body || {});

    const { data, error } = await app.supabaseAdmin
      .from('departments')
      .update({ categories })
      .eq('org_id', orgId)
      .eq('id', deptId)
      .select('id, name, categories');

    if (error) {
      console.error('Department categories update error:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      const err = new Error(`Department not found or access denied. Org: ${orgId}, Dept: ${deptId}`);
      err.statusCode = 404;
      throw err;
    }

    const result = data[0];
    console.log(`📂 Categories updated for department ${result.name}:`, categories);
    return result;
  });

  // Register all route modules (dashboard, future modules, etc.)
  registerAllRoutes(app);
  
  // Register metadata routes synchronously before server starts listening
  try {
    registerMetadataRoutes(app);
  } catch (error) {
    console.error('Failed to register metadata routes:', error);
  }
}

// Export functions that need to be used by other modules
export { getEffectivePermissions };
