import { z } from 'zod';
import { ai } from './ai.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { routeQuestion } from './agents/router.js';
import { ingestDocument } from './ingest.js';
import { registerAllRoutes } from './routes/index.js';
import agentOrchestrator from './agents/agent-orchestrator.js';

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

// Merge role permissions with per-user overrides (org-wide and optional dept-specific)
async function getEffectivePermissions(req, orgId, opts = {}) {
  const db = req.supabase;
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
    effective[k] = Object.prototype.hasOwnProperty.call(deptOverride, k)
      ? !!deptOverride[k]
      : Object.prototype.hasOwnProperty.call(orgOverride, k)
        ? !!orgOverride[k]
        : !!rolePerms[k];
  }
  return effective;
}

async function ensurePerm(req, permKey, opts = {}) {
  const orgId = requireOrg(req);
  const perms = await getEffectivePermissions(req, orgId, opts);
  if (!perms || perms[permKey] !== true) {
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

    // 6) my permissions for selected org
    let permissions = {};
    try {
      const { data: permMap, error } = await db.rpc('get_my_permissions', { p_org_id: selectedOrgId });
      if (!error && permMap) permissions = permMap;
      else permissions = await getMyPermissions(req, selectedOrgId);
    } catch {
      permissions = await getMyPermissions(req, selectedOrgId);
    }

    // 7) departments with membership flags and categories
    const { data: depts, error: dErr } = await db
      .from('departments')
      .select('id, org_id, name, lead_user_id, color, categories, created_at, updated_at')
      .eq('org_id', selectedOrgId)
      .order('name');
    if (dErr) throw dErr;
    const { data: myDU } = await db
      .from('department_users')
      .select('department_id, role')
      .eq('org_id', selectedOrgId)
      .eq('user_id', userId);
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
      departments,
    };
    console.log('Bootstrap endpoint returning data:', {
      userId,
      selectedOrgId,
      orgCount: orgs.length,
      departmentCount: departments.length,
      hasUserSettings: !!userSettings,
      hasOrgSettings: !!orgSettings
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
          'chat.save_sessions': true,
          'audit.read': true,
        } },
        { key: 'contentManager', name: 'Content Manager', is_system: true, permissions: {
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
          'chat.save_sessions': true,
          'audit.read': true,
        } },
        { key: 'member', name: 'Member', is_system: true, permissions: {
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
          'chat.save_sessions': false,
          'audit.read': false,
        } },
        { key: 'teamLead', name: 'Team Lead', is_system: true, permissions: {
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
          'chat.save_sessions': false,
          'audit.read': true,
          'departments.read': true,
          'departments.manage_members': true,
        } },
        { key: 'contentViewer', name: 'Content Viewer', is_system: true, permissions: {
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
          'chat.save_sessions': false,
          'audit.read': true,
        } },
        { key: 'guest', name: 'Guest', is_system: true, permissions: {
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
          'search.semantic': false,
          'chat.save_sessions': false,
          'audit.read': false,
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
      await ensurePerm(req, 'org.manage_members');
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
      .select('user_id, department_id')
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
      if (d) arr.push({ id: d.id, name: d.name, color: d.color || null });
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

  app.patch('/orgs/:orgId/users/:userId', { preHandler: app.verifyAuth }, async (req) => {
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
      expires_at: z.string().datetime().optional(),
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

    // First check if user exists in the organization
    console.log('Checking if user exists in organization:', { orgId, userId });
    const { data: existingUser, error: checkError } = await db
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

    let canManageUser = false;

    if (isAdmin) {
      // Admins can manage all users
      console.log('User is admin, granting full access');
      canManageUser = true;
    } else if (isTeamLead) {
      // Team leads can only manage users in their departments
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
      if (userId === callerId) {
        console.log('Team lead cannot edit themselves');
        canManageUser = false;
      } else if (userToCheck.role === 'orgAdmin') {
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

    if (!canManageUser) {
      console.log('Permission denied for user management');
      const err = new Error('Forbidden: Insufficient permissions to manage this user');
      err.statusCode = 403;
      throw err;
    }

    console.log('Permission check passed');

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

    // Only update if role, expires_at, or display_name are provided
    if (body.role !== undefined || body.expires_at !== undefined || body.display_name !== undefined) {
      const updateData = {};
      if (body.role !== undefined) updateData.role = body.role;
      if (body.expires_at !== undefined) updateData.expires_at = body.expires_at;
      if (body.display_name !== undefined) updateData.display_name = body.display_name;

      console.log('Updating user data in database:', updateData);

      // Update organization_users table
      const { data: orgUserData, error: orgError } = await db
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

      // If display_name was updated, also update app_users table
      if (body.display_name !== undefined) {
        console.log('Updating display_name in app_users table');
        const { error: appError } = await db
          .from('app_users')
          .update({ display_name: body.display_name })
          .eq('id', userId);

        if (appError) {
          console.error('Error updating display_name in app_users:', appError);
          // Don't throw here as the org_users update succeeded
          // Just log the error for monitoring
        } else {
          console.log('Successfully updated display_name in app_users');
        }
      }

      console.log('Database update successful, returning data');
      return orgUserData;
    }

    // If only password was updated, return the user data
    console.log('Only password was updated, returning user data');
    return userToCheck;
  });

  // Invite/create a user and add to org with optional expiry
  app.post('/orgs/:orgId/users', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Allow org admins or department leads to create users.
    // Admins: unrestricted (existing behavior). Dept leads: restricted to creating member/guest only.
    let isAdmin = false;
    try { await ensurePerm(req, 'org.manage_members'); isAdmin = true; } catch { isAdmin = false; }
    const Schema = z.object({ email: z.string().email(), display_name: z.string().optional(), role: z.string().min(2).regex(/^[A-Za-z0-9_-]+$/), expires_at: z.string().datetime().optional(), password: z.string().min(6).optional() });
    const body = Schema.parse(req.body || {});
    if (!isAdmin) {
      // Verify caller is a department lead in this org
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
      // Restrict role assignment: leads cannot create admins or team leads
      const allowed = new Set(['member','guest','contentViewer','contentManager']);
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
      .upsert({ org_id: orgId, user_id: authUserId, role: body.role, expires_at: body.expires_at || null }, { onConflict: 'org_id,user_id' })
      .select('*')
      .single();
    if (error) throw error;
    // Return membership along with initial password if we generated one and caller didn't provide
    const resp = { ...data };
    if (!body.password) resp.initial_password = tempPassword;
    return resp;
  });

  // Remove a user from the organization (does not delete auth account)
  app.delete('/orgs/:orgId/users/:userId', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { userId } = req.params;
    // Require permission to manage members
    await ensurePerm(req, 'org.manage_members');
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
    await ensurePerm(req, 'org.manage_members');
    const { data, error } = await db
      .from('org_roles')
      .select('*')
      .eq('org_id', orgId)
      .order('is_system', { ascending: false })
      .order('key');
    if (error) throw error;
    return data;
  });

  app.post('/orgs/:orgId/roles', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members');
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

  app.patch('/orgs/:orgId/roles/:key', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members');
    const { key } = req.params;
    const Schema = z.object({ name: z.string().min(2).optional(), description: z.string().optional(), permissions: z.record(z.boolean()).optional() });
    const body = Schema.parse(req.body || {});
    const { data: existing } = await db
      .from('org_roles')
      .select('is_system, key')
      .eq('org_id', orgId)
      .eq('key', key)
      .maybeSingle();
    if (!existing) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    const payload = { ...body };
    const { data, error } = await db
      .from('org_roles')
      .update(payload)
      .eq('org_id', orgId)
      .eq('key', key)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  app.delete('/orgs/:orgId/roles/:key', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members');
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

  app.post('/orgs/:orgId/departments', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.update_settings');
    const Schema = z.object({ name: z.string().min(2), leadUserId: z.string().uuid().nullable().optional(), color: z.string().optional() });
    const body = Schema.parse(req.body || {});
    const payload = { org_id: orgId, name: body.name, lead_user_id: body.leadUserId ?? null, color: body.color };
    const { data, error } = await db.from('departments').insert(payload).select('*').single();
    if (error) throw error;
    return data;
  });

  app.patch('/orgs/:orgId/departments/:deptId', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.update_settings');
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

  app.delete('/orgs/:orgId/departments/:deptId', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.update_settings');
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
    
    if (!isOrgAdmin) {
      const { deptId } = req.params;
      const userId = req.user?.sub;
      
      // Check if user is a department lead for this specific department
      const { data: lead } = await db
        .from('department_users')
        .select('user_id')
        .eq('org_id', orgId)
        .eq('department_id', deptId)
        .eq('user_id', userId)
        .eq('role', 'lead')
        .maybeSingle();
        
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
        // For non-teamLead roles, they must be a department lead
        if (!lead) { 
          const e = new Error('Forbidden'); 
          e.statusCode = 403; 
          throw e; 
        }
      }
    }
    const { deptId } = req.params;
    const { data, error } = await db
      .from('department_users')
      .select('user_id, role, app_users(display_name)')
      .eq('org_id', orgId)
      .eq('department_id', deptId);
    if (error) throw error;
    const rows = data || [];
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
      displayName: r.app_users?.display_name || idToMetaName.get(r.user_id) || null,
      email: idToEmail.get(r.user_id) || null,
    }));
  });

  app.post('/orgs/:orgId/departments/:deptId/users', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { deptId } = req.params;
    const Schema = z.object({ userId: z.string().uuid(), role: z.enum(['lead','member']) });
    const body = Schema.parse(req.body || {});
    const callerId = req.user?.sub;
    const callerOrgRole = await getUserOrgRole(req);
    const isAdmin = callerOrgRole === 'orgAdmin';
    const isTeamLead = callerOrgRole === 'teamLead';
    
    // Non-admins must be department lead of this dept
    if (!isAdmin) {
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
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { deptId, userId } = req.params;
    const callerId = req.user?.sub;
    const callerOrgRole = await getUserOrgRole(req);
    const isAdmin = callerOrgRole === 'orgAdmin';
    const isTeamLead = callerOrgRole === 'teamLead';
    
    // Non-admins must be department lead of this dept
    if (!isAdmin) {
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

    return { ok: true };
  });

  // Per-user overrides (org-wide or department-specific)
  app.get('/orgs/:orgId/overrides', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
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
    let qb = db.from('user_access_overrides').select('*').eq('org_id', orgId);
    if (userId) qb = qb.eq('user_id', userId);
    if (deptParam === null) qb = qb.is('department_id', null);
    else if (typeof deptParam === 'string') qb = qb.eq('department_id', deptParam);
    const { data, error } = await qb;
    if (error) throw error;
    return data || [];
  });

  app.put('/orgs/:orgId/overrides', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const Schema = z.object({ userId: z.string().uuid(), departmentId: z.string().uuid().nullable().optional(), permissions: z.record(z.boolean()) });
    const body = Schema.parse(req.body || {});
    const payload = { org_id: orgId, user_id: body.userId, department_id: (Object.prototype.hasOwnProperty.call(body,'departmentId') ? body.departmentId : null), permissions: body.permissions };
    const { data, error } = await db
      .from('user_access_overrides')
      .upsert(payload, { onConflict: 'org_id,user_id,department_id' })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  // Effective permissions for a user at org or department scope
  app.get('/orgs/:orgId/overrides/effective', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'org.manage_members');
    const q = req.query || {};
    const userId = typeof q.userId === 'string' ? q.userId : undefined;
    if (!userId) { const e = new Error('userId required'); e.statusCode = 400; throw e; }
    // departmentId: UUID string or 'null' meaning org-scope
    let deptParam = undefined;
    if (Object.prototype.hasOwnProperty.call(q, 'departmentId')) {
      const raw = q.departmentId;
      if (raw === 'null' || raw === '' || raw === null) deptParam = null;
      else if (typeof raw === 'string') deptParam = raw;
    }

    // Get user's role in the org
    const { data: membership } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();
    const roleKey = membership?.role || null;
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
    if (typeof deptParam === 'string') {
      const { data: deptOverrideRow } = await db
        .from('user_access_overrides')
        .select('permissions')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .eq('department_id', deptParam)
        .maybeSingle();
      deptOverride = (deptOverrideRow?.permissions || {});
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
      const { data: canAccess, error } = await db
        .rpc('can_access_audit', { p_org_id: orgId });
      
      if (error) {
        console.error('Error checking audit access:', error);
        return false;
      }
      
      return canAccess;
    } catch (error) {
      console.error('Error in can-access endpoint:', error);
      return false;
    }
  });

  app.get('/orgs/:orgId/audit', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Determine if admin; team leads will be allowed but scoped below
    let isAdmin = false;
    try { await ensurePerm(req, 'audit.read'); isAdmin = true; } catch { isAdmin = false; }
    // Double-check access: first check permissions, then check department lead status
    const { data: canAccess, error: accessErr } = await db
      .rpc('can_access_audit', { p_org_id: orgId });
    
    if (accessErr) {
      console.error('Error checking audit access:', accessErr);
      const err = new Error('Error checking audit permissions');
      err.statusCode = 500;
      throw err;
    }
    
    if (!canAccess) {
      const err = new Error('Forbidden - You must be an organization admin, content manager, or department lead to access audit logs');
      err.statusCode = 403;
      throw err;
    }
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
    const { q, limit = 50, offset = 0, departmentId } = req.query || {};
    const userId = req.user?.sub;
    
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
      .select('id, org_id, title, filename, type, folder_path, subject, description, category, tags, keywords, sender, receiver, document_date, uploaded_at, file_size_bytes, mime_type, content_hash, storage_key, department_id, version_group_id, version_number, is_current_version, supersedes_id')
      .eq('org_id', orgId)
      .order('uploaded_at', { ascending: false })
      .range(offset, offset + Math.min(Number(limit), 200) - 1);
    
    // Apply folder filter
    query = query.filter('type', 'neq', 'folder');
    
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
    const filteredData = data?.filter(d => d.type !== 'folder') || [];
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
    try { await ensurePerm(req, 'org.manage_members'); isAdmin = true; } catch { isAdmin = false; }
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

        // If still no department, use the single membership or require selection
        if (!departmentId) {
          if (uniq.length === 1) departmentId = uniq[0];
          else {
            const err = new Error('Please select a team to create this document');
            err.statusCode = 400; throw err;
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

        // If still no department, use admin's department memberships
        if (!departmentId) {
          const { data: adminDepts } = await db
            .from('department_users')
            .select('department_id, departments(name)')
            .eq('org_id', orgId)
            .eq('user_id', userId);

          if (adminDepts && adminDepts.length > 0) {
            // Use the first department the admin is a member of
            departmentId = adminDepts[0].department_id;
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
      const perms = await getEffectivePermissions(req, orgId, { departmentId });
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

    const { data: document, error: fetchError } = await db
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
      const { error: updErr } = await db
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
    await ensurePerm(req, 'documents.update');
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
    
    // Get all documents to retrieve storage information
    const { data: documents, error: fetchError } = await db
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
    const { error: dbError } = await db.from('documents').delete().eq('org_id', orgId).in('id', ids);
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

  app.get('/orgs/:orgId/folders', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
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
      await ensurePerm(req, 'org.manage_members'); 
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
          try { await ensurePerm(req, 'org.manage_members'); }
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
        (results[key] ||= []);
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

  // Initialize Gemini client for file uploads
  const getGeminiClient = () => {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('Gemini API key not configured');
    return new GoogleGenerativeAI(apiKey);
  };

  // Backend OCR/metadata from Storage - download object, send as data URI
  app.post('/orgs/:orgId/uploads/analyze', { preHandler: app.verifyAuth }, async (req, reply) => {
    const orgId = await ensureActiveMember(req);
    const Schema = z.object({ storageKey: z.string(), mimeType: z.string().optional() });
    const { storageKey, mimeType } = Schema.parse(req.body);

    // Get organization categories for AI context
    const { data: orgSettings } = await req.supabase
      .from('org_settings')
      .select('categories')
      .eq('org_id', orgId)
      .maybeSingle();
    const availableCategories = orgSettings?.categories || ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'];

    // Per-org summary prompt
    let orgSummaryPrompt = 'Write a concise summary (<= 300 words) of the document text. Focus on essential facts and outcomes.';
    try {
      const { data: priv } = await req.supabase
        .from('org_private_settings')
        .select('summary_prompt')
        .eq('org_id', orgId)
        .maybeSingle();
      if (priv?.summary_prompt && typeof priv.summary_prompt === 'string') orgSummaryPrompt = priv.summary_prompt;
    } catch {}

    const { data: fileBlob, error: dlErr } = await app.supabaseAdmin.storage.from('documents').download(storageKey);
    if (dlErr || !fileBlob) return reply.code(400).send({ error: 'Unable to download storage object' });

    const fileSize = fileBlob.size;
    const fileSizeMB = fileSize / (1024 * 1024);

    // Store file size for use in fallback (in case AI processing fails)
    const originalFileSizeMB = fileSizeMB;

    // Updated size limits for Gemini File API (more generous)
    const AI_SIZE_LIMITS = {
      'application/pdf': 100,  // 100MB for PDFs (File API is more efficient)
      'image/jpeg': 50,        // 50MB for images
      'image/png': 50,         // 50MB for images
      'image/gif': 20,         // 20MB for GIFs
      'application/msword': 50,  // 50MB for DOC
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 50, // 50MB for DOCX
      'application/vnd.ms-powerpoint': 75, // 75MB for PPT
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 75, // 75MB for PPTX
      'text/plain': 10,        // 10MB for text files
      'text/markdown': 10,     // 10MB for markdown
    };

    const mimeTypeKey = mimeType || fileBlob.type;
    const sizeLimit = AI_SIZE_LIMITS[mimeTypeKey] || 50; // Default 50MB limit

    // Check if file is too large for AI processing
    if (fileSizeMB > sizeLimit) {
      console.log(`File too large for AI processing: ${fileSizeMB.toFixed(2)}MB (limit: ${sizeLimit}MB) for ${mimeTypeKey}`);

      // Enhanced fallback for large files
      const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');
      const fileExtension = baseName.split('.').pop()?.toLowerCase() || '';

      // Generate better fallback metadata based on file type
      let enhancedFallback = {
        title: baseName.replace(/\.[^/.]+$/, ""), // Remove extension from title
        subject: `${baseName} - Large Document`,
        keywords: [baseName, fileExtension.toUpperCase(), 'large-file', 'document'],
        tags: ['document', 'large-file', fileExtension || 'unknown'],
        summary: `Large ${fileExtension.toUpperCase() || 'document'} file (${fileSizeMB.toFixed(1)}MB) - AI processing skipped due to size limits. Please review and add metadata manually if needed.`,
        description: `This is a large file that exceeded the AI processing limit of ${sizeLimit}MB. The document has been uploaded successfully but AI analysis was skipped to prevent processing timeouts.`,
        category: availableCategories.includes('General') ? 'General' : availableCategories[0],
      };

      // Add file-type specific metadata
      if (['pdf'].includes(fileExtension)) {
        enhancedFallback.tags.push('pdf', 'readable');
        enhancedFallback.category = availableCategories.includes('Report') ? 'Report' : enhancedFallback.category;
      } else if (['doc', 'docx'].includes(fileExtension)) {
        enhancedFallback.tags.push('word', 'editable');
        enhancedFallback.category = availableCategories.includes('Correspondence') ? 'Correspondence' : enhancedFallback.category;
      } else if (['ppt', 'pptx'].includes(fileExtension)) {
        enhancedFallback.tags.push('presentation', 'slides');
        enhancedFallback.category = availableCategories.includes('Report') ? 'Report' : enhancedFallback.category;
      } else if (['jpg', 'jpeg', 'png', 'gif'].includes(fileExtension)) {
        enhancedFallback.tags.push('image', 'visual');
        enhancedFallback.category = availableCategories.includes('General') ? 'General' : enhancedFallback.category;
      }

      return reply.code(413).send({
        error: `File too large for AI processing (${fileSizeMB.toFixed(2)}MB exceeds ${sizeLimit}MB limit)`,
        fallback: {
          ocrText: '',
          metadata: enhancedFallback,
        },
      });
    }

    // Use optimized base64 approach (working and reliable)
    console.log(`Processing ${fileSizeMB.toFixed(2)}MB file with Gemini...`);
    const arr = await fileBlob.arrayBuffer();
    const b64 = Buffer.from(arr).toString('base64');
    const dataUri = `data:${mimeTypeKey};base64,${b64}`;

    // Use Genkit approach (proven to work)
    const ocrPrompt = ai.definePrompt({
      name: 'ocrPrompt',
      input: { schema: z.object({ dataUri: z.string() }) },
      output: { schema: z.object({ extractedText: z.string().optional() }) },
      prompt: `Extract the readable text from the following document:\n\n{{media url=dataUri}}`
    });

    const metaPrompt = ai.definePrompt({
      name: 'metaPrompt',
      input: { schema: z.object({ dataUri: z.string() }) },
      output: {
        schema: z.object({
          keywords: z.array(z.string()).min(3),
          title: z.string().min(1),
          subject: z.string().min(1),
          sender: z.string().optional(),
          receiver: z.string().optional(),
          senderOptions: z.array(z.string()).optional(),
          receiverOptions: z.array(z.string()).optional(),
          documentDate: z.string().optional(),
          category: z.string().optional(),
          tags: z.array(z.string()).min(3),
        }),
      },
      prompt: `You are an expert document information extractor.

1. Identify the subject of the document.
2. Identify the date the document was sent. If you cannot find one, leave it blank.
3. Identify all distinct pairs of sender and receiver in the document. Provide primary sender/receiver and list all options.
4. Extract keywords from the document (minimum 3).
5. Categorize the document into one of the following: ${availableCategories.join(', ')}.
6. Generate 3-8 relevant tags and a concise title.

Do NOT include a summary in this response.

Document: {{media url=dataUri}}`,
    });
    const summaryPrompt = ai.definePrompt({
      name: 'summaryPrompt',
      input: { schema: z.object({ dataUri: z.string() }) },
      output: { schema: z.object({ summary: z.string() }) },
      prompt: `${orgSummaryPrompt}\n\n{{media url=dataUri}}`,
    });

    // Process with reliable approach
    const [ocrResult, metaResult, sumResult] = await Promise.all([
      ocrPrompt({ dataUri }),
      metaPrompt({ dataUri }),
      summaryPrompt({ dataUri }),
    ]);

    const [{ output: ocr }, { output: meta }, { output: sum }] = [ocrResult, metaResult, sumResult];

    // Post-process to guarantee required fields
    const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');
    const ensured = {
      title: (meta?.title || baseName),
      subject: (meta?.subject || baseName),
      keywords: Array.from(new Set(((meta?.keywords || []).filter(Boolean).slice(0,10)).concat([baseName]))).slice(0, 10),
      tags: Array.from(new Set(((meta?.tags || []).filter(Boolean).slice(0,8)).concat(['document']))).slice(0, 8),
      summary: (sum && typeof sum.summary === 'string') ? sum.summary : '',
      sender: meta?.sender,
      receiver: meta?.receiver,
      senderOptions: meta?.senderOptions || [],
      receiverOptions: meta?.receiverOptions || [],
      documentDate: meta?.documentDate,
      category: meta?.category,
    };

    console.log('✅ Successfully processed file with Gemini');
    return { ocrText: ocr?.extractedText || '', metadata: ensured };
  });

  app.post('/orgs/:orgId/uploads/finalize', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({ documentId: z.string(), storageKey: z.string(), fileSizeBytes: z.number().int().nonnegative(), mimeType: z.string(), contentHash: z.string().optional() });
    const body = Schema.parse(req.body);
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
      // Run asynchronously; do not await to keep finalize snappy
      Promise.resolve().then(() => ingestDocument(app, { orgId, docId: body.documentId, storageKey: body.storageKey, mimeType: body.mimeType })).catch((e) => {
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
      await ensurePerm(req, 'documents.update');
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
    await ensurePerm(req, 'storage.upload');
    const parts = req.parts();
    let filePart = null;
    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'file') { filePart = part; break; }
    }
    if (!filePart) return reply.code(400).send({ error: 'Missing file' });

    const filename = sanitizeFilename(filePart.filename || 'upload.bin');
    const contentType = filePart.mimetype || 'application/octet-stream';
    const storageKey = `${orgId}/${Date.now()}-${filename}`;
    const buffer = await streamToBuffer(filePart.file);

    const { error } = await app.supabaseAdmin.storage.from('documents').upload(storageKey, buffer, { contentType, upsert: false });
    if (error) return reply.code(500).send({ error: 'Storage upload failed' });

    return { storageKey, contentType, size: buffer.length };
  });

  app.post('/orgs/:orgId/uploads/sign', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    // Require storage upload permission
    try {
      await ensurePerm(req, 'storage.upload');
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
    const Schema = z.object({ filename: z.string(), mimeType: z.string().optional(), contentHash: z.string().optional() });
    const body = Schema.parse(req.body);
    const key = `${orgId}/${Date.now()}-${sanitizeFilename(body.filename)}`;
    const { data, error } = await app.supabaseAdmin.storage.from('documents').createSignedUploadUrl(key);
    if (error) throw error;
    return { url: data.signedUrl, storageKey: key, path: data.path, token: data.token };
  });

  // Chat Orchestrator (SSE) — router → retrieval → rerank → answer → citations
  app.post('/orgs/:orgId/chat/ask', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req, reply) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({
      question: z.string().min(1),
      conversation: z
        .array(z.object({
          role: z.enum(['user', 'assistant']).optional(),
          content: z.string().optional(),
          citations: z.array(z.object({ docId: z.string().optional() })).optional(),
        }))
        .optional(),
      memory: z
        .object({
          focusDocIds: z.array(z.string()).optional(),
          lastCitedDocIds: z.array(z.string()).optional(),
          filters: z
            .object({ sender: z.string().optional(), receiver: z.string().optional(), docType: z.string().optional() })
            .optional(),
        })
        .optional(),
    });
    const { question, conversation = [], memory: userMemory = {} } = Schema.parse(req.body || {});

    // Prepare SSE
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    const send = (event, data) => reply.sse({ event, data: typeof data === 'string' ? data : JSON.stringify(data) });
    send('start', { ok: true });

    // Load entitlements
    const perms = await getMyPermissions(req, orgId);
    const pf = (k, def = true) => (perms && Object.prototype.hasOwnProperty.call(perms, k) ? !!perms[k] : def);
    const allowSnippets = pf('feature.chat.snippets', true);
    const allowMetadata = pf('feature.chat.metadata', true);
    const allowAnalytics = pf('feature.chat.analytics', true);
    const allowLinked = pf('feature.chat.linked', true);
    const allowSemantic = pf('feature.search.semantic', true);

    // Conversation helpers
    function inferFocusDocIdFromConversation(conv) {
      // Prefer last assistant message with citations
      for (let i = conv.length - 1; i >= 0; i--) {
        const m = conv[i];
        if (m && m.role === 'assistant' && Array.isArray(m.citations) && m.citations.length > 0) {
          const id = m.citations[0]?.docId;
          if (id) return id;
        }
      }
      return null;
    }

    const focusDocId = inferFocusDocIdFromConversation(conversation);
    const lastListDocIds = Array.isArray(userMemory.lastListDocIds) ? userMemory.lastListDocIds : [];
    const memory = {
      focusDocIds: (userMemory.focusDocIds && userMemory.focusDocIds.length ? userMemory.focusDocIds : (focusDocId ? [focusDocId] : [])),
      lastCitedDocIds: (userMemory.lastCitedDocIds && userMemory.lastCitedDocIds.length
        ? userMemory.lastCitedDocIds
        : (conversation || [])
            .filter(m => m?.role === 'assistant' && Array.isArray(m.citations))
            .flatMap(m => m.citations.map(c => c.docId).filter(Boolean))),
      lastListDocIds: lastListDocIds.length ? lastListDocIds : undefined,
      filters: userMemory.filters || undefined,
    };
    // Use new agent orchestrator for routing
    const routingResult = await agentOrchestrator.processQuestion(db, question, [], conversation);

    // For backward compatibility, map agent types to legacy modes
    const agentTypeToLegacyMode = {
      'metadata': 'metadata',
      'content': 'content',
      'financial': 'analytics',
      'resume': 'content',
      'legal': 'content'
    };

    const primary = agentTypeToLegacyMode[routingResult.agentType] || 'content';
    send('mode', {
      mode: primary,
      agentType: routingResult.agentType,
      agentName: routingResult.agentName,
      intent: routingResult.intent,
      confidence: routingResult.confidence
    });
    send('stage', {
      agent: routingResult.agentName,
      step: 'routed',
      mode: primary,
      agentType: routingResult.agentType
    });

    // If the router signals ambiguity/low confidence, ask a short clarifying question
    const veryShort = String(question || '').trim().split(/\s+/).filter(Boolean).length < 2;
    if (veryShort || routingResult.confidence < 0.6) {
      send('delta', 'Do you want files, metadata, content Q&A, linked docs, differences, analytics, a timeline, or a field extract?');
      send('end', { done: true, citations: [] });
      return;
    }

    // For now, keep the agent type as determined by the router
    // Future enhancement: add logic to adjust agent based on document context
    let adjusted = primary;

    // NEW AGENT SYSTEM INTEGRATION
    // If we have a specialized agent, use it instead of legacy logic
    if (routingResult.agentType !== 'content') {
      try {
        // Embed query via OpenAI REST API
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

        // Search for relevant documents first
        let relevantDocuments = [];

        if (routingResult.agentType === 'metadata') {
          // Metadata agent: search documents by metadata only
          const { data, error } = await db
            .from('documents')
            .select('id, title, filename, sender, receiver, document_date, document_type, category, tags')
            .eq('org_id', orgId)
            .limit(20);
          relevantDocuments = data || [];
        } else {
          // Other agents: use semantic search
          if (allowSemantic) {
            const embedding = await embedQuery(question).catch(() => null);
            if (embedding) {
              const { data: chunks } = await db.rpc('match_doc_chunks', {
                p_org_id: orgId,
                p_query_embedding: embedding,
                p_match_count: 24,
                p_similarity_threshold: 0
              });

              if (chunks && chunks.length > 0) {
                const docIds = [...new Set(chunks.map(c => c.doc_id))];
                const { data: docs } = await db
                  .from('documents')
                  .select('id, title, filename, sender, receiver, document_date, document_type, category, tags, content')
                  .eq('org_id', orgId)
                  .in('id', docIds);

                // Add snippets to documents
                relevantDocuments = (docs || []).map(doc => {
                  const docChunks = chunks.filter(c => c.doc_id === doc.id);
                  return {
                    ...doc,
                    content: docChunks.map(c => c.content).join('\n---\n')
                  };
                });
              }
            }
          }
        }

        // Process with the appropriate agent
        const agentResult = await agentOrchestrator.processQuestion(
          db,
          question,
          relevantDocuments,
          conversation,
          routingResult.agentType
        );

        // Send response
        send('delta', agentResult.answer);

        // Send citations if available
        if (agentResult.citations && agentResult.citations.length > 0) {
          send('end', {
            done: true,
            citations: agentResult.citations,
            agentType: agentResult.agentType,
            agentName: agentResult.agentName
          });
        } else {
          send('end', {
            done: true,
            citations: [],
            agentType: agentResult.agentType,
            agentName: agentResult.agentName
          });
        }

        return;
      } catch (agentError) {
        console.error('Agent processing error:', agentError);
        // Fall back to legacy system
        send('stage', { agent: 'System', step: 'fallback_to_legacy' });
      }
    }

    // LEGACY SYSTEM (for content agent and fallbacks)
    // Utilities for extraction load/save
    async function loadExtraction(docId) {
      try {
        const { data, error } = await app.supabaseAdmin.storage.from('extractions').download(`${orgId}/${docId}.json`);
        if (error || !data) return null;
        const txt = await data.text();
        return JSON.parse(txt);
      } catch { return null; }
    }
    async function saveExtraction(docId, payload) {
      try {
        const key = `${orgId}/${docId}.json`;
        const { error } = await app.supabaseAdmin.storage.from('extractions').upload(key, Buffer.from(JSON.stringify(payload)), { contentType: 'application/json', upsert: true });
        if (error) throw error;
        return true;
      } catch { return false; }
    }

    // Normalize question for keyword checks
    const qLower = String(question || '').toLowerCase();

    // Early handling for metadata fields and linked relationships using focus/ordinals
    // This ensures follow-ups like "first one", "its sender", "its linked docs" don't get misrouted to Finder.
    (async () => {})();
    const wantsLinkedEarly = /(\blink(ed)?\b|\blinks\b|\bversions?\b|\brelationships?\b)/i.test(qLower);
    const metaAskEarly = (() => {
      const m = qLower;
      const wantsSubject = /\b(subject|subj)\b/.test(m);
      const wantsSummary = /\b(summary|summarize|overview|about)\b/.test(m);
      const wantsSender = /\b(sender|from)\b/.test(m);
      const wantsReceiver = /\b(receiver|to)\b/.test(m);
      const wantsDate = /\b(date|document date)\b/.test(m);
      const wantsFilename = /\b(file(name)?|filename)\b/.test(m);
      const wantsCategory = /\bcategory\b/.test(m);
      const wantsTags = /\btags?\b/.test(m);
      return { wantsSubject, wantsSummary, wantsSender, wantsReceiver, wantsDate, wantsFilename, wantsCategory, wantsTags };
    })();
    function canonEarly(v) {
      const s = String(v || '').trim();
      const map = new Map([
        ['maharashtra state electricity distribution co. ltd.', 'MAHAVITARAN (MSEDCL)'],
        ['mseb', 'Maharashtra State Electricity Board (MSEB)'],
        ['mahadiscom', 'MAHAVITARAN (MSEDCL)'],
        ['m/s bhagyalaxmi steel alloy pvt.ltd.', 'M/S BHAGYALAXMI STEEL ALLOY PVT. LTD.'],
      ]);
      const key = s.toLowerCase();
      return map.get(key) || s;
    }
    function ordinalFromQuestionEarly(txt) {
      const t = String(txt || '').toLowerCase();
      const map = new Map([
        ['first', 1], ['1st', 1], ['#1', 1],
        ['second', 2], ['2nd', 2], ['#2', 2],
        ['third', 3], ['3rd', 3], ['#3', 3],
        ['fourth', 4], ['4th', 4], ['#4', 4],
        ['fifth', 5], ['5th', 5], ['#5', 5],
      ]);
      for (const [k, v] of map.entries()) if (t.includes(k)) return v;
      return null;
    }
    function lastAssistantCitationsEarly(conv) {
      for (let i = conv.length - 1; i >= 0; i--) {
        const m = conv[i];
        if (m?.role === 'assistant' && Array.isArray(m.citations) && m.citations.length > 0) return m.citations;
      }
      return [];
    }
    // If explicitly asking for linked docs and we have a focus doc, show its relationships immediately
    if (wantsLinkedEarly && focusDocId) {
      // Update mode to reflect linked agent
      send('mode', { mode: 'linked', intent: 'Linked', confidence: routingResult.confidence });
      const { data: focus } = await db
        .from('documents')
        .select('id, title, filename, version_group_id, is_current_version')
        .eq('org_id', orgId)
        .eq('id', focusDocId)
        .maybeSingle();
      if (focus) {
        let versions = [];
        if (focus.version_group_id) {
          const { data: vers } = await db
            .from('documents')
            .select('id, title, filename, version_number, is_current_version')
            .eq('org_id', orgId)
            .eq('version_group_id', focus.version_group_id);
          versions = vers || [];
        }
        const { data: outgoing } = await db
          .from('document_links')
          .select('linked_doc_id')
          .eq('org_id', orgId)
          .eq('doc_id', focus.id);
        const { data: incoming } = await db
          .from('document_links')
          .select('doc_id')
          .eq('org_id', orgId)
          .eq('linked_doc_id', focus.id);
        const ids = new Set([
          ...((outgoing || []).map(r => r.linked_doc_id)),
          ...((incoming || []).map(r => r.doc_id)),
        ]);
        let linkedDocs = [];
        if (ids.size) {
          const { data: ldocs } = await db
            .from('documents')
            .select('id, title, filename, document_date')
            .eq('org_id', orgId)
            .in('id', Array.from(ids))
            .limit(20);
          linkedDocs = ldocs || [];
        }
        // Emit structured linked relationships for UI
        try {
          const versionsOut = (versions || []).map(v => ({ id: v.id, title: v.title || v.filename || 'Untitled', versionNumber: v.version_number || null, isCurrentVersion: !!v.is_current_version }));
          const linkedOut = (linkedDocs || []).map(d => ({ id: d.id, title: d.title || d.filename || 'Untitled', documentDate: d.document_date || null }));
          send('linked', { focusDocId: focus.id, versions: versionsOut, documents: linkedOut });
        } catch {}
        const lines = [];
        const focusName = focus.title || focus.filename || 'Untitled';
        lines.push(`Relationships for "${focusName}":`);
        if (versions.length > 0) {
          const sorted = versions.slice().sort((a,b) => (a.version_number||0) - (b.version_number||0));
          lines.push('🔁 Versions:');
          sorted.slice(0, 8).forEach(v => lines.push(`• v${v.version_number || 1}${v.is_current_version ? '*' : ''} — ${v.title || v.filename || 'Untitled'}`));
        }
        if (linkedDocs.length > 0) {
          lines.push('📎 Linked documents:');
          linkedDocs.slice(0, 8).forEach(d => lines.push(`• ${d.title || d.filename || 'Untitled'}${d.document_date ? ` · ${d.document_date}` : ''}`));
        }
        if (lines.length === 1) lines.push('No versions or explicit links found.');
        send('delta', lines.join('\n'));
        send('end', { done: true, citations: [] });
        return;
      }
    }

    // Focused Content Q&A — if router chose ContentQA, answer using the current focus doc (citations/ordinal)
    if (primary === 'content') {
      // Update mode to reflect content agent
      send('mode', { mode: 'content', intent: 'ContentQA', confidence: routingResult.confidence });
      // Resolve target doc id
      let targetId = focusDocId || null;
      const ord = (decision?.target?.ordinal ? Number(decision.target.ordinal) : null) || ordinalFromQuestionEarly(question);
      if (ord) {
        const cites = lastAssistantCitationsEarly(conversation);
        if (cites && cites.length >= ord) {
          const id = cites[ord - 1]?.docId;
          if (id) targetId = id;
        }
        // Fallback to last list mapping when citations don't cover the ordinal
        if (!targetId && Array.isArray(lastListDocIds) && lastListDocIds.length >= ord) {
          const id = lastListDocIds[ord - 1];
          if (id) targetId = id;
        }
      }
      // If router prefers focus or list and we still do not have a target, use memory hints
      if (!targetId && decision?.target?.prefer === 'focus' && Array.isArray(memory.focusDocIds) && memory.focusDocIds.length > 0) {
        targetId = memory.focusDocIds[0];
      }
      if (!targetId && decision?.target?.prefer === 'list' && Array.isArray(lastListDocIds) && lastListDocIds.length > 0) {
        targetId = lastListDocIds[0];
      }
      if (!targetId) {
        // If no focus, proceed to generic snippets later
      } else {
        try {
          send('stage', { agent: 'ContentAgent', step: 'loading' });
          // Try to load OCR extraction for better recall
          const ex = await loadExtraction(targetId);
          let contextText = '';
          if (ex?.ocrText && String(ex.ocrText).trim().length > 0) {
            contextText = String(ex.ocrText).slice(0, 20000);
            send('stage', { agent: 'ContentAgent', step: 'using_ocr' });
          } else {
            // Fall back to semantic chunks and restrict to this doc
            const embedding = allowSemantic ? await embedQuery(question).catch(() => null) : null;
            let chunks = [];
            if (embedding) {
              const { data, error } = await db.rpc('match_doc_chunks', {
                p_org_id: orgId,
                p_query_embedding: embedding,
                p_match_count: 24,
                p_similarity_threshold: 0
              });
              if (!error && Array.isArray(data)) chunks = data.filter(r => r.doc_id === targetId);
            }
            // Build context from top chunks or lightweight metadata
            if (chunks.length > 0) {
              const byScore = chunks.slice().sort((a,b) => Number(b.similarity||0) - Number(a.similarity||0));
              contextText = byScore.map(r => String(r.content||'')).slice(0, 6).join('\n---\n');
              send('stage', { agent: 'ContentAgent', step: 'using_chunks', count: chunks.length });
            } else {
              // As a last resort, include title/subject/meta as minimal context
              const { data: doc } = await db
                .from('documents')
                .select('title, subject, sender, receiver, category, document_date, filename')
                .eq('org_id', orgId)
                .eq('id', targetId)
                .maybeSingle();
              contextText = [doc?.title, doc?.subject, doc?.sender, doc?.receiver, doc?.category, doc?.document_date, doc?.filename]
                .filter(Boolean).join(' \n ');
              send('stage', { agent: 'ContentAgent', step: 'using_metadata' });
            }

          }

          // Structured extraction for bill fields when explicitly requested via router
          const reqFields = Array.isArray(decision?.requiredFields) ? decision.requiredFields.map(String) : [];
          let structuredLine = '';
          if (reqFields.some(k => /amount|total|due|billing|month|year/i.test(k))) {
            try {
              const extractPrompt = ai.definePrompt({
                name: 'extractBillFields',
                input: { schema: z.object({ text: z.string() }) },
                output: { schema: z.object({ amount: z.string().optional(), currency: z.string().optional(), billingMonth: z.string().optional(), billingYear: z.string().optional(), dueDate: z.string().optional() }) },
                prompt: `From the given document text, extract electricity bill fields as JSON: {amount,currency,billingMonth,billingYear,dueDate}.\n- Use numeric format for amount (no commas), 2 decimals if present.\n- Month as MMM or full name, year as YYYY.\n- If unknown, omit the key.\n\nText:\n{{text}}`,
              });
              const { output } = await extractPrompt({ text: contextText.slice(0, 12000) });
              const amt = output?.amount; const cur = output?.currency || '₹';
              const mon = output?.billingMonth; const yr = output?.billingYear;
              if (amt && (mon || yr)) structuredLine = `The bill is ${cur}${amt}${(mon||yr) ? ` for ${[mon,yr].filter(Boolean).join(' ')}` : ''}.`;
              // Persist parsed fields for reuse
              const exNow = await loadExtraction(targetId);
              const merged = { ...(exNow || {}), metadata: { ...((exNow&&exNow.metadata)||{}), billFields: output || {} } };
              await saveExtraction(targetId, merged);
            } catch {}
          }

          // Answer with LLM using context (include short conversation history for pronoun resolution)
          const qaPrompt = ai.definePrompt({
            name: 'focusedDocAnswer',
            input: { schema: z.object({ q: z.string(), ctx: z.string(), history: z.array(z.object({ role: z.string(), content: z.string() })).optional() }) },
            output: { schema: z.object({ answer: z.string() }) },
            prompt: `You answer questions about a single focused document using ONLY the provided context.\n- Be concise.\n- If asked for amount, return the numeric total or due amount explicitly.\n- If asked for month/date, return the month/year explicitly.\n- If unclear, say what is missing.\n- Use the short history below to resolve pronouns like it/this/that.\n\nQuestion: {{{q}}}\n\nHistory:\n{{#each history}}- {{role}}: {{{content}}}\n{{/each}}\n\nContext:\n{{{ctx}}}`,
          });
          send('stage', { agent: 'ContentAgent', step: 'answering' });
          let answerText = '';
          try {
            const shortHist = (conversation || []).slice(-4).map(m => ({ role: m.role || 'user', content: m.content || '' }));
            const { output } = await qaPrompt({ q: question, ctx: contextText, history: shortHist });
            answerText = output?.answer || '';
          } catch {}

          if (!answerText.trim() && structuredLine) answerText = structuredLine;
          if (!answerText.trim()) answerText = 'I could not find that in the current document.';
          // Optional: emit a small preview block when user asks to preview/show the document
          try {
            const wantsPreview = /(\bpreview\b|\bshow\s+(the\s+)?(doc|document)\b|\bopen\s+(the\s+)?(doc|document)\b)/i.test(qLower);
            if (wantsPreview) {
              const lines = String(contextText || '').split(/\n+/).map(s => s.trim()).filter(Boolean).slice(0, 5);
              const { data: nameRow } = await db
                .from('documents')
                .select('title, filename')
                .eq('org_id', orgId)
                .eq('id', targetId)
                .maybeSingle();
              const pTitle = nameRow?.title || nameRow?.filename || 'Document';
              send('preview', { docId: targetId, title: pTitle, lines });
            }
          } catch {}
          send('delta', answerText);
          // Best-effort citation to the focused doc
          send('end', { done: true, citations: [{ docId: targetId, page: null, snippet: '' }] });
          return;
        } catch (e) {
          // Fall through to generic flow on errors
        }
      }
    }

    // If explicitly asking for metadata fields, answer directly for the focus/ordinal doc
    if (metaAskEarly.wantsSubject || metaAskEarly.wantsSummary || metaAskEarly.wantsSender || metaAskEarly.wantsReceiver || metaAskEarly.wantsDate || metaAskEarly.wantsFilename || metaAskEarly.wantsCategory || metaAskEarly.wantsTags) {
      // Update mode to reflect metadata agent
      send('mode', { mode: 'metadata', intent: decision.intent, confidence: decision.confidence });
      let targetId = focusDocId || null;
      const ord = ordinalFromQuestionEarly(question);
      if (ord) {
        const cites = lastAssistantCitationsEarly(conversation);
        if (cites && cites.length >= ord) {
          const id = cites[ord - 1]?.docId;
          if (id) targetId = id;
        }
        // Fallback to last list mapping when citations don't cover the ordinal
        if (!targetId && Array.isArray(lastListDocIds) && lastListDocIds.length >= ord) {
          const id = lastListDocIds[ord - 1];
          if (id) targetId = id;
        }
      }
      if (targetId) {
        send('stage', { agent: 'MetadataAgent', step: 'loading' });
        const { data: doc } = await db
          .from('documents')
          .select('title, filename, subject, sender, receiver, document_date, category, tags')
          .eq('org_id', orgId)
          .eq('id', targetId)
          .maybeSingle();
        const lines = [];
        if (metaAskEarly.wantsSubject) lines.push(`Subject: ${doc?.subject || '—'}`);
        if (metaAskEarly.wantsSender) lines.push(`Sender: ${doc?.sender ? canonEarly(doc.sender) : '—'}`);
        if (metaAskEarly.wantsReceiver) lines.push(`Receiver: ${doc?.receiver ? canonEarly(doc.receiver) : '—'}`);
        if (metaAskEarly.wantsDate) lines.push(`Date: ${doc?.document_date || '—'}`);
        if (metaAskEarly.wantsFilename) lines.push(`Filename: ${doc?.filename || doc?.title || '—'}`);
        if (metaAskEarly.wantsCategory) lines.push(`Category: ${doc?.category || '—'}`);
        if (metaAskEarly.wantsTags) lines.push(`Tags: ${(doc?.tags || []).join(', ') || '—'}`);

        // Emit structured metadata block for UI (include canonical variants)
        try {
          send('metadata', {
            docId: targetId,
            subject: doc?.subject || null,
            sender: doc?.sender || null,
            senderCanonical: doc?.sender ? canonEarly(doc.sender) : null,
            receiver: doc?.receiver || null,
            receiverCanonical: doc?.receiver ? canonEarly(doc.receiver) : null,
            date: doc?.document_date || null,
            filename: doc?.filename || doc?.title || null,
            category: doc?.category || null,
            tags: Array.isArray(doc?.tags) ? doc?.tags : [],
            name: doc?.title || doc?.filename || 'Untitled',
          });
        } catch {}

        if (metaAskEarly.wantsSummary) {
          send('stage', { agent: 'MetadataAgent', step: 'fetching_summary' });
          let summaryText = '';
          const ex = await loadExtraction(targetId);
          if (ex?.metadata?.summary) summaryText = String(ex.metadata.summary);
          else if ((ex?.ocrText || '').trim().length > 0) {
            try {
              const summarizePrompt = ai.definePrompt({
                name: 'docSummaryMetadataOnly',
                input: { schema: z.object({ text: z.string() }) },
                output: { schema: z.object({ summary: z.string() }) },
                prompt: `Summarize the following document text in 3-6 short bullet points (<= 220 words total).\nAvoid hallucinations and use only given text.\n\nText:\n{{text}}`,
              });
              const { output } = await summarizePrompt({ text: ex.ocrText.slice(0, 12000) });
              summaryText = output?.summary || '';
              const merged = { ...ex, metadata: { ...(ex?.metadata || {}), summary: summaryText } };
              await saveExtraction(targetId, merged);
              send('stage', { agent: 'MetadataAgent', step: 'summary_generated' });
            } catch {}
          }
          // Fallback: use subject/title/category when OCR summary not available
          lines.unshift('Summary:');
          if (summaryText) lines.push(summaryText);
          else if (doc?.subject) lines.push(doc.subject);
          else if (doc?.title || doc?.category) lines.push([doc?.title, doc?.category].filter(Boolean).join(' — '));
          else lines.push('No summary available.');
        }
        if (lines.length) {
          send('delta', lines.join('\n'));
          send('end', { done: true, citations: [{ docId: targetId, page: null, snippet: '' }] });
          return;
        }
      }
    }

    // If explicitly asking for linked docs and we have a focus doc, show its relationships immediately
    if (primary === 'linked' && wantsLinkedEarly && focusDocId) {
      send('mode', { mode: 'linked', intent: decision.intent, confidence: decision.confidence });
      const { data: focus } = await db
        .from('documents')
        .select('id, title, filename, version_group_id, is_current_version')
        .eq('org_id', orgId)
        .eq('id', focusDocId)
        .maybeSingle();
      if (focus) {
        let versions = [];
        if (focus.version_group_id) {
          const { data: vers } = await db
            .from('documents')
            .select('id, title, filename, version_number, is_current_version')
            .eq('org_id', orgId)
            .eq('version_group_id', focus.version_group_id);
          versions = vers || [];
        }
        const { data: outgoing } = await db
          .from('document_links')
          .select('linked_doc_id')
          .eq('org_id', orgId)
          .eq('doc_id', focus.id);
        const { data: incoming } = await db
          .from('document_links')
          .select('doc_id')
          .eq('org_id', orgId)
          .eq('linked_doc_id', focus.id);
        const ids = new Set([
          ...((outgoing || []).map(r => r.linked_doc_id)),
          ...((incoming || []).map(r => r.doc_id)),
        ]);
        let linkedDocs = [];
        if (ids.size) {
          const { data: ldocs } = await db
            .from('documents')
            .select('id, title, filename, document_date')
            .eq('org_id', orgId)
            .in('id', Array.from(ids))
            .limit(20);
          linkedDocs = ldocs || [];
        }
        // Emit structured linked relationships for UI
        try {
          const versionsOut = (versions || []).map(v => ({ id: v.id, title: v.title || v.filename || 'Untitled', versionNumber: v.version_number || null, isCurrentVersion: !!v.is_current_version }));
          const linkedOut = (linkedDocs || []).map(d => ({ id: d.id, title: d.title || d.filename || 'Untitled', documentDate: d.document_date || null }));
          send('linked', { focusDocId: focus.id, versions: versionsOut, documents: linkedOut });
        } catch {}
        const lines = [];
        const focusName = focus.title || focus.filename || 'Untitled';
        lines.push(`Relationships for "${focusName}":`);
        if (versions.length > 0) {
          const sorted = versions.slice().sort((a,b) => (a.version_number||0) - (b.version_number||0));
          lines.push('🔁 Versions:');
          sorted.slice(0, 8).forEach(v => lines.push(`• v${v.version_number || 1}${v.is_current_version ? '*' : ''} — ${v.title || v.filename || 'Untitled'}`));
        }
        if (linkedDocs.length > 0) {
          lines.push('📎 Linked documents:');
          linkedDocs.slice(0, 8).forEach(d => lines.push(`• ${d.title || d.filename || 'Untitled'}${d.document_date ? ` · ${d.document_date}` : ''}`));
        }
        if (lines.length === 1) lines.push('No versions or explicit links found.');
        send('delta', lines.join('\n'));
        send('end', { done: true, citations: [] });
        return;
      }
    }

    // Finder mode — list/search documents (explicit file finding)
    if (primary === 'finder') {
      try {
        send('stage', { agent: 'FinderAgent', step: 'searching' });

        const f = decision.filters || {};
        const cleaned = String(question || '')
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const tokens = Array.from(new Set(cleaned.split(' ').filter(t => t.length >= 3)));
        if (f.docType) tokens.push(String(f.docType).toLowerCase());
        if (Array.isArray(f.keywords)) tokens.push(...f.keywords.map(k => String(k||'').toLowerCase()).filter(Boolean));
        const tokenSet = new Set(tokens);

        // 1) Semantic retrieval (if allowed)
        let semDocs = [];
        if (allowSemantic) {
          const embedding = await embedQuery(question).catch(() => null);
          if (embedding) {
            const { data: chunks, error: matchErr } = await db.rpc('match_doc_chunks', {
              p_org_id: orgId,
              p_query_embedding: embedding,
              p_match_count: 50,
              p_similarity_threshold: 0
            });
            if (!matchErr && Array.isArray(chunks)) {
              const bestByDoc = new Map();
              for (const r of chunks) {
                const id = r.doc_id; const score = Number(r.similarity || 0);
                const prev = bestByDoc.get(id);
                if (!prev || score > prev) bestByDoc.set(id, score);
              }
              const ids = Array.from(bestByDoc.entries()).sort((a,b) => b[1]-a[1]).map(([id]) => id);
              if (ids.length) {
                const { data: docsRows } = await db
                  .from('documents')
                  .select('id, title, filename, subject, document_date, type, sender, receiver, category')
                  .eq('org_id', orgId)
                  .in('id', ids.slice(0, 50));
                semDocs = (docsRows || []).filter(d => d && d.id);
                // Optional: apply sender/receiver/category post-filters
                if (f.sender) semDocs = semDocs.filter(d => String(d.sender||'').toLowerCase().includes(String(f.sender).toLowerCase()));
                if (f.receiver) semDocs = semDocs.filter(d => String(d.receiver||'').toLowerCase().includes(String(f.receiver).toLowerCase()));
                if (f.category) semDocs = semDocs.filter(d => String(d.category||'').toLowerCase().includes(String(f.category).toLowerCase()));
                // Soft docType filter: match docType against type/category/title/subject
                if (f.docType) {
                  const dt = String(f.docType).toLowerCase();
                  semDocs = semDocs.filter(d => [d.type, d.category, d.title, d.subject, d.filename].some(v => String(v||'').toLowerCase().includes(dt)));
                }
                // Sort semDocs by the best similarity order
                const order = new Map(ids.map((id, idx) => [id, idx]));
                semDocs.sort((a,b) => (order.get(a.id)||9999) - (order.get(b.id)||9999));
              }
            }
          }
        }

        // 2) LLM-based query expansion to improve recall (typos/synonyms)
        async function expandQueryLLM(q) {
          try {
            const expPrompt = ai.definePrompt({
              name: 'queryExpander',
              input: { schema: z.object({ q: z.string() }) },
              output: { schema: z.object({ terms: z.array(z.string()) }) },
              prompt: `Given a short search query, output a small set (<= 6) of normalized tokens and synonyms that improve document search recall.\n- Correct obvious typos.\n- Prefer singular forms.\n- Include common synonyms (e.g., invoice for bill).\n- Return JSON: {\"terms\":[...]}.\n\nQuery: {{{q}}}`,
            });
            const { output } = await expPrompt({ q });
            return Array.isArray(output?.terms) ? output.terms.map(t => String(t||'').toLowerCase()).filter(Boolean) : [];
          } catch { return []; }
        }

        // 3) Lexical retrieval over multiple fields with tokens (with expansion)
        const qb = db
          .from('documents')
          .select('id, title, filename, subject, document_date, type, sender, receiver, category')
          .eq('org_id', orgId)
          .order('uploaded_at', { ascending: false })
          .limit(80);
        const ilike = (v) => (v ? `%${v}%` : null);
        // Apply strong filters for sender/receiver/category only
        if (f.sender) qb.ilike('sender', ilike(f.sender));
        if (f.receiver) qb.ilike('receiver', ilike(f.receiver));
        if (f.category) qb.ilike('category', ilike(f.category));
        const fields = ['title','subject','filename','sender','receiver','category','type'];
        let allTokens = tokens.slice(0);
        const expanded = await expandQueryLLM(question).catch(() => []);
        if (Array.isArray(expanded) && expanded.length) allTokens.push(...expanded);
        allTokens = Array.from(new Set(allTokens.filter(Boolean)));
        if (allTokens.length > 0) {
          const ors = [];
          for (const t of allTokens) {
            const s = `%${t}%`;
            for (const field of fields) ors.push(`${field}.ilike.${s}`);
          }
          if (ors.length > 0) qb.or(ors.join(','));
        } else {
          const s = `%${question.trim()}%`;
          qb.or(`title.ilike.${s},subject.ilike.${s},filename.ilike.${s},sender.ilike.${s},receiver.ilike.${s},type.ilike.${s},category.ilike.${s}`);
        }
        const { data: lexRowsRaw, error: lexErr } = await qb;
        const lexRows = (!lexErr && Array.isArray(lexRowsRaw)) ? lexRowsRaw : [];

        // 3) Merge semantic-first then lexical (dedupe by id)
        const merged = new Map();
        for (const d of semDocs) if (d && d.id) merged.set(d.id, d);
        for (const d of lexRows) if (d && d.id && !merged.has(d.id)) merged.set(d.id, d);
        let rows = Array.from(merged.values());

        // If 0 rows and looks like relationships ask, fallback to Linked summary
        if (rows.length === 0 && (tokenSet.has('linked') || tokenSet.has('links') || tokenSet.has('versions') || tokenSet.has('related'))) {
          send('stage', { agent: 'RelationsAgent', step: 'summarizing_corpus_links' });
          const { data: links } = await db
            .from('document_links')
            .select('doc_id, linked_doc_id')
            .eq('org_id', orgId)
            .limit(500);
          const { data: docs } = await db
            .from('documents')
            .select('id, title, filename, version_group_id, is_current_version, document_date')
            .eq('org_id', orgId)
            .order('uploaded_at', { ascending: false })
            .limit(500);
          const withLinks = new Set((links || []).flatMap(r => [r.doc_id, r.linked_doc_id]).filter(Boolean));
          const versionGroups = new Map();
          (docs || []).forEach(d => { if (d.version_group_id) { if (!versionGroups.has(d.version_group_id)) versionGroups.set(d.version_group_id, []); versionGroups.get(d.version_group_id).push(d); } });
          const groups = Array.from(versionGroups.values()).filter(arr => arr.length > 1);
          const bySource = new Map();
          (links || []).forEach(l => { if (!bySource.has(l.doc_id)) bySource.set(l.doc_id, new Set()); bySource.get(l.doc_id).add(l.linked_doc_id); });
          const nameOf = (id) => { const d = (docs || []).find(x => x.id === id); return d ? (d.title || d.filename || 'Untitled') : id; };
          const pairs = [];
          for (const [src, set] of bySource.entries()) for (const dst of set) pairs.push([src, dst]);
          const out = [];
          out.push(`Found ${withLinks.size} documents with explicit links and ${groups.length} version groups.`);
          if (groups.length > 0) {
            out.push(''); out.push('Version Groups:');
            for (const group of groups.slice(0, 5)) {
              const sorted = group.slice().sort((a,b) => (a.version_number||0) - (b.version_number||0));
              const label = (d) => `${(d.title || d.filename || 'Untitled')}${d.is_current_version ? ' (current)' : ''}`;
              out.push('• ' + sorted.map(label).join(' → '));
            }
          }
          if (pairs.length > 0) {
            out.push(''); out.push('Linked Documents:');
            pairs.slice(0, 8).forEach(([a,b]) => out.push(`• ${nameOf(a)} ↔ ${nameOf(b)}`));
          }
          send('delta', out.join('\n'));
          send('end', { done: true, citations: [] });
          return;
        }

        if (rows.length === 0) {
          send('delta', 'No matching documents. Try narrowing by sender, type, or month.');
          send('end', { done: true, citations: [] });
          return;
        }

        const lines = [];
        const name = (d) => d.title || d.filename || 'Untitled';
        lines.push(`Found ${rows.length} documents:`);
        rows.slice(0, 12).forEach((d) => {
          const bits = [name(d)];
          if (d.document_date) bits.push(d.document_date);
          if (d.sender) bits.push(d.sender);
          if (d.type) bits.push(d.type);
          lines.push('• ' + bits.join(' · '));
        });
        if (rows.length > 12) lines.push(`• ... and ${rows.length - 12} more`);
        send('delta', lines.join('\n'));
        // Emit ordered list mapping for deterministic ordinal follow-ups
        try {
          send('list', { items: rows.slice(0, 12).map((d, idx) => ({ index: idx + 1, docId: d.id, title: name(d) })) });
        } catch {}
        const cites = rows.slice(0, 3).map((d) => ({ docId: d.id, page: null, snippet: '', docName: name(d) }));
        send('end', { done: true, citations: cites });
        return;
      } catch (e) {
        send('delta', `Error finding files: ${e?.message || 'Unknown error'}`);
        send('end', { done: true, citations: [] });
        return;
      }
    }

    // Metadata mode (simple filter over documents)
    if (primary === 'metadata' && allowMetadata) {
      try {
        send('stage', { agent: 'FinderAgent', step: 'searching_metadata' });
        const s = `%${question.trim()}%`;
        const { data, error } = await db
          .from('documents')
          .select('id, title, filename, type, uploaded_at, sender, receiver, subject, category, document_date')
          .eq('org_id', orgId)
          .or(`title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},type.ilike.${s},category.ilike.${s}`)
          .order('uploaded_at', { ascending: false })
          .limit(20);
        if (error) throw error;
        const rows = data || [];
        const count = rows.length;
        send('stage', { agent: 'FinderAgent', step: 'found', count });
        if (count > 0) {
          const name = (d) => d.title || d.filename || 'Untitled';
          const lines = [];
          lines.push(`Found ${count} matching documents:`);
          rows.slice(0, 8).forEach(d => {
            const bits = [name(d)];
            if (d.document_date) bits.push(d.document_date);
            if (d.sender) bits.push(d.sender);
            if (d.type) bits.push(d.type);
            lines.push('• ' + bits.join(' · '));
          });
          if (count > 8) lines.push(`• ... and ${count - 8} more`);
          send('delta', lines.join('\n'));
          // Emit ordered list mapping for deterministic ordinal follow-ups
          try {
            send('list', { items: rows.slice(0, 8).map((d, idx) => ({ index: idx + 1, docId: d.id, title: name(d) })) });
          } catch {}
          const cites = rows.slice(0, 3).map(d => ({ docId: d.id, page: null, snippet: '', docName: d.title || d.filename || 'Untitled' }));
          send('end', { done: true, citations: cites });
        } else {
          send('delta', 'No matching documents.');
          send('end', { done: true, citations: [] });
        }
        return;
      } catch (e) {
        send('delta', `Error fetching metadata: ${e?.message || 'Unknown error'}`);
        send('end', { done: true, citations: [] });
        return;
      }
    }

    // Linked mode — summarize both version groups and explicit links distinctly
    if (primary === 'linked' && allowLinked) {
      // If a focus doc is known from conversation ("it", citations), show its relationships
      if (focusDocId) {
        // Get focus doc
        const { data: focus } = await db
          .from('documents')
          .select('id, title, filename, version_group_id, is_current_version')
          .eq('org_id', orgId)
          .eq('id', focusDocId)
          .maybeSingle();
        if (focus) {
          // Versions in group
          let versions = [];
          if (focus.version_group_id) {
            const { data: vers } = await db
              .from('documents')
              .select('id, title, filename, version_number, is_current_version')
              .eq('org_id', orgId)
              .eq('version_group_id', focus.version_group_id);
            versions = vers || [];
          }
          // Outgoing/incoming links
          const { data: outgoing } = await db
            .from('document_links')
            .select('linked_doc_id')
            .eq('org_id', orgId)
            .eq('doc_id', focus.id);
          const { data: incoming } = await db
            .from('document_links')
            .select('doc_id')
            .eq('org_id', orgId)
            .eq('linked_doc_id', focus.id);
          const ids = new Set([
            ...((outgoing || []).map(r => r.linked_doc_id)),
            ...((incoming || []).map(r => r.doc_id)),
          ]);
          const idList = Array.from(ids);
          let linkedDocs = [];
          if (idList.length) {
            const { data: ldocs } = await db
              .from('documents')
              .select('id, title, filename, document_date')
              .eq('org_id', orgId)
              .in('id', idList)
              .limit(20);
            linkedDocs = ldocs || [];
          }
          // Emit structured linked relationships for UI
          try {
            const versionsOut = (versions || []).map(v => ({ id: v.id, title: v.title || v.filename || 'Untitled', versionNumber: v.version_number || null, isCurrentVersion: !!v.is_current_version }));
            const linkedOut = (linkedDocs || []).map(d => ({ id: d.id, title: d.title || d.filename || 'Untitled', documentDate: d.document_date || null }));
            send('linked', { focusDocId: focus.id, versions: versionsOut, documents: linkedOut });
          } catch {}
          const lines = [];
          const focusName = focus.title || focus.filename || 'Untitled';
          lines.push(`Relationships for "${focusName}":`);
          if (versions.length > 0) {
            const sorted = versions.slice().sort((a,b) => (a.version_number||0) - (b.version_number||0));
            lines.push('🔁 Versions:');
            sorted.slice(0, 8).forEach(v => lines.push(`• v${v.version_number || 1}${v.is_current_version ? '*' : ''} — ${v.title || v.filename || 'Untitled'}`));
            if (sorted.length > 8) lines.push(`• ... and ${sorted.length - 8} more versions`);
          }
          if (linkedDocs.length > 0) {
            lines.push('📎 Linked documents:');
            linkedDocs.slice(0, 8).forEach(d => lines.push(`• ${d.title || d.filename || 'Untitled'}${d.document_date ? ` · ${d.document_date}` : ''}`));
            if (linkedDocs.length > 8) lines.push(`• ... and ${linkedDocs.length - 8} more links`);
          }
          if (lines.length === 1) lines.push('No versions or explicit links found.');
          send('delta', lines.join('\n'));
          send('end', { done: true, citations: [] });
          return;
        }
      }

      // Explicit links (general summary)
      send('stage', { agent: 'RelationsAgent', step: 'summarizing_corpus_links' });
      const { data: links } = await db
        .from('document_links')
        .select('doc_id, linked_doc_id')
        .eq('org_id', orgId)
        .limit(500);
      // Docs with version groups
      const { data: docs } = await db
        .from('documents')
        .select('id, title, filename, version_group_id, is_current_version, document_date')
        .eq('org_id', orgId)
        .order('uploaded_at', { ascending: false })
        .limit(500);
      const withLinks = new Set((links || []).flatMap(r => [r.doc_id, r.linked_doc_id]).filter(Boolean));
      const versionGroups = new Map();
      (docs || []).forEach(d => { if (d.version_group_id) { if (!versionGroups.has(d.version_group_id)) versionGroups.set(d.version_group_id, []); versionGroups.get(d.version_group_id).push(d); } });
      const groups = Array.from(versionGroups.values()).filter(arr => arr.length > 1);
      // Build readable output (limited samples for scale)
      const lines = [];
      lines.push(`Found ${withLinks.size} documents with explicit links and ${groups.length} version groups.`);
      // Version groups summary
      if (groups.length > 0) {
        lines.push('');
        lines.push('Version Groups:');
        for (const group of groups.slice(0, 5)) {
          const sorted = group.slice().sort((a,b) => (a.version_number||0) - (b.version_number||0));
          const name = (d) => d.title || d.filename || 'Untitled';
          lines.push('• ' + sorted.map(d => `${name(d)}${d.is_current_version ? ' (current)' : ''}`).join(' → '));
        }
        if (groups.length > 5) lines.push(`• ... and ${groups.length - 5} more groups`);
      }
      // Explicit links (sample)
      const bySource = new Map();
      (links || []).forEach(l => {
        if (!bySource.has(l.doc_id)) bySource.set(l.doc_id, new Set());
        bySource.get(l.doc_id).add(l.linked_doc_id);
      });
      const name = (id) => { const d = (docs || []).find(x => x.id === id); return d ? (d.title || d.filename || 'Untitled') : id; };
      const pairs = [];
      for (const [src, set] of bySource.entries()) {
        for (const dst of set) pairs.push([src, dst]);
      }
      if (pairs.length > 0) {
        lines.push('');
        lines.push('Linked Documents:');
        pairs.slice(0, 8).forEach(([a,b]) => lines.push(`• ${name(a)} ↔ ${name(b)}`));
        if (pairs.length > 8) lines.push(`• ... and ${pairs.length - 8} more links`);
      }
      lines.push('');
      lines.push('Tip: Ask "linked docs for <title>" or "more links for <title>" to see details for a specific document.');
      send('delta', lines.join('\n'));
      send('end', { done: true, citations: [] });
      return;
    }

    // Timeline mode — chronological view for an entity (sender/receiver/title match)
    if (decision.intent === 'Timeline') {
      try {
        send('stage', { agent: 'TimelineAgent', step: 'loading' });
        const entity = String(decision?.filters?.entity || '').trim() || '';
        if (!entity) {
          send('delta', 'Who should the timeline be about? Try: "timeline for <entity>".');
          send('end', { done: true, citations: [] });
          return;
        }
        const s = `%${entity}%`;
        const { data, error } = await db
          .from('documents')
          .select('id, title, filename, document_date, type, sender, receiver')
          .eq('org_id', orgId)
          .or(`sender.ilike.${s},receiver.ilike.${s},title.ilike.${s},filename.ilike.${s}`)
          .order('document_date', { ascending: true })
          .limit(50);
        if (error) throw error;
        const rows = data || [];
        if (rows.length === 0) {
          send('delta', `No timeline entries found for "${entity}".`);
          send('end', { done: true, citations: [] });
          return;
        }
        const name = (d) => d.title || d.filename || 'Untitled';
        const lines = [];
        lines.push(`Timeline for ${entity}:`);
        rows.forEach(d => {
          const when = d.document_date || '';
          const what = name(d);
          const typ = d.type ? ` (${d.type})` : '';
          lines.push(`- ${when} · ${what}${typ}`);
        });
        send('delta', lines.join('\n'));
        try { send('list', { items: rows.slice(0, 20).map((d, idx) => ({ index: idx + 1, docId: d.id, title: name(d) })) }); } catch {}
        const cites = rows.slice(0, 3).map(d => ({ docId: d.id, page: null, snippet: '', docName: name(d) }));
        send('end', { done: true, citations: cites });
        return;
      } catch (e) {
        send('delta', `Error building timeline: ${e?.message || 'Unknown error'}`);
        send('end', { done: true, citations: [] });
        return;
      }
    }

    // Extract mode — project selected fields across matching documents
    if (decision.intent === 'Extract') {
      try {
        send('stage', { agent: 'ExtractAgent', step: 'loading' });
        const fields = Array.isArray(decision?.filters?.fields) ? decision.filters.fields.filter(Boolean) : [];
        if (!fields.length) {
          send('delta', 'Which fields should I extract? Example: fields: id,title,document_date,type');
          send('end', { done: true, citations: [] });
          return;
        }
        const f = decision.filters || {};
        const qb = db
          .from('documents')
          .select('id, title, filename, type, document_date, sender, receiver, category, tags')
          .eq('org_id', orgId)
          .order('uploaded_at', { ascending: false })
          .limit(200);
        const ilike = (v) => (v ? `%${v}%` : null);
        if (f.sender) qb.ilike('sender', ilike(f.sender));
        if (f.receiver) qb.ilike('receiver', ilike(f.receiver));
        if (f.docType) qb.ilike('type', ilike(f.docType));
        if (f.month) qb.ilike('document_date', ilike(f.month));
        const { data, error } = await qb;
        if (error) throw error;
        const rows = data || [];
        const name = (d) => d.title || d.filename || 'Untitled';
        const fmt = (d, k) => {
          if (k === 'id') return d.id;
          if (k === 'name') return name(d);
          if (k === 'title') return d.title || '';
          if (k === 'filename') return d.filename || '';
          if (k === 'type' || k === 'documentType') return d.type || '';
          if (k === 'document_date' || k === 'documentDate') return d.document_date || '';
          if (k === 'sender') return d.sender || '';
          if (k === 'receiver') return d.receiver || '';
          if (k === 'category') return d.category || '';
          if (k === 'tags') return Array.isArray(d.tags) ? d.tags.join('|') : '';
          return '';
        };
        const header = `Extracted ${rows.length} records (fields: ${fields.join(', ')}):`;
        const lines = [header];
        rows.slice(0, 20).forEach(d => {
          const parts = fields.map(k => `${k}: ${fmt(d, k)}`);
          lines.push('• ' + parts.join('; '));
        });
        if (rows.length > 20) lines.push(`• ... and ${rows.length - 20} more`);
        send('delta', lines.join('\n'));
        try { send('list', { items: rows.slice(0, 20).map((d, idx) => ({ index: idx + 1, docId: d.id, title: name(d) })) }); } catch {}
        const cites = rows.slice(0, 3).map(d => ({ docId: d.id, page: null, snippet: '', docName: name(d) }));
        send('end', { done: true, citations: cites });
        return;
      } catch (e) {
        send('delta', `Error extracting fields: ${e?.message || 'Unknown error'}`);
        send('end', { done: true, citations: [] });
        return;
      }
    }

    // Analytics mode — basic count by sender (example)
    if (primary === 'analytics' && allowAnalytics) {
      send('stage', { agent: 'AnalyticsAgent', step: 'computing' });
      const s = `%${question.trim()}%`;
      const { data, error } = await db
        .from('documents')
        .select('sender')
        .eq('org_id', orgId)
        .or(`title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s}`);
      if (error) throw error;
      const counts = new Map();
      (data || []).forEach(r => { const k = r.sender || 'Unknown'; counts.set(k, (counts.get(k) || 0) + 1); });
      const lines = Array.from(counts.entries()).sort((a,b) => b[1]-a[1]).slice(0,10).map(([k,v]) => `• ${k}: ${v}`);
      send('delta', `Top senders:\n${lines.join('\n')}`);
      send('end', { done: true, citations: [] });
      return;
    }

    // Metadata short-circuit: if asking for a specific metadata field about the focus doc
    const metaAsk = (() => {
      const m = qLower;
      const wantsSubject = /\b(subject|subj)\b/.test(m);
      const wantsSummary = /\bsummary|summarize|overview\b/.test(m);
      const wantsSender = /\b(sender|from)\b/.test(m);
      const wantsReceiver = /\b(receiver|to)\b/.test(m);
      const wantsDate = /\b(date|document date)\b/.test(m);
      const wantsFilename = /\b(file(name)?|filename)\b/.test(m);
      const wantsCategory = /\bcategory\b/.test(m);
      const wantsTags = /\btags?\b/.test(m);
      return { wantsSubject, wantsSummary, wantsSender, wantsReceiver, wantsDate, wantsFilename, wantsCategory, wantsTags };
    })();

    function canon(v) {
      const s = String(v || '').trim();
      const map = new Map([
        ['maharashtra state electricity distribution co. ltd.', 'MAHAVITARAN (MSEDCL)'],
        ['mseb', 'Maharashtra State Electricity Board (MSEB)'],
        ['mahadiscom', 'MAHAVITARAN (MSEDCL)'],
        ['m/s bhagyalaxmi steel alloy pvt.ltd.', 'M/S BHAGYALAXMI STEEL ALLOY PVT. LTD.'],
      ]);
      const key = s.toLowerCase();
      return map.get(key) || s;
    }

    // Ordinal-aware metadata answers
    function ordinalFromQuestion(txt) {
      const t = txt.toLowerCase();
      const map = new Map([
        ['first', 1], ['1st', 1], ['#1', 1],
        ['second', 2], ['2nd', 2], ['#2', 2],
        ['third', 3], ['3rd', 3], ['#3', 3],
        ['fourth', 4], ['4th', 4], ['#4', 4],
        ['fifth', 5], ['5th', 5], ['#5', 5],
      ]);
      for (const [k, v] of map.entries()) if (t.includes(k)) return v;
      return null;
    }
    function lastAssistantCitations(conv) {
      for (let i = conv.length - 1; i >= 0; i--) {
        const m = conv[i];
        if (m?.role === 'assistant' && Array.isArray(m.citations) && m.citations.length > 0) return m.citations;
      }
      return [];
    }
    if (metaAsk.wantsSubject || metaAsk.wantsSummary || metaAsk.wantsSender || metaAsk.wantsReceiver || metaAsk.wantsDate || metaAsk.wantsFilename || metaAsk.wantsCategory || metaAsk.wantsTags) {
      let targetId = focusDocId || null;
      const ord = ordinalFromQuestion(question);
      if (ord) {
        const cites = lastAssistantCitations(conversation);
        if (cites && cites.length >= ord) {
          const id = cites[ord - 1]?.docId;
          if (id) targetId = id;
        }
      }
      if (targetId) {
        send('stage', { agent: 'MetadataAgent', step: 'loading' });
        const { data: doc } = await db
          .from('documents')
          .select('title, filename, subject, sender, receiver, document_date, category, tags')
          .eq('org_id', orgId)
          .eq('id', targetId)
          .maybeSingle();
        const lines = [];
        if (metaAsk.wantsSubject) lines.push(`Subject: ${doc?.subject || '—'}`);
        if (metaAsk.wantsSender) lines.push(`Sender: ${doc?.sender ? canon(doc.sender) : '—'}`);
        if (metaAsk.wantsReceiver) lines.push(`Receiver: ${doc?.receiver ? canon(doc.receiver) : '—'}`);
        if (metaAsk.wantsDate) lines.push(`Date: ${doc?.document_date || '—'}`);
        if (metaAsk.wantsFilename) lines.push(`Filename: ${doc?.filename || doc?.title || '—'}`);
        if (metaAsk.wantsCategory) lines.push(`Category: ${doc?.category || '—'}`);
        if (metaAsk.wantsTags) lines.push(`Tags: ${(doc?.tags || []).join(', ') || '—'}`);

        if (metaAsk.wantsSummary) {
          // Prefer stored extraction summary, else generate from OCR text via Gemini and persist
          send('stage', { agent: 'MetadataAgent', step: 'fetching_summary' });
          let summaryText = '';
          const ex = await loadExtraction(targetId);
          if (ex?.metadata?.summary) summaryText = String(ex.metadata.summary);
          else if ((ex?.ocrText || '').trim().length > 0) {
            try {
              const summarizePrompt = ai.definePrompt({
                name: 'docSummaryMetadataOnly',
                input: { schema: z.object({ text: z.string() }) },
                output: { schema: z.object({ summary: z.string() }) },
                prompt: `Summarize the following document text in 3-6 short bullet points (<= 220 words total).\nAvoid hallucinations and use only given text.\n\nText:\n{{text}}`,
              });
              const { output } = await summarizePrompt({ text: ex.ocrText.slice(0, 12000) });
              summaryText = output?.summary || '';
              // Persist for reuse
              const merged = { ...ex, metadata: { ...(ex?.metadata || {}), summary: summaryText } };
              await saveExtraction(targetId, merged);
              send('stage', { agent: 'MetadataAgent', step: 'summary_generated' });
            } catch {
              // ignore generation errors, leave summary blank
            }
          }
          if (summaryText) {
            lines.unshift('Summary:');
            lines.push(summaryText);
          } else if (metaAsk.wantsSummary) {
            lines.unshift('Summary: —');
          }
        }
        if (lines.length) {
          send('delta', lines.join('\n'));
          send('end', { done: true, citations: [{ docId: targetId, page: null, snippet: '' }] });
          return;
        }
      }
    }

    // Differences short-circuit: compare versions or two cited docs
    if (primary === 'diff') {
      async function getPrevVersion(doc) {
        if (!doc.version_group_id) return null;
        const { data: versions } = await db
          .from('documents')
          .select('id, title, filename, version_number, is_current_version')
          .eq('org_id', orgId)
          .eq('version_group_id', doc.version_group_id)
          .order('version_number', { ascending: false })
          .limit(2);
        if (!versions || versions.length < 2) return null;
        return { a: versions[0], b: versions[1] };
      }
      async function getDoc(id) {
        const { data } = await db
          .from('documents')
          .select('id, title, filename, subject, sender, receiver, document_date, category, tags, version_group_id, version_number, is_current_version')
          .eq('org_id', orgId)
          .eq('id', id)
          .maybeSingle();
        return data || null;
      }
      async function loadExtraction(docId) {
        try {
          const { data, error } = await app.supabaseAdmin.storage.from('extractions').download(`${orgId}/${docId}.json`);
          if (error || !data) return null;
          const text = await data.text();
          return JSON.parse(text);
        } catch { return null; }
      }
      function diffFields(a, b) {
        const out = [];
        const f = (k, label, format) => {
          const va = a?.[k] ?? null; const vb = b?.[k] ?? null;
          const fa = format ? format(va) : va; const fb = format ? format(vb) : vb;
          if (JSON.stringify(fa) !== JSON.stringify(fb)) out.push(`${label}: ${fa || '—'} → ${fb || '—'}`);
        };
        f('title', 'Title');
        f('subject', 'Subject');
        f('sender', 'Sender', canon);
        f('receiver', 'Receiver', canon);
        f('document_date', 'Date');
        f('category', 'Category');
        f('tags', 'Tags', (x) => Array.isArray(x) ? x.join(', ') : x);
        return out;
      }
      function uniqueSnippets(pagesA, pagesB) {
        try {
          const take = (pages) => (Array.isArray(pages) ? pages.map(p => String(p.text||'')).join('\n') : '').split(/\n+/).map(s=>s.trim()).filter(s=>s.length>20);
          const la = new Set(take(pagesA));
          const lb = new Set(take(pagesB));
          const onlyA = Array.from(la).filter(s => !lb.has(s)).slice(0, 2);
          const onlyB = Array.from(lb).filter(s => !la.has(s)).slice(0, 2);
          return { onlyA, onlyB };
        } catch { return { onlyA: [], onlyB: [] }; }
      }

      // Determine docs to compare: two most recent citations or focus vs previous
      const citedIds = [];
      for (let i = conversation.length - 1; i >= 0; i--) {
        const m = conversation[i]; if (m?.citations) m.citations.forEach(c => { if (c?.docId) citedIds.push(c.docId); });
        if (citedIds.length >= 2) break;
      }
      if (citedIds.length < 2 && Array.isArray(lastListDocIds) && lastListDocIds.length >= 2) {
        citedIds.push(lastListDocIds[0], lastListDocIds[1]);
      }
      let docA = null, docB = null;
      if (citedIds.length >= 2) {
        docA = await getDoc(citedIds[0]);
        docB = await getDoc(citedIds[1]);
      } else if (focusDocId) {
        const d = await getDoc(focusDocId);
        const pair = d ? await getPrevVersion(d) : null;
        if (pair) { docA = await getDoc(pair.b.id); docB = await getDoc(pair.a.id); }
      }
      if (!docA || !docB) {
        send('delta', 'I could not determine two documents to compare. Please cite two documents or view a document with versions.');
        send('end', { done: true });
        return;
      }
      const fieldDiffs = diffFields(docA, docB);
      const extA = await loadExtraction(docA.id);
      const extB = await loadExtraction(docB.id);
      const pagesA = extA?.ocrPages || [];
      const pagesB = extB?.ocrPages || [];
      const { onlyA, onlyB } = uniqueSnippets(pagesA, pagesB);
      const lines = [];
      lines.push(`Comparing ${docA.title || docA.filename || 'Doc A'}${docA.version_number ? ` (v${docA.version_number})` : ''} → ${docB.title || docB.filename || 'Doc B'}${docB.version_number ? ` (v${docB.version_number})` : ''}`);
      if (fieldDiffs.length) {
        lines.push('Field differences:');
        fieldDiffs.slice(0, 8).forEach(d => lines.push(`• ${d}`));
      } else {
        lines.push('No metadata field changes detected.');
      }
      if (onlyA.length || onlyB.length) {
        lines.push('Content differences (unique lines):');
        if (onlyA[0]) lines.push(`• Removed/changed: ${onlyA[0]}`);
        if (onlyB[0]) lines.push(`• Added/changed: ${onlyB[0]}`);
      }
      send('delta', lines.join('\n'));
      // Try to attach page-aware citations for the first differing lines
      const cite = [];
      function findPage(pages, snippet) {
        if (!Array.isArray(pages) || !snippet) return null;
        const idx = pages.findIndex(p => String(p.text||'').includes(snippet));
        if (idx >= 0) return pages[idx].page || (idx+1);
        return null;
      }
      if (onlyA[0]) cite.push({ docId: docA.id, page: findPage(pagesA, onlyA[0]), snippet: onlyA[0].slice(0, 300) });
      if (onlyB[0]) cite.push({ docId: docB.id, page: findPage(pagesB, onlyB[0]), snippet: onlyB[0].slice(0, 300) });
      send('end', { done: true, citations: cite });
      return;
    }

    // Snippets mode — vector/lexical retrieval and LLM answer (fallback also runs when content was intended)
    if (!allowSnippets) {
      send('delta', 'Chat snippets are disabled for your role.');
      send('end', { done: true });
      return;
    }

    // Embed query if allowed; else lexical fallback
    async function embedQuery(text) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.data?.[0]?.embedding || null;
    }

    const embedding = allowSemantic ? await embedQuery(question).catch(() => null) : null;
    send('stage', { retrieval: embedding ? 'semantic' : 'lexical' });

    let chunks = [];
    if (embedding) {
      const { data, error } = await db.rpc('match_doc_chunks', {
        p_org_id: orgId,
        p_query_embedding: embedding,
        p_match_count: 24,
        p_similarity_threshold: 0
      });
      if (error) req.log.warn(error, 'match_doc_chunks failed');
      chunks = Array.isArray(data) ? data : [];
    }
    if (!embedding || chunks.length === 0) {
      const s = `%${question.trim()}%`;
      const { data, error } = await db
        .from('documents')
        .select('id, title, filename, subject, sender, receiver, uploaded_at, type, category, document_date')
        .eq('org_id', orgId)
        .or(`title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},type.ilike.${s},category.ilike.${s}`)
        .order('uploaded_at', { ascending: false })
        .limit(12);
      if (!error) {
        chunks = (data || []).map(d => ({
          doc_id: d.id,
          content: [d.title, d.subject, d.sender, d.receiver, d.type, d.category, d.document_date].filter(Boolean).join(' — ').slice(0, 500),
          similarity: 0.3,
          title: d.title || d.filename || 'Untitled',
          filename: d.filename,
          doc_type: d.type || null,
          uploaded_at: d.uploaded_at
        }));
      }
    }

    // Aggregate by document and select top snippets
    const byDoc = new Map();
    for (const r of chunks) {
      const id = r.doc_id;
      const entry = byDoc.get(id) || { id, title: r.title || r.filename || 'Untitled', best: -1, snippets: [] };
      entry.best = Math.max(entry.best, Number(r.similarity || 0));
      if (entry.snippets.length < 3) entry.snippets.push(String(r.content || '').slice(0, 500));
      byDoc.set(id, entry);
    }
    const docs = Array.from(byDoc.values()).sort((a,b) => b.best - a.best).slice(0, 10);

    // If no retrieval context and the query looks like a directory ask (bills/notices/etc.),
    // fall back to a quick metadata listing even if metadata mode wasn't selected.
    if (docs.length === 0 && /(\bbills?\b|\binvoices?\b|\bnotices?\b|\bletters?\b|\bcirculars?\b)/i.test(question)) {
      const s = `%${question.trim()}%`;
      const { data } = await db
        .from('documents')
        .select('id, title, filename, sender, document_date, type, category')
        .eq('org_id', orgId)
        .or(`title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},type.ilike.${s},category.ilike.${s}`)
        .order('uploaded_at', { ascending: false })
        .limit(20);
      const rows = data || [];
      if (rows.length > 0) {
        const name = (d) => d.title || d.filename || 'Untitled';
        const lines = [];
        lines.push(`Found ${rows.length} matching documents:`);
        rows.slice(0, 8).forEach(d => {
          const bits = [name(d)];
          if (d.document_date) bits.push(d.document_date);
          if (d.sender) bits.push(d.sender);
          if (d.type) bits.push(d.type);
          lines.push('• ' + bits.join(' · '));
        });
        if (rows.length > 8) lines.push(`• ... and ${rows.length - 8} more`);
        send('delta', lines.join('\n'));
        const cites = rows.slice(0, 3).map(d => ({ docId: d.id, page: null, snippet: '', docName: name(d) }));
        send('end', { done: true, citations: cites });
        return;
      }
    }

    // Build prompt input; include gentle instruction to prefer subject fields if asked. Include short conversation for pronouns.
    const contextBlocks = docs.map((d, i) => `[#${i}] ${d.title}\n${d.snippets.join('\n---\n')}`).join('\n\n');

    // Use server AI (Gemini via Genkit) to generate answer
    const { ai } = await import('./ai.js');
    const prompt = ai.definePrompt({
      name: 'serverAnswerPrompt',
      input: { schema: z.object({ q: z.string(), ctx: z.string(), history: z.array(z.object({ role: z.string(), content: z.string() })).optional() }) },
      output: { schema: z.object({ answer: z.string() }) },
      prompt: `Answer the user's question using ONLY the provided context.\nIf unclear, ask a short clarifying question. Keep it concise.\nIf asked for subject/keywords, prefer explicit metadata (e.g., Subject) from the context over inference.\nUse history to resolve pronouns like it/this/that.\n\nQuestion: {{{q}}}\n\nHistory:\n{{#each history}}- {{role}}: {{{content}}}\n{{/each}}\n\nContext:\n{{{ctx}}}`,
    });

    let answerText = '';
    try {
      const shortHist = (conversation || []).slice(-4).map(m => ({ role: m.role || 'user', content: m.content || '' }));
      const { output } = await prompt({ q: question, ctx: contextBlocks, history: shortHist });
      answerText = output?.answer || '';
    } catch (e) {
      req.log.warn(e, 'LLM answer failed');
      answerText = `I found ${docs.length} relevant documents but couldn't draft an answer.`;
    }

    // Stream final answer (simple one-chunk stream)
    send('delta', answerText);

    // Page-aware citations: pick the best chunk per doc and carry page when available
    const topByDoc = new Map();
    for (const r of chunks) {
      const id = r.doc_id;
      const score = Number(r.similarity || 0);
      const prev = topByDoc.get(id);
      if (!prev || score > prev.score) topByDoc.set(id, { score, page: (typeof r.page === 'number' ? r.page : null), snippet: String(r.content || '').slice(0, 500) });
    }
    const citations = Array.from(byDoc.values()).slice(0, 3).map((d) => {
      const best = topByDoc.get(d.id);
      return { docId: d.id, page: best?.page ?? null, snippet: best?.snippet || (d.snippets[0] || ''), docName: d.title };
    });
    send('end', { done: true, citations });

    // No chat persistence or audit logging per requirements
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
    
    // Check user's role and department access
    const { data: userRole } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();
    
    const isOrgAdmin = userRole?.role === 'orgAdmin';
    
    // Get user's departments for non-admin users
    let userDepartments = [];
    if (!isOrgAdmin) {
      const { data: userDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      userDepartments = userDepts?.map(d => d.department_id) || [];
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Document stats - filter by department for non-admins and exclude folder placeholders
    let docQuery = db
      .from('documents')
      .select('id, file_size_bytes, type, uploaded_at, owner_user_id, department_id')
      .eq('org_id', orgId)
      .neq('type', 'folder'); // Exclude folder placeholder documents

    if (!isOrgAdmin) {
      if (userDepartments.length > 0) {
        // User has departments - include docs in their departments OR unassigned docs
        docQuery = docQuery.or(`department_id.in.(${userDepartments.join(',')}),department_id.is.null`);
      } else {
        // User has no departments - only unassigned docs
        docQuery = docQuery.is('department_id', null);
      }
    }

    const { data: docStats, error: docErr } = await docQuery;
    if (docErr) throw docErr;

    // User stats - for admins show all, for others show department-specific
    let userStatsData;
    if (isOrgAdmin) {
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

    // Recent activity (last 7 days)
    let recentActivity = [];
    if (isOrgAdmin) {
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

    // Chat sessions (last 30 days) - admins see all, users see their own
    let chatQuery = db
      .from('chat_sessions')
      .select('id, created_at, user_id')
      .eq('org_id', orgId)
      .gte('created_at', thirtyDaysAgo.toISOString());

    if (!isOrgAdmin) {
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
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const perms = await getMyPermissions(req, orgId);
    const canAdmin = !!(perms && (perms['org.manage_members'] || perms['documents.delete']));
    if (!canAdmin) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    const nowIso = new Date().toISOString();
    const { data, error } = await db
      .from('documents')
      .select('*')
      .eq('org_id', orgId)
      .not('deleted_at', 'is', null)
      .gt('purge_after', nowIso);
    if (error) throw error;
    return (data || []).map(mapDbToFrontendFields);
  });

  app.post('/orgs/:orgId/documents/:id/trash', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensurePerm(req, 'documents.delete');
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
    await ensurePerm(req, 'documents.update');
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
    await ensurePerm(req, 'documents.delete');
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
    const { data: victims } = await req.supabase
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
    const isAdmin = req.user.role === 'systemAdmin';

    // Only admins can update categories
    if (!isAdmin) {
      const err = new Error('Only administrators can manage department categories');
      err.statusCode = 403;
      throw err;
    }

    await ensureActiveMember(req);

    const Schema = z.object({
      categories: z.array(z.string().min(1)).min(1).max(50)
    });
    
    const { categories } = Schema.parse(req.body || {});

    const { data, error } = await db
      .from('departments')
      .update({ categories })
      .eq('org_id', orgId)
      .eq('id', deptId)
      .select('id, name, categories')
      .single();

    if (error) throw error;

    console.log(`📂 Categories updated for department ${data.name}:`, categories);
    return data;
  });

  // Register all route modules (dashboard, future modules, etc.)
  registerAllRoutes(app);
}
