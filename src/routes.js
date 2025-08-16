import { z } from 'zod';
import { ai } from './ai.js';

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
  if (typeof draft.title === 'string') out.title = draft.title;
  if (typeof draft.filename === 'string') out.filename = draft.filename;
  if (typeof draft.type === 'string') out.type = draft.type;
  if (Array.isArray(draft.folderPath)) out.folder_path = draft.folderPath.filter(Boolean);
  if (typeof draft.subject === 'string') out.subject = draft.subject;
  if (typeof draft.description === 'string') out.description = draft.description;
  if (typeof draft.category === 'string') out.category = draft.category;
  if (Array.isArray(draft.tags)) out.tags = draft.tags;
  if (Array.isArray(draft.keywords)) out.keywords = draft.keywords;
  if (typeof draft.sender === 'string') out.sender = draft.sender;
  if (typeof draft.receiver === 'string') out.receiver = draft.receiver;
  if (typeof draft.documentDate === 'string') out.document_date = draft.documentDate;
  if (typeof draft.mimeType === 'string') out.mime_type = draft.mimeType;
  if (typeof draft.fileSizeBytes === 'number') out.file_size_bytes = draft.fileSizeBytes;
  if (typeof draft.contentHash === 'string') out.content_hash = draft.contentHash;
  if (typeof draft.storage_key === 'string') out.storage_key = draft.storage_key;
  if (typeof draft.storageKey === 'string') out.storage_key = draft.storageKey;
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

// Helper to convert JS array to Postgres array literal string
function toPgArray(arr) {
  if (!Array.isArray(arr)) return '{}';
  return '{' + arr.map(s => '"' + String(s).replace(/"/g, '\"') + '"').join(',') + '}';
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

  // User-scoped settings (preferences)
  app.get('/me/settings', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const userId = req.user?.sub;
    const { data, error } = await db
      .from('user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    if (data) return data;
    // Auto-create default row for new users to persist immediately
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
      if (created) return created;
    } catch {}
    return defaults;
  });

  app.put('/me/settings', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const userId = req.user?.sub;
    const Schema = z.object({
      date_format: z.string().min(1).optional(),
      accent_color: z.string().min(1).optional(),
      dark_mode: z.boolean().optional(),
      chat_filters_enabled: z.boolean().optional(),
    });
    const body = Schema.parse(req.body || {});
    const payload = { user_id: userId, ...body };
    const { data, error } = await db
      .from('user_settings')
      .upsert(payload, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  // Organization settings (persist UI and security preferences)
  app.get('/orgs/:orgId/settings', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { data, error } = await db
      .from('org_settings')
      .select('*')
      .eq('org_id', orgId)
      .maybeSingle();
    if (error && error.code !== 'PGRST116') throw error;
    return data || {
      org_id: orgId,
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false,
      ip_allowlist_enabled: false,
      ip_allowlist_ips: [],
      categories: ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'],
    };
  });

  app.put('/orgs/:orgId/settings', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Ensure only org admins can update
    const { data: roleRow, error: rerr } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', req.user?.sub)
      .maybeSingle();
    if (rerr) throw rerr;
    if (!roleRow || roleRow.role !== 'orgAdmin') {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }

    const Schema = z.object({
      date_format: z.string().min(1).optional(),
      accent_color: z.string().min(1).optional(),
      dark_mode: z.boolean().optional(),
      chat_filters_enabled: z.boolean().optional(),
      ip_allowlist_enabled: z.boolean().optional(),
      ip_allowlist_ips: z.array(z.string()).optional(),
      categories: z.array(z.string()).optional(),
    });
    const body = Schema.parse(req.body || {});
    const payload = { org_id: orgId, ...body };
    const { data, error } = await db
      .from('org_settings')
      .upsert(payload, { onConflict: 'org_id' })
      .select('*')
      .single();
    if (error) throw error;
    return data;
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
    const { error: uoerr } = await db.from('organization_users').insert({ org_id: org.id, user_id: userId, role: 'orgAdmin' });
    if (uoerr) throw uoerr;
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
    // Only org admin can list members
    await ensureRole(req, ['orgAdmin']);
    const { data, error } = await db
      .from('organization_users')
      .select('user_id, role, expires_at, app_users(display_name)')
      .eq('org_id', orgId);
    if (error) throw error;
    const list = data || [];
    // Attach emails via Admin API
    const idToEmail = new Map();
    for (const row of list) {
      const uid = row.user_id;
      if (uid && !idToEmail.has(uid)) {
        try {
          const { data: u } = await app.supabaseAdmin.auth.admin.getUserById(uid);
          if (u?.user?.email) idToEmail.set(uid, u.user.email);
        } catch {}
      }
    }
    return list.map((r) => ({
      userId: r.user_id,
      role: r.role,
      displayName: r.app_users?.display_name || null,
      email: idToEmail.get(r.user_id) || null,
      expires_at: r.expires_at || null,
    }));
  });

  app.patch('/orgs/:orgId/users/:userId', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { userId } = req.params;
    const Schema = z.object({ role: z.enum(['orgAdmin','contentManager','contentViewer','guest']).optional(), expires_at: z.string().datetime().optional() });
    const body = Schema.parse(req.body);
    // Only org admin can modify roles/expiry
    const { data: myRoleRow, error: myRoleErr } = await db
      .from('organization_users')
      .select('role, expires_at')
      .eq('org_id', orgId)
      .eq('user_id', req.user?.sub)
      .maybeSingle();
    if (myRoleErr) throw myRoleErr;
    const isExpired = myRoleRow?.expires_at && new Date(myRoleRow.expires_at).getTime() <= Date.now();
    if (!myRoleRow || isExpired || myRoleRow.role !== 'orgAdmin') {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    const { data, error } = await db
      .from('organization_users')
      .update({ role: body.role, expires_at: body.expires_at })
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  });

  // Invite/create a user and add to org with optional expiry
  app.post('/orgs/:orgId/users', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    // Only org admin can invite
    const { data: roleRow, error: rerr } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', req.user?.sub)
      .maybeSingle();
    if (rerr) throw rerr;
    if (!roleRow || roleRow.role !== 'orgAdmin') {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    const Schema = z.object({ email: z.string().email(), display_name: z.string().optional(), role: z.enum(['orgAdmin','contentManager','contentViewer','guest']), expires_at: z.string().datetime().optional(), password: z.string().min(6).optional() });
    const body = Schema.parse(req.body || {});
    // Create auth user with a password (generate if not provided) and confirm email
    let authUserId = null;
    const tempPassword = body.password || Math.random().toString(36).slice(2, 10) + 'A!1';
    let generated = false;
    try {
      const { data, error } = await app.supabaseAdmin.auth.admin.createUser({
        email: body.email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { display_name: body.display_name || null },
      });
      if (error) throw error;
      authUserId = data?.user?.id || null;
    } catch (e) {
      // If the user already exists, try to find by iterating admin list and matching email
      try {
        const { data: list } = await app.supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const found = (list?.users || []).find((u) => (u.email || '').toLowerCase() === body.email.toLowerCase());
        authUserId = found?.id || null;
        // If a password was provided for an existing user, set it so password login works
        if (authUserId && body.password) {
          await app.supabaseAdmin.auth.admin.updateUserById(authUserId, { password: body.password, email_confirm: true });
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
    // Insert membership
    const { data, error } = await db
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
    // Only org admin can remove members
    const { data: roleRow, error: rerr } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', req.user?.sub)
      .maybeSingle();
    if (rerr) throw rerr;
    if (!roleRow || roleRow.role !== 'orgAdmin') {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    const { error } = await db
      .from('organization_users')
      .delete()
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (error) throw error;
    return { ok: true };
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

  app.get('/orgs/:orgId/audit', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
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
    const actorIds = Array.from(new Set(events.map((e) => e.actor_user_id).filter(Boolean)));

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
    let list = events.map((e) => ({ ...e }));
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

  app.get('/orgs/:orgId/documents', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { q, limit = 50, offset = 0 } = req.query || {};
    console.log('🔍 Building documents query for org:', orgId);
    console.log('🔍 Query params - q:', q, 'limit:', limit, 'offset:', offset);
    
    let query = db
      .from('documents')
      .select('*')
      .eq('org_id', orgId)
      .order('uploaded_at', { ascending: false })
      .range(offset, offset + Math.min(Number(limit), 200) - 1);
    
    // Apply folder filter after building the base query
    query = query.filter('type', 'neq', 'folder');
    
    console.log('🔍 Query built with .neq("type", "folder")');
    
    // Debug: Let's see what's actually in the database
    const { data: debugData, error: debugError } = await db
      .from('documents')
      .select('id, type, title')
      .eq('org_id', orgId)
      .limit(10);
    
    if (!debugError) {
      console.log('🔍 DEBUG - Raw database contents (first 10):', debugData);
      console.log('🔍 DEBUG - Types found:', debugData?.map(d => d.type));
      console.log('🔍 DEBUG - Any folders?', debugData?.some(d => d.type === 'folder'));
    }
    
    if (q && String(q).trim()) {
      const s = `%${String(q).trim()}%`;
      query = query.or(
        `title.ilike.${s},subject.ilike.${s},sender.ilike.${s},receiver.ilike.${s},description.ilike.${s}`
      );
    }
    console.log('🔍 Executing query...');
    const { data, error } = await query;
    if (error) {
      console.error('❌ Query error:', error);
      throw error;
    }
    
    console.log('🔍 Raw query results - Total documents:', data?.length);
    if (data && data.length > 0) {
      console.log('🔍 Document types found:', data.map(d => ({ id: d.id, type: d.type, title: d.title })));
      console.log('🔍 Any folders in results?', data.some(d => d.type === 'folder'));
    }
    
    // Double-check: manually filter out any folders that might have slipped through
    const filteredData = data?.filter(d => d.type !== 'folder') || [];
    console.log('🔍 After manual filtering - Total documents:', filteredData.length);
    console.log('🔍 Manual filter removed:', (data?.length || 0) - filteredData.length, 'folder documents');
    
    // Fetch linked documents for all documents
    const docIds = (filteredData || []).map(d => d.id);
    let linksMap = {};
    if (docIds.length > 0) {
      const { data: links, error: linksError } = await db
        .from('document_links')
        .select('doc_id, linked_doc_id')
        .eq('org_id', orgId)
        .in('doc_id', docIds);
      
      if (!linksError && links) {
        // Group linked document IDs by document ID
        linksMap = links.reduce((acc, link) => {
          if (!acc[link.doc_id]) acc[link.doc_id] = [];
          acc[link.doc_id].push(link.linked_doc_id);
          return acc;
        }, {});
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
      // Add linked document IDs from the links table
      linkedDocumentIds: linksMap[d.id] || [],
      // Add version field for backwards compatibility
      version: d.version_number || 1,
      // Add name field as alias for title/filename
      name: d.title || d.filename || 'Untitled'
    }));
    
    console.log('🔍 Final result - Returning', mappedData.length, 'documents');
    console.log('🔍 Final document types:', mappedData.map(d => d.type));
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
      name: data.title || data.filename || 'Untitled'
    };
    
    return mappedData;
  });

  app.post('/orgs/:orgId/documents', { preHandler: [app.verifyAuth, app.requireIpAccess] }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;
    const Schema = z.object({
      title: z.string().min(1),
      filename: z.string().min(1),
      type: z.string().min(1),
      folderPath: z.array(z.string()).optional(),
      subject: z.string().min(1),
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
    });
    const body = Schema.parse(req.body);
    const dbFields = toDbDocumentFields(body);
    console.log('Backend document creation - body.folderPath:', body.folderPath, 'Type:', typeof body.folderPath, 'Is Array:', Array.isArray(body.folderPath));
    console.log('Backend document creation - dbFields.folder_path:', dbFields.folder_path, 'Type:', typeof dbFields.folder_path, 'Is Array:', Array.isArray(dbFields.folder_path));
    const { data, error } = await db
      .from('documents')
      .insert({ ...dbFields, org_id: orgId, owner_user_id: userId })
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
    const body = Schema.parse(req.body);
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
    
    // First, get the document to retrieve storage information
    const { data: document, error: fetchError } = await db
      .from('documents')
      .select('storage_key, title, filename')
      .eq('org_id', orgId)
      .eq('id', id)
      .single();
      
    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        // Document not found
        const err = new Error('Document not found');
        err.statusCode = 404;
        throw err;
      }
      throw fetchError;
    }
    
    // Delete from database first
    const { error: dbError } = await db.from('documents').delete().eq('org_id', orgId).eq('id', id);
    if (dbError) throw dbError;
    
    // Clean up storage files if they exist
    const cleanupTasks = [];
    
    // 1. Delete main document file from storage
    if (document.storage_key) {
      cleanupTasks.push(
        app.supabaseAdmin.storage
          .from('documents')
          .remove([document.storage_key])
          .catch(error => console.warn(`Failed to delete document file ${document.storage_key}:`, error))
      );
    }
    
    // 2. Delete extraction data from storage
    const extractionKey = `${orgId}/${id}`;
    cleanupTasks.push(
      app.supabaseAdmin.storage
        .from('extractions')
        .remove([extractionKey])
        .catch(error => console.warn(`Failed to delete extraction data ${extractionKey}:`, error))
    );
    
    // Execute all cleanup tasks in parallel (non-blocking)
    Promise.all(cleanupTasks).catch(error => 
      console.error(`Storage cleanup failed for document ${id}:`, error)
    );
    
    // Log the deletion
    await logAudit(app, orgId, userId, 'delete', { 
      doc_id: id, 
      note: `deleted "${document.title || document.filename || 'untitled'}"`,
      storage_cleaned: !!document.storage_key
    });
    
    return { ok: true, storage_cleaned: !!document.storage_key };
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
      const extractionKey = `${orgId}/${doc.id}`;
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

  app.post('/orgs/:orgId/documents/move', { preHandler: app.verifyAuth }, async (req) => {
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

  app.post('/orgs/:orgId/documents/:id/link', { preHandler: app.verifyAuth }, async (req) => {
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

  app.delete('/orgs/:orgId/documents/:id/link/:linkedId', { preHandler: app.verifyAuth }, async (req) => {
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
  app.get('/orgs/:orgId/documents/:id/relationships', { preHandler: app.verifyAuth }, async (req) => {
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
  app.get('/orgs/:orgId/documents/:id/suggest-links', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;
    
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
    
    // Calculate similarity scores
    const suggestions = allDocs
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
      .filter(s => s.score > 10) // Minimum threshold
      .sort((a, b) => b.score - a.score)
      .slice(0, 10); // Top 10 suggestions
    
    return { suggestions };
  });

  app.post('/orgs/:orgId/documents/:id/version', { preHandler: app.verifyAuth }, async (req) => {
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
    await db.from('documents').update({ is_current_version: false }).eq('org_id', orgId).eq('version_group_id', groupId);
    const filtered = toDbDocumentFields(draft);
    const newDoc = { ...filtered, org_id: orgId, owner_user_id: userId, version_group_id: groupId, version_number: nextNum, is_current_version: true, supersedes_id: base.id };
    const { data: created, error: ierr } = await db.from('documents').insert(newDoc).select('*').single();
    if (ierr) throw ierr;
    await logAudit(app, orgId, userId, 'link', { doc_id: created.id, note: `new version of ${base.id}` });
    return mapDbToFrontendFields(created);
  });

  app.post('/orgs/:orgId/documents/:id/set-current', { preHandler: app.verifyAuth }, async (req) => {
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

  app.post('/orgs/:orgId/documents/:id/move-version', { preHandler: app.verifyAuth }, async (req) => {
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

  app.post('/orgs/:orgId/documents/:id/unlink', { preHandler: app.verifyAuth }, async (req) => {
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
    const pathStr = String((req.query?.path || ''));
    const pathArr = pathStr ? pathStr.split('/').filter(Boolean) : [];
    const { data, error } = await db.from('documents').select('folder_path').eq('org_id', orgId);
    if (error) throw error;
    const children = new Set();
    for (const row of data || []) {
      const p = row.folder_path || [];
      if (p.length >= pathArr.length + 1 && pathArr.every((seg, i) => seg === p[i])) {
        children.add(p[pathArr.length]);
      }
    }
    return Array.from(children).sort().map((name) => ({ name, fullPath: [...pathArr, name] }));
  });

  app.post('/orgs/:orgId/folders', { preHandler: app.verifyAuth }, async (req) => {
    try {
      const db = req.supabase;
      const orgId = await ensureActiveMember(req);
      const userId = req.user?.sub;
          const Schema = z.object({ parentPath: z.array(z.string()), name: z.string().min(1).max(100) });
    const { parentPath, name } = Schema.parse(req.body);
    
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
    const placeholderDoc = {
      org_id: orgId,
      owner_user_id: userId,
      title: `[Folder] ${cleanName}`,
      filename: `${cleanName}.folder`,
      type: 'folder',
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
    
    // Check if folder has subfolders by looking for folders that start with our path
    // We'll fetch all folders and check in JavaScript since PostgreSQL array operators are tricky
    const { data: allFolders, error: subError } = await db
      .from('documents')
      .select('folder_path')
      .eq('org_id', orgId)
      .not('folder_path', 'eq', toPgArray(path));
    
    // Filter for subfolders in JavaScript
    const subfolders = allFolders?.filter(doc => {
      const folderPath = doc.folder_path;
      if (!folderPath || folderPath.length <= path.length) return false;
      // Check if this folder starts with our path
      return path.every((segment, index) => folderPath[index] === segment);
    }) || [];
    
    if (subError) throw subError;
    
    if (subfolders && subfolders.length > 0) {
      const err = new Error('Cannot delete folder with subfolders');
      err.statusCode = 400;
      throw err;
    }
    
    // Separate placeholder and real documents
    const placeholder = docsInFolder?.find(d => d.type === 'folder' && d.title?.startsWith('[Folder]'));
    const realDocs = docsInFolder?.filter(d => d.type !== 'folder' || !d.title?.startsWith('[Folder]')) || [];
    
    // Handle documents based on mode
    let documentsHandled = 0;
    let storageCleanupTasks = [];
    
    if (realDocs.length > 0) {
      if (mode === 'move_to_root') {
        // Move all real documents to root folder
        const { error: moveError } = await db
          .from('documents')
          .update({ folder_path: [] })
          .eq('org_id', orgId)
          .in('id', realDocs.map(d => d.id));
          
        if (moveError) throw moveError;
        
        documentsHandled = realDocs.length;
        
        // Log document moves
        for (const doc of realDocs) {
          await logAudit(app, orgId, userId, 'move', { 
            doc_id: doc.id, 
            path: [], 
            note: `moved to root from deleted folder: ${path.join('/')}` 
          });
        }
      } else if (mode === 'delete_all') {
        // Delete all real documents including their storage
        const deletionTasks = [];
        
        for (const doc of realDocs) {
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
          const extractionKey = `${orgId}/${doc.id}`;
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
        
        documentsHandled = realDocs.length;
      }
    }
    
    // Delete the placeholder document if it exists
    if (placeholder) {
      const { error: deleteError } = await db
        .from('documents')
        .delete()
        .eq('org_id', orgId)
        .eq('id', placeholder.id);
      
      if (deleteError) throw deleteError;
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
      note: `deleted folder: ${path.join('/')} (${documentsHandled} docs ${mode === 'move_to_root' ? 'moved to root' : 'deleted'})`,
      mode: mode,
      documents_handled: documentsHandled,
      storage_cleaned: mode === 'delete_all' && realDocs.some(d => d.storage_key)
      });
    
    return { 
      deleted: true, 
      path: path.join('/'),
      mode: mode,
      documentsHandled: documentsHandled,
      storage_cleaned: mode === 'delete_all' && realDocs.some(d => d.storage_key)
    };
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

    const { data: fileBlob, error: dlErr } = await app.supabaseAdmin.storage.from('documents').download(storageKey);
    if (dlErr || !fileBlob) return reply.code(400).send({ error: 'Unable to download storage object' });

    const arr = await fileBlob.arrayBuffer();
    const b64 = Buffer.from(arr).toString('base64');
    const ct = mimeType || fileBlob.type || 'application/octet-stream';
    const dataUri = `data:${ct};base64,${b64}`;

    const ocrPrompt = ai.definePrompt({ name: 'ocrPrompt', input: { schema: z.object({ dataUri: z.string() }) }, output: { schema: z.object({ extractedText: z.string().optional() }) }, prompt: `Extract the readable text from the following document:\n\n{{media url=dataUri}}` });
    const metaPrompt = ai.definePrompt({
      name: 'metaPrompt',
      input: { schema: z.object({ dataUri: z.string() }) },
      output: {
        schema: z.object({
          summary: z.string().optional(),
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
      prompt: `Analyze the following document and return JSON metadata fields. The following are COMPULSORY and must NEVER be empty: Title, Subject, Keywords (>=3), and Tags (>=3). If not explicitly present, synthesize concise, faithful values from the visual/text content.

CATEGORY SELECTION:
For the category field, you MUST choose from this organization's predefined categories: ${availableCategories.join(', ')}
- Select the most appropriate category based on the document content and type
- If uncertain, default to "General"
- Do NOT create new categories outside this list

Sender/Receiver Handling:
- For sender: identify the primary author, issuer, or originating entity.
- For receiver: identify the primary recipient or target audience.
- CRITICAL: Scan the document equally for BOTH multiple senders AND multiple receivers. Pay equal attention to both!

Multiple SENDERS - Use senderOptions when you find:
  * Multiple "From:" fields, signatures, letterheads, or authors
  * Joint communications from multiple organizations/departments
  * Multiple officials or department heads mentioned as sources
  * Co-signers or multiple authority figures

Multiple RECEIVERS - Use receiverOptions when you find:
  * Multiple names in "To:" field or addressee lines
  * Document addressed to multiple departments/organizations
  * CC/BCC lists with multiple meaningful recipients
  * Distribution lists or broadcast communications
  * Reports for multiple stakeholders or audiences
  * Letters mentioning multiple concerned parties or addressees

- Always populate the primary sender/receiver fields with the most likely candidate.
- senderOptions/receiverOptions should contain 2+ items only when genuinely found in the document.
- Look just as hard for multiple receivers as you do for multiple senders!

{{media url=dataUri}}`,
    });

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    function isRetryable(err) {
      const msg = String(err?.message || '').toLowerCase();
      return err?.status === 429 || err?.status === 503 || msg.includes('overloaded') || msg.includes('rate') || msg.includes('unavailable');
    }

    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [{ output: ocr }, { output: meta }] = await Promise.all([
          ocrPrompt({ dataUri }),
          metaPrompt({ dataUri }),
        ]);
        // Post-process to guarantee required fields, even for images
        const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');
        const ensured = {
          title: (meta?.title || baseName),
          subject: (meta?.subject || baseName),
          keywords: Array.from(new Set(((meta?.keywords || []).filter(Boolean).slice(0,10)).concat([baseName]))).slice(0, 10),
          tags: Array.from(new Set(((meta?.tags || []).filter(Boolean).slice(0,8)).concat(['document']))).slice(0, 8),
          summary: meta?.summary || '',
          sender: meta?.sender,
          receiver: meta?.receiver,
          documentDate: meta?.documentDate,
          category: meta?.category,
        };
        return { ocrText: ocr?.extractedText || '', metadata: ensured };
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e)) break;
        await sleep(500 * (attempt + 1));
      }
    }

    // Fallback: return minimal metadata so UI can proceed; user can edit fields
    const baseName = sanitizeFilename(storageKey.split('/').pop() || 'Document');
    return reply.code(503).send({
      error: 'AI temporarily unavailable',
      fallback: {
        ocrText: '',
        metadata: {
          title: baseName,
          subject: baseName,
          keywords: [baseName],
          tags: ['document'],
          description: '',
        },
      },
    });
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
    return mapDbToFrontendFields(data);
  });

  // Save extraction (OCR text + metadata) to Storage bucket 'extractions' as JSON
  app.post('/orgs/:orgId/documents/:id/extraction', { preHandler: app.verifyAuth }, async (req, reply) => {
    const orgId = await ensureActiveMember(req);
    // Only editors/admins can write extraction artifacts
    await ensureRole(req, ['orgAdmin','contentManager']);
    const { id } = req.params;
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
  app.get('/orgs/:orgId/documents/:id/extraction', { preHandler: app.verifyAuth }, async (req, reply) => {
    const orgId = await ensureActiveMember(req);
    const { id } = req.params;
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
    // Only editors/admins can upload files
    await ensureRole(req, ['orgAdmin','contentManager']);
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
    // Only editors/admins can obtain signed upload URLs
    await ensureRole(req, ['orgAdmin','contentManager']);
    const Schema = z.object({ filename: z.string(), mimeType: z.string().optional(), contentHash: z.string().optional() });
    const body = Schema.parse(req.body);
    const key = `${orgId}/${Date.now()}-${sanitizeFilename(body.filename)}`;
    const { data, error } = await app.supabaseAdmin.storage.from('documents').createSignedUploadUrl(key);
    if (error) throw error;
    return { url: data.signedUrl, storageKey: key, path: data.path, token: data.token };
  });

  app.post('/orgs/:orgId/chat/ask', { preHandler: app.verifyAuth }, async (req, reply) => {
    await ensureActiveMember(req);
    const Schema = z.object({ question: z.string().min(1) });
    const { question } = Schema.parse(req.body);
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.sse({ event: 'start', data: JSON.stringify({ ok: true }) });
    reply.sse({ event: 'delta', data: 'Answer: ' });
    reply.sse({ event: 'delta', data: `You asked: ${question}` });
    reply.sse({ event: 'end', data: JSON.stringify({ done: true }) });
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

  // Dashboard stats - admin/manager only
  app.get('/orgs/:orgId/dashboard/stats', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const role = await getUserOrgRole(req);
    if (!role || !['orgAdmin', 'contentManager'].includes(role)) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Document stats
    const { data: docStats, error: docErr } = await db
      .from('documents')
      .select('id, file_size_bytes, type, uploaded_at, owner_user_id')
      .eq('org_id', orgId);
    if (docErr) throw docErr;

    // User stats
    const { data: userStats, error: userErr } = await db
      .from('organization_users')
      .select('user_id, role, expires_at')
      .eq('org_id', orgId);
    if (userErr) throw userErr;

    // Recent activity (last 7 days)
    const { data: recentActivity, error: activityErr } = await db
      .from('audit_events')
      .select('*')
      .eq('org_id', orgId)
      .gte('ts', sevenDaysAgo.toISOString())
      .order('ts', { ascending: false })
      .limit(10);
    if (activityErr) throw activityErr;

    // Chat sessions (last 30 days)
    const { data: chatStats, error: chatErr } = await db
      .from('chat_sessions')
      .select('id, created_at')
      .eq('org_id', orgId)
      .gte('created_at', thirtyDaysAgo.toISOString());
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
    const totalMembers = userStats?.length || 0;
    const activeMembers = (userStats || []).filter(u => !u.expires_at || new Date(u.expires_at) > now).length;
    const tempUsers = (userStats || []).filter(u => u.expires_at && new Date(u.expires_at) > now).length;
    
    const roleBreakdown = {};
    (userStats || []).forEach(user => {
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
  app.get('/orgs/:orgId/documents/:id/file', { preHandler: app.verifyAuth }, async (req, reply) => {
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
}