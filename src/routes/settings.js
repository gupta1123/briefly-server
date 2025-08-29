// Settings Routes - User and Organization Settings Management
// Handles both user preferences and organization-wide settings

import { z } from 'zod';

function requireOrg(req) {
  const orgId = req.headers['x-org-id'] || req.params?.orgId;
  if (!orgId) {
    const err = new Error('Missing org id');
    err.statusCode = 400;
    throw err;
  }
  return orgId;
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
    const err = new Error('Not a member of this organization');
    err.statusCode = 403;
    throw err;
  }
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    const err = new Error('Membership expired');
    err.statusCode = 403;
    throw err;
  }
  return orgId;
}

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

async function ensurePerm(req, permKey) {
  const orgId = requireOrg(req);
  const perms = await getMyPermissions(req, orgId);
  if (!perms || perms[permKey] !== true) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
  return true;
}

export function registerSettingsRoutes(app) {
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
    // Require permission to update org settings
    await ensurePerm(req, 'org.update_settings');

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
}
