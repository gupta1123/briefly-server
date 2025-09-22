import { z } from 'zod';

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

async function ensureRole(req, allowedRoles) {
  const db = req.supabase;
  const orgId = requireOrg(req);
  const userId = req.user?.sub;
  
  const { data, error } = await db
    .from('organization_users')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
    
  if (error) throw error;
  if (!data || !allowedRoles.includes(data.role)) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }
  
  return data.role;
}

export function registerMetadataRoutes(app) {
  // Get metadata configuration for an organization
  app.get('/orgs/:orgId/metadata-config', { preHandler: app.verifyAuth }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensureRole(req, ['orgAdmin']);
    
    const { data, error } = await req.supabase
      .from('org_metadata_config')
      .select('*')
      .eq('org_id', orgId)
      .order('field_name');
      
    if (error) throw error;
    return data || [];
  });

  // Add new metadata field configuration
  app.post('/orgs/:orgId/metadata-config', { preHandler: app.verifyAuth }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensureRole(req, ['orgAdmin']);
    
    const Schema = z.object({
      field_name: z.string().min(1),
      field_type: z.string().min(1),
      is_searchable: z.boolean().optional().default(true),
      is_embedded: z.boolean().optional().default(true),
      weight: z.number().min(0).max(1).optional().default(1.0)
    });
    
    const body = Schema.parse(req.body);
    
    const { data, error } = await req.supabase
      .from('org_metadata_config')
      .insert({
        org_id: orgId,
        ...body
      })
      .select('*')
      .single();
      
    if (error) throw error;
    return data;
  });

  // Update metadata field configuration
  app.patch('/orgs/:orgId/metadata-config/:fieldId', { preHandler: app.verifyAuth }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensureRole(req, ['orgAdmin']);
    
    const { fieldId } = req.params;
    
    const Schema = z.object({
      field_type: z.string().min(1).optional(),
      is_searchable: z.boolean().optional(),
      is_embedded: z.boolean().optional(),
      weight: z.number().min(0).max(1).optional()
    });
    
    const body = Schema.parse(req.body);
    
    const { data, error } = await req.supabase
      .from('org_metadata_config')
      .update(body)
      .eq('org_id', orgId)
      .eq('id', fieldId)
      .select('*')
      .single();
      
    if (error) throw error;
    return data;
  });

  // Delete metadata field configuration
  app.delete('/orgs/:orgId/metadata-config/:fieldId', { preHandler: app.verifyAuth }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensureRole(req, ['orgAdmin']);
    
    const { fieldId } = req.params;
    
    const { error } = await req.supabase
      .from('org_metadata_config')
      .delete()
      .eq('org_id', orgId)
      .eq('id', fieldId);
      
    if (error) throw error;
    return { ok: true };
  });

  // Initialize default metadata config for org (admin only)
  app.post('/orgs/:orgId/metadata-config/initialize', { preHandler: app.verifyAuth }, async (req) => {
    const orgId = await ensureActiveMember(req);
    await ensureRole(req, ['orgAdmin']);
    
    // Import the initialization function
    const { initializeOrgMetadataConfig } = await import('../lib/metadata-embeddings.js');
    
    await initializeOrgMetadataConfig(req.supabase, orgId);
    return { ok: true };
  });
}