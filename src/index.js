import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sse from 'fastify-sse-v2';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import { createClient } from '@supabase/supabase-js';
import { loadEnv } from './env.js';
import { registerRoutes } from './routes.js';
import { registerSimpleOrgsRoute } from './routes/simple-orgs.js';
import { registerSimpleOrgsTestRoute } from './routes/test-simple-orgs.js';
import { registerSimplifiedOpsRoutes } from './routes/simple-ops.js';
import { ipValidationPlugin } from './ip-validation.js';

async function main() {
  const env = loadEnv();
  const app = Fastify({ logger: true });

  await app.register(cors, { 
    origin: [
      'https://brieflydocs.netlify.app',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:9002'
    ], 
    credentials: true 
  });
  await app.register(sse);
  await app.register(jwt, { secret: env.SUPABASE_JWT_SECRET });
  await app.register(multipart);
  // Register IP validation plugin
  await app.register(ipValidationPlugin);

  // Platform admin guard for Ops Console
  app.decorate('ensurePlatformAdmin', async (request, reply) => {
    const enableOps = (process.env.ENABLE_OPS || 'true').toLowerCase() !== 'false';
    if (!enableOps) return reply.code(403).send({ error: 'Ops disabled' });
    const list = String(process.env.OPS_PLATFORM_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const uid = request.user?.sub;
    if (!uid || (list.length > 0 && !list.includes(uid))) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  });

  // Service-role client for privileged server-side ops (e.g., storage uploads)
  const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  app.decorate('supabaseAdmin', supabaseAdmin);

  // Auth pre-handler: verify JWT and create a request-scoped Supabase client that enforces RLS
  app.decorate('verifyAuth', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization || '';
      const token = authHeader.replace(/^Bearer\s+/i, '');

      if (token) {
        const payload = await app.jwt.verify(token);
        request.user = payload;
        // Create RLS-enforced client for this request
        request.supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
          auth: { persistSession: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        return;
      }

      return reply.code(401).send({ error: 'Unauthorized' });
    } catch (e) {
      request.log.error(e, 'Auth check failed');
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerRoutes(app);

  // Orchestrator removed; agno-service handles agent orchestration

  // Register simple orgs route
  registerSimpleOrgsRoute(app);
  registerSimpleOrgsTestRoute(app);
  registerSimplifiedOpsRoutes(app);

  // Central error handler: audit 5xx incidents
  app.setErrorHandler(async (error, request, reply) => {
    try {
      const status = error?.statusCode || 500;
      if (status >= 500) {
        const orgId = request.headers['x-org-id'] || request.params?.orgId || null;
        try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: request.user?.sub || null, type: 'server.5xx', note: error.message?.slice(0, 250) || 'server error' }); } catch {}
      }
    } catch {}
    reply.send(error);
  });

  // --- Ops routes (minimal MVP) ---
  app.get('/ops/whoami', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const uid = req.user?.sub;
    const ip = app.getClientIp ? app.getClientIp(req) : req.ip;
    const admins = String(process.env.OPS_PLATFORM_ADMINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
      userId: uid,
      ip,
      enableOps: (process.env.ENABLE_OPS || 'true').toLowerCase() !== 'false',
      platformAdmin: admins.length === 0 ? true : admins.includes(uid),
    };
  });

  app.get('/ops/orgs', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    // Orgs
    const { data: orgs, error } = await admin.from('organizations').select('id, name');
    if (error) throw error;
    const rows = [];
    for (const org of orgs || []) {
      const [depts, users, docs, overrides] = await Promise.all([
        admin.from('departments').select('id', { count: 'exact', head: true }).eq('org_id', org.id),
        admin.from('organization_users').select('user_id', { count: 'exact', head: true }).eq('org_id', org.id),
        admin.from('documents').select('id', { count: 'exact', head: true }).eq('org_id', org.id),
        admin.from('user_access_overrides').select('user_id', { count: 'exact', head: true }).eq('org_id', org.id),
      ]);
      rows.push({
        orgId: org.id,
        name: org.name,
        teams: depts.count || 0,
        users: users.count || 0,
        documents: docs.count || 0,
        overrides: overrides.count || 0,
      });
    }
    return rows;
  });

  // Ops overview: KPIs and recent events across all orgs
  app.get('/ops/overview', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [orgs, docs, orgUsers, opsEvents, recent, loginEv, ingestErr, docsSince] = await Promise.all([
      admin.from('organizations').select('id', { count: 'exact', head: true }),
      admin.from('documents').select('id', { count: 'exact', head: true }).neq('type', 'folder'),
      admin.from('organization_users').select('user_id', { count: 'exact', head: true }),
      admin.from('audit_events').select('id, org_id, actor_user_id, type, ts, note').ilike('type', 'ops.%').order('ts', { ascending: false }).limit(10),
      admin.from('audit_events').select('id, org_id, actor_user_id, type, ts, note').order('ts', { ascending: false }).limit(10),
      admin.from('audit_events').select('type, ts').eq('type','login').gte('ts', since30).limit(5000),
      admin.from('audit_events').select('type, ts').eq('type','ingest.error').gte('ts', since30).limit(5000),
      admin.from('documents').select('uploaded_at').gte('uploaded_at', since30).neq('type','folder').limit(5000),
    ]);
    // Bucket by day for last 30 days
    function bucket(dates, key) {
      const map = new Map();
      for (let i = 0; i < 30; i++) {
        const dt = new Date(); dt.setHours(0,0,0,0); dt.setDate(dt.getDate() - (29 - i));
        map.set(dt.toISOString().slice(0,10), { date: dt.toISOString().slice(0,10), count: 0 });
      }
      for (const r of dates || []) {
        const iso = new Date(r[key]).toISOString().slice(0,10);
        if (map.has(iso)) map.get(iso).count++;
      }
      return Array.from(map.values());
    }
    const logins30 = bucket(loginEv.data || [], 'ts');
    const uploads30 = bucket(docsSince.data || [], 'uploaded_at');
    const failures30 = bucket(ingestErr.data || [], 'ts');
    const trends30 = logins30.map((row, idx) => ({ date: row.date, logins: row.count, uploads: uploads30[idx].count, failures: failures30[idx].count }));
    const trends7 = trends30.slice(-7);
    return {
      totals: {
        orgs: orgs.count || 0,
        documents: docs.count || 0,
        orgUsers: orgUsers.count || 0,
      },
      recentOps: opsEvents.data || [],
      recentActivity: recent.data || [],
      trends7,
      trends30,
    };
  });

  // Incidents listing with filters: orgId, type, since(days)
  app.get('/ops/incidents', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    const q = req.query || {};
    const orgId = typeof q.orgId === 'string' ? q.orgId : undefined;
    const type = typeof q.type === 'string' ? q.type : 'all';
    const days = Number(q.since || '7');
    const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    let qb = admin.from('audit_events').select('*').gte('ts', sinceIso).order('ts', { ascending: false }).limit(200);
    if (orgId) qb = qb.eq('org_id', orgId);
    if (type && type !== 'all') qb = qb.eq('type', type);
    const { data, error } = await qb;
    if (error) throw error;
    // Map IP blocked events that were logged as note on login
    const list = (data || []).map((e) => {
      if (e.type === 'login' && String(e.note || '').startsWith('IP blocked')) return { ...e, type: 'ip.blocked' };
      return e;
    }).filter((e) => (type === 'all' ? true : e.type === type));
    return list;
  });

  // Retry ingestion for a document (ops)
  app.post('/ops/incidents/retry-ingest', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId, docId } = req.body || {};
    if (!orgId || !docId) { const e = new Error('orgId and docId required'); e.statusCode = 400; throw e; }
    // Reuse existing route via internal inject
    const res = await app.inject({ method: 'POST', url: `/orgs/${orgId}/documents/${docId}/reingest`, headers: { authorization: req.headers.authorization || '' , 'x-org-id': orgId } });
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'ops.reingest', doc_id: docId }); } catch {}
    return { ok: res.statusCode < 400 };
  });

  // Invite or add user by email to org (and optional team)
  app.post('/ops/orgs/:orgId/users/invite', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const { email, role = 'member', departmentId, deptRole = 'member', password } = req.body || {};
    if (typeof email !== 'string' || !email.includes('@')) { const e = new Error('valid email required'); e.statusCode = 400; throw e; }
    
    // Validate password if provided
    if (password && (typeof password !== 'string' || password.length < 6)) {
      const e = new Error('password must be at least 6 characters'); e.statusCode = 400; throw e;
    }
    let userId = null;
    let userWasCreated = false;
    
    if (password && typeof password === 'string' && password.length >= 6) {
      // Create user with provided password (no email invitation)
      try {
        const { data } = await app.supabaseAdmin.auth.admin.createUser({
          email,
          password,
          email_confirm: true
        });
        userId = data?.user?.id || null;
        userWasCreated = true;
      } catch (createError) {
        // If user already exists, try to find and update password
        try { 
          const { data: list } = await app.supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 }); 
          const found = (list?.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase()); 
          if (found) {
            userId = found?.id || null;
            // Update existing user with new password
            await app.supabaseAdmin.auth.admin.updateUserById(userId, { password, email_confirm: true });
            userWasCreated = true;
          }
        } catch (findError) {
          console.error('Failed to find/update existing user:', findError);
          throw createError; // Re-throw original create error
        }
      }
    } else {
      // Use email invitation flow
      try {
        const { data } = await app.supabaseAdmin.auth.admin.inviteUserByEmail(email);
        userId = data?.user?.id || null;
      } catch (inviteError) {
        // Fallback to creating user without password (they'll need to reset)
        try { 
          const { data } = await app.supabaseAdmin.auth.admin.createUser({ 
            email, 
            email_confirm: false 
          }); 
          userId = data?.user?.id || null; 
        } catch (createError) {
          console.error('Both invite and create failed:', { inviteError, createError });
          throw inviteError; // Re-throw invite error as primary
        }
      }
    }
    
    if (!userId) { const e = new Error('Failed to create/invite user'); e.statusCode = 500; throw e; }
    
    // Upsert org membership
    await app.supabaseAdmin.from('organization_users').upsert({ org_id: orgId, user_id: userId, role }, { onConflict: 'org_id,user_id' });
    
    // Optional team membership
    if (departmentId) {
      await app.supabaseAdmin.from('department_users').upsert({ org_id: orgId, department_id: departmentId, user_id: userId, role: deptRole === 'lead' ? 'lead' : 'member' }, { onConflict: 'department_id,user_id' });
      if (deptRole === 'lead') {
        await app.supabaseAdmin.from('departments').update({ lead_user_id: userId }).eq('org_id', orgId).eq('id', departmentId);
      }
    }
    
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'ops.invite_user', note: `${email} role=${role} dept=${departmentId || ''}${userWasCreated ? ' (created_with_password)' : ''}` }); } catch {}
    return { ok: true, userId, userWasCreated };
  });

  // Create team (department) with optional leadEmail
  app.post('/ops/orgs/:orgId/teams', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const { name, leadEmail } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2) { const e = new Error('name required (min 2 chars)'); e.statusCode = 400; throw e; }
    const { data: dept, error } = await app.supabaseAdmin.from('departments').insert({ org_id: orgId, name: name.trim() }).select('id').single();
    if (error) throw error;
    if (leadEmail && typeof leadEmail === 'string') {
      let uid = null; try { const { data } = await app.supabaseAdmin.auth.admin.inviteUserByEmail(leadEmail); uid = data?.user?.id || null; } catch {}
      if (!uid) { try { const { data } = await app.supabaseAdmin.auth.admin.createUser({ email: leadEmail, email_confirm: false }); uid = data?.user?.id || null; } catch {} }
      if (uid) {
        await app.supabaseAdmin.from('organization_users').upsert({ org_id: orgId, user_id: uid, role: 'teamLead' }, { onConflict: 'org_id,user_id' });
        await app.supabaseAdmin.from('department_users').upsert({ org_id: orgId, department_id: dept.id, user_id: uid, role: 'lead' }, { onConflict: 'department_id,user_id' });
        await app.supabaseAdmin.from('departments').update({ lead_user_id: uid }).eq('org_id', orgId).eq('id', dept.id);
      }
    }
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'ops.create_team', note: `${name}` }); } catch {}
    return { ok: true, departmentId: dept.id };
  });

  app.get('/ops/orgs/:orgId', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    const { orgId } = req.params;
    const diagnostics = [];

    const expectedRoles = ['orgAdmin','contentManager','teamLead','member','contentViewer'];
    const { data: roles, error: rolesErr } = await admin.from('org_roles').select('key, permissions').eq('org_id', orgId);
    if (rolesErr) throw rolesErr;
    const roleKeys = new Set((roles || []).map(r => r.key));
    const missing = expectedRoles.filter(k => !roleKeys.has(k));
    if (missing.length > 0) diagnostics.push({ id: 'missing_roles', severity: 'error', title: 'Missing role rows', details: { missing } });

    // Role drift checks (teamLead/member must have documents.*)
    const needsTrue = ['documents.read','documents.create','documents.update','documents.delete'];
    const drift = [];
    for (const key of ['teamLead','member']) {
      const r = (roles || []).find(x => x.key === key);
      if (!r) continue;
      const bad = needsTrue.filter(p => r.permissions?.[p] !== true);
      if (bad.length) drift.push({ role: key, missing: bad });
    }
    if (drift.length) diagnostics.push({ id: 'role_drift', severity: 'warn', title: 'Role permission drift', details: { drift } });

    // Core team presence and orgAdmins as leads
    const { data: coreRows, error: coreErr } = await admin.from('departments').select('id').eq('org_id', orgId).eq('name', 'Core').limit(1);
    if (coreErr) throw coreErr;
    const core = (coreRows || [])[0];
    if (!core) diagnostics.push({ id: 'core_missing', severity: 'warn', title: 'Core team missing' });
    else {
      const { data: admins, error: adminsErr } = await admin.from('organization_users').select('user_id').eq('org_id', orgId).eq('role', 'orgAdmin');
      if (adminsErr) throw adminsErr;
      const { data: leads, error: leadsErr } = await admin.from('department_users').select('user_id, role').eq('org_id', orgId).eq('department_id', core.id);
      if (leadsErr) throw leadsErr;
      const leadSet = new Set((leads || []).filter(r => r.role === 'lead').map(r => r.user_id));
      const missingLeads = (admins || []).map(a => a.user_id).filter(uid => !leadSet.has(uid));
      if (missingLeads.length) diagnostics.push({ id: 'core_leads', severity: 'info', title: 'OrgAdmins not Core leads', details: { missingLeads } });
    }

    // Membership inconsistencies
    const { data: du, error: duErr } = await admin.from('department_users').select('user_id, department_id').eq('org_id', orgId);
    if (duErr) throw duErr;
    const { data: ou, error: ouErr } = await admin.from('organization_users').select('user_id, role, expires_at').eq('org_id', orgId);
    if (ouErr) throw ouErr;
    const ouSet = new Set((ou || []).map(r => r.user_id));
    const orphanedDeptUsers = (du || []).filter(r => !ouSet.has(r.user_id));
    if (orphanedDeptUsers.length) diagnostics.push({ id: 'membership_inconsistency', severity: 'warn', title: 'Dept members without org membership', details: { count: orphanedDeptUsers.length } });

    // Policy alignment snapshot
    diagnostics.push({ id: 'policy_snapshot', severity: 'info', title: 'Policy alignment requires manual check', details: { table: 'documents' } });

    // Basic counts
    const [depts, users, docs, overrides] = await Promise.all([
      admin.from('departments').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
      admin.from('organization_users').select('user_id', { count: 'exact', head: true }).eq('org_id', orgId),
      admin.from('documents').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
      admin.from('user_access_overrides').select('user_id', { count: 'exact', head: true }).eq('org_id', orgId),
    ]);

    return {
      orgId,
      summary: { teams: depts.count || 0, users: users.count || 0, documents: docs.count || 0, overrides: overrides.count || 0 },
      diagnostics,
    };
  });

  // Fix: seed default roles for org
  app.post('/ops/fix/:orgId/seed-roles', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    const { orgId } = req.params;
    const { getCompleteRolePermissions } = await import('./lib/permission-helpers.js');
    const defaults = [
      { key: 'orgAdmin', name: 'Organization Admin', is_system: true, permissions: getCompleteRolePermissions({
        'org.manage_members': true, 'org.update_settings': true, 'security.ip_bypass': true,
        'documents.read': true, 'documents.create': true, 'documents.update': true, 'documents.delete': true,
        'documents.move': true, 'documents.link': true, 'documents.version.manage': true, 'documents.bulk_delete': true,
        'storage.upload': true, 'search.semantic': true, 'chat.save_sessions': true, 'audit.read': true,
      }) },
      { key: 'contentManager', name: 'Content Manager', is_system: true, permissions: getCompleteRolePermissions({
        'org.manage_members': false, 'org.update_settings': false, 'security.ip_bypass': false,
        'documents.read': true, 'documents.create': true, 'documents.update': true, 'documents.delete': true,
        'documents.move': true, 'documents.link': true, 'documents.version.manage': true, 'documents.bulk_delete': true,
        'storage.upload': true, 'search.semantic': true, 'chat.save_sessions': true, 'audit.read': true,
      }) },
      { key: 'teamLead', name: 'Team Lead', is_system: true, permissions: getCompleteRolePermissions({
        'org.manage_members': false, 'org.update_settings': false, 'security.ip_bypass': false,
        'documents.read': true, 'documents.create': true, 'documents.update': true, 'documents.delete': true,
        'documents.move': true, 'documents.link': true, 'documents.version.manage': true, 'documents.bulk_delete': false,
        'storage.upload': true, 'search.semantic': true, 'chat.save_sessions': false, 'audit.read': true,
        'departments.read': true, 'departments.manage_members': true,
      }) },
      { key: 'member', name: 'Member', is_system: true, permissions: getCompleteRolePermissions({
        'org.manage_members': false, 'org.update_settings': false, 'security.ip_bypass': false,
        'documents.read': true, 'documents.create': true, 'documents.update': true, 'documents.delete': true,
        'documents.move': true, 'documents.link': true, 'documents.version.manage': true, 'documents.bulk_delete': false,
        'storage.upload': true, 'search.semantic': true, 'chat.save_sessions': false, 'audit.read': false,
      }) },
      { key: 'contentViewer', name: 'Content Viewer', is_system: true, permissions: getCompleteRolePermissions({
        'org.manage_members': false, 'org.update_settings': false, 'security.ip_bypass': false,
        'documents.read': true, 'documents.create': false, 'documents.update': false, 'documents.delete': false,
        'documents.move': false, 'documents.link': false, 'documents.version.manage': false, 'documents.bulk_delete': false,
        'storage.upload': false, 'search.semantic': true, 'chat.save_sessions': false, 'audit.read': true,
      }) },
    ];
    const rows = defaults.map((r) => ({ org_id: orgId, key: r.key, name: r.name, is_system: r.is_system, permissions: r.permissions }));
    const { error } = await admin.from('org_roles').upsert(rows, { onConflict: 'org_id,key' });
    if (error) throw error;
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ops.seed_roles', note: 'seeded roles' }); } catch {}
    return { ok: true };
  });

  // Fix: ensure Core team exists and orgAdmins are leads
  app.post('/ops/fix/:orgId/core-team', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    const { orgId } = req.params;
    const { data: core } = await admin.from('departments').select('id').eq('org_id', orgId).eq('name', 'Core').maybeSingle();
    let coreId = core?.id;
    if (!coreId) {
      const { data: created, error } = await admin.from('departments').insert({ org_id: orgId, name: 'Core' }).select('id').single();
      if (error) throw error;
      coreId = created.id;
    }
    const { data: admins } = await admin.from('organization_users').select('user_id').eq('org_id', orgId).eq('role', 'orgAdmin');
    const upserts = (admins || []).map(a => ({ org_id: orgId, department_id: coreId, user_id: a.user_id, role: 'lead' }));
    if (upserts.length) {
      const { error } = await admin.from('department_users').upsert(upserts, { onConflict: 'department_id,user_id' });
      if (error) throw error;
    }
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ops.ensure_core', note: 'ensured core team and leads' }); } catch {}
    return { ok: true, coreId };
  });

  // --- Additional Ops endpoints ---

  // Create organization (seed roles + Core); enroll caller as orgAdmin
  app.post('/ops/orgs', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    const { name } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 2) {
      const e = new Error('name required (min 2 chars)');
      e.statusCode = 400; throw e;
    }
    const { data: org, error: oerr } = await admin.from('organizations').insert({ name: name.trim() }).select('id, name').single();
    if (oerr) throw oerr;
    // Seed roles
    await app.inject({ method: 'POST', url: `/ops/fix/${org.id}/seed-roles`, headers: req.headers });
    // Ensure Core
    await app.inject({ method: 'POST', url: `/ops/fix/${org.id}/core-team`, headers: req.headers });
    // Enroll caller as orgAdmin
    const uid = req.user?.sub;
    if (uid) await admin.from('organization_users').upsert({ org_id: org.id, user_id: uid, role: 'orgAdmin' }, { onConflict: 'org_id,user_id' });
    try { await admin.from('audit_events').insert({ org_id: org.id, actor_user_id: uid, type: 'ops.create_org', note: name }); } catch {}
    return org;
  });

  // List teams for org
  app.get('/ops/orgs/:orgId/teams', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const admin = app.supabaseAdmin;
    const { orgId } = req.params;
    const { data: depts, error } = await admin.from('departments').select('id, name, lead_user_id').eq('org_id', orgId);
    if (error) throw error;
    const ids = (depts || []).map(d => d.id);
    const { data: counts } = await admin.from('department_users').select('department_id', { count: 'exact', head: true }).in('department_id', ids);
    // supabase head+count returns count in response meta; we fallback per dept query when needed
    const out = [];
    for (const d of depts || []) {
      const { count } = await admin.from('department_users').select('user_id', { count: 'exact', head: true }).eq('department_id', d.id);
      out.push({ id: d.id, name: d.name, leadUserId: d.lead_user_id, members: count || 0 });
    }
    return out;
  });

  // Add org admin (by userId)
  app.post('/ops/orgs/:orgId/admins', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const { userId } = req.body || {};
    if (!userId || typeof userId !== 'string') { const e = new Error('userId required'); e.statusCode = 400; throw e; }
    const { error } = await app.supabaseAdmin
      .from('organization_users')
      .upsert({ org_id: orgId, user_id: userId, role: 'orgAdmin' }, { onConflict: 'org_id,user_id' });
    if (error) throw error;
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'ops.add_admin', note: userId }); } catch {}
    return { ok: true };
  });

  // Add team lead to department (by userId) and set org role to teamLead
  app.post('/ops/orgs/:orgId/teams/:deptId/leads', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId, deptId } = req.params;
    const { userId } = req.body || {};
    if (!userId || typeof userId !== 'string') { const e = new Error('userId required'); e.statusCode = 400; throw e; }
    // Ensure org membership with teamLead role
    await app.supabaseAdmin
      .from('organization_users')
      .upsert({ org_id: orgId, user_id: userId, role: 'teamLead' }, { onConflict: 'org_id,user_id' });
    // Upsert department lead membership
    await app.supabaseAdmin
      .from('department_users')
      .upsert({ org_id: orgId, department_id: deptId, user_id: userId, role: 'lead' }, { onConflict: 'department_id,user_id' });
    // Set department.lead_user_id
    await app.supabaseAdmin
      .from('departments')
      .update({ lead_user_id: userId })
      .eq('org_id', orgId)
      .eq('id', deptId);
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, actor_user_id: req.user?.sub, type: 'ops.add_team_lead', note: `${deptId}:${userId}` }); } catch {}
    return { ok: true };
  });

  // View roles for org
  app.get('/ops/orgs/:orgId/roles', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const { data, error } = await app.supabaseAdmin.from('org_roles').select('key, name, is_system, permissions').eq('org_id', orgId);
    if (error) throw error;
    return data || [];
  });

  // Update role permissions for org
  app.put('/ops/orgs/:orgId/roles/:key', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId, key } = req.params;
    const { permissions, name } = req.body || {};
    if (permissions && typeof permissions !== 'object') { const e = new Error('permissions must be object'); e.statusCode = 400; throw e; }
    const payload = {};
    if (name && typeof name === 'string') payload.name = name;
    if (permissions) payload.permissions = permissions;
    const { data, error } = await app.supabaseAdmin
      .from('org_roles')
      .update(payload)
      .eq('org_id', orgId)
      .eq('key', key)
      .select('key, name, is_system, permissions')
      .single();
    if (error) throw error;
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ops.update_role', note: key }); } catch {}
    return data;
  });

  // Effective permissions for a user (role + overrides merge)
  app.get('/ops/orgs/:orgId/effective/:userId', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId, userId } = req.params;
    const db = app.supabaseAdmin;
    const { data: membership } = await db.from('organization_users').select('role, expires_at').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
    const roleKey = membership?.role || null;
    let rolePerms = {};
    if (roleKey) {
      const { data: roleRow } = await db.from('org_roles').select('permissions').eq('org_id', orgId).eq('key', roleKey).maybeSingle();
      rolePerms = roleRow?.permissions || {};
    }
    const { data: orgOverrideRow } = await db.from('user_access_overrides').select('permissions').eq('org_id', orgId).eq('user_id', userId).is('department_id', null).maybeSingle();
    const orgOverride = orgOverrideRow?.permissions || {};
    const keys = new Set([ ...Object.keys(rolePerms), ...Object.keys(orgOverride) ]);
    const effective = {};
    for (const k of keys) effective[k] = Object.prototype.hasOwnProperty.call(orgOverride, k) ? !!orgOverride[k] : !!rolePerms[k];
    return { role: roleKey, rolePermissions: rolePerms, orgOverride, effective };
  });

  // Fix role drift: ensure teamLead/member have required doc perms
  app.post('/ops/fix/:orgId/role-drift', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const needTrue = ['documents.read','documents.create','documents.update','documents.delete','documents.version.manage','documents.move','documents.link','storage.upload','search.semantic'];
    const { data: roles } = await app.supabaseAdmin.from('org_roles').select('key, permissions').eq('org_id', orgId).in('key', ['teamLead','member']);
    const updates = [];
    for (const r of roles || []) {
      const perms = { ...(r.permissions || {}) };
      for (const k of needTrue) perms[k] = true;
      if (r.key === 'member') perms['documents.bulk_delete'] = false;
      updates.push({ org_id: orgId, key: r.key, permissions: perms });
    }
    if (updates.length) {
      const { error } = await app.supabaseAdmin.from('org_roles').upsert(updates, { onConflict: 'org_id,key' });
      if (error) throw error;
    }
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ops.fix_role_drift' }); } catch {}
    return { ok: true };
  });

  // Fix membership inconsistencies: create missing org membership for dept users (role=member)
  app.post('/ops/fix/:orgId/membership', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const admin = app.supabaseAdmin;
    const { data: du } = await admin.from('department_users').select('user_id').eq('org_id', orgId);
    const { data: ou } = await admin.from('organization_users').select('user_id').eq('org_id', orgId);
    const present = new Set((ou || []).map(r => r.user_id));
    const missing = Array.from(new Set((du || []).map(r => r.user_id))).filter(uid => !present.has(uid));
    if (missing.length) {
      const rows = missing.map(uid => ({ org_id: orgId, user_id: uid, role: 'member' }));
      const { error } = await admin.from('organization_users').upsert(rows, { onConflict: 'org_id,user_id' });
      if (error) throw error;
    }
    try { await admin.from('audit_events').insert({ org_id: orgId, type: 'ops.fix_membership', note: `${(missing || []).length} added` }); } catch {}
    return { ok: true, added: missing.length };
  });

  // Policy alignment SQL preview (membership-first model + admin bypass)
  app.get('/ops/fix/:orgId/policies/sql', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    // Provide a safe SQL script the operator can paste into SQL editor
    const sql = `-- Align documents policies to membership-first model (admin bypass + team membership)
-- INSERT: recreate policy
DROP POLICY IF EXISTS documents_create_perm ON public.documents;
CREATE POLICY documents_create_perm ON public.documents
FOR INSERT
WITH CHECK (
  (auth.uid() IS NOT NULL)
  AND is_member_of(org_id)
  AND (
    has_perm(org_id, 'org.manage_members')
    OR ((department_id IS NOT NULL) AND is_dept_member(org_id, department_id))
  )
);

-- UPDATE: enforce for existing rows (USING) and new values (WITH CHECK)
ALTER POLICY documents_update_perm ON public.documents
USING (
  (auth.uid() IS NOT NULL)
  AND is_member_of(org_id)
  AND (deleted_at IS NULL)
  AND (
    has_perm(org_id, 'org.manage_members')
    OR ((department_id IS NOT NULL) AND is_dept_member(org_id, department_id))
    OR EXISTS (
      SELECT 1 FROM folder_access fa
      WHERE fa.org_id = documents.org_id
        AND is_path_prefix(documents.folder_path, fa.path)
        AND is_dept_member(documents.org_id, fa.department_id)
    )
  )
)
WITH CHECK (
  (auth.uid() IS NOT NULL)
  AND is_member_of(org_id)
  AND (deleted_at IS NULL)
  AND (
    has_perm(org_id, 'org.manage_members')
    OR ((department_id IS NOT NULL) AND is_dept_member(org_id, department_id))
    OR EXISTS (
      SELECT 1 FROM folder_access fa
      WHERE fa.org_id = documents.org_id
        AND is_path_prefix(documents.folder_path, fa.path)
        AND is_dept_member(documents.org_id, fa.department_id)
    )
  )
);

-- DELETE: enforce membership or admin bypass
ALTER POLICY documents_delete_perm ON public.documents
USING (
  (auth.uid() IS NOT NULL)
  AND is_member_of(org_id)
  AND (
    has_perm(org_id, 'org.manage_members')
    OR ((department_id IS NOT NULL) AND is_dept_member(org_id, department_id))
    OR EXISTS (
      SELECT 1 FROM folder_access fa
      WHERE fa.org_id = documents.org_id
        AND is_path_prefix(documents.folder_path, fa.path)
        AND is_dept_member(documents.org_id, fa.department_id)
    )
  )
);

-- Note: Run in SQL editor with appropriate privileges. This is idempotent and safe.`;
    try { await app.supabaseAdmin.from('audit_events').insert({ org_id: orgId, type: 'ops.policy_sql.preview' }); } catch {}
    return { sql };
  });

  // Apply policy alignment (requires align_documents_policies() to be installed)
  app.post('/ops/fix/:orgId/policies/apply', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    // Optional guard via env if you want to limit DDL from API
    const allowed = (process.env.OPs_ALLOW_DDL || process.env.OPS_ALLOW_DDL || 'false').toLowerCase() === 'true';
    if (!allowed) {
      const e = new Error('DDL not allowed via API. Use SQL preview and run in SQL editor, or set OPS_ALLOW_DDL=true.');
      e.statusCode = 400; throw e;
    }
    // Execute via RPC
    const { data, error } = await app.supabaseAdmin.rpc('align_documents_policies');
    if (error) throw error;
    try { await app.supabaseAdmin.from('audit_events').insert({ type: 'ops.policy.apply', actor_user_id: req.user?.sub }); } catch {}
    return { ok: true, result: data };
  });

  // List overrides for org (org-wide and dept-specific)
  app.get('/ops/orgs/:orgId/overrides', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const { data, error } = await app.supabaseAdmin
      .from('user_access_overrides')
      .select('user_id, department_id, permissions')
      .eq('org_id', orgId);
    if (error) throw error;
    return data || [];
  });

  // List users for an org with department memberships
  app.get('/ops/orgs/:orgId/users', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const admin = app.supabaseAdmin;
    const { data: users, error } = await admin
      .from('organization_users')
      .select('user_id, role, expires_at')
      .eq('org_id', orgId);
    if (error) throw error;
    const uids = Array.from(new Set((users || []).map(u => u.user_id)));
    const [{ data: du }, { data: profiles }] = await Promise.all([
      admin.from('department_users').select('user_id, department_id, role').eq('org_id', orgId).in('user_id', uids),
      admin.from('app_users').select('id, display_name').in('id', uids)
    ]);
    const nameMap = new Map((profiles || []).map(p => [p.id, p.display_name]));
    const deptMap = new Map(); // user_id -> deptIds
    for (const r of du || []) {
      if (!deptMap.has(r.user_id)) deptMap.set(r.user_id, []);
      deptMap.get(r.user_id).push({ departmentId: r.department_id, role: r.role });
    }
    return (users || []).map(u => ({
      userId: u.user_id,
      role: u.role,
      displayName: nameMap.get(u.user_id) || null,
      expiresAt: u.expires_at,
      departments: deptMap.get(u.user_id) || []
    }));
  });

  // Reset a user's password (Supabase Admin)
  app.post('/ops/users/:userId/password', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { userId } = req.params;
    const { newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      const e = new Error('newPassword must be at least 8 characters'); e.statusCode = 400; throw e;
    }
    await app.supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
    try { await app.supabaseAdmin.from('audit_events').insert({ type: 'ops.reset_password', actor_user_id: req.user?.sub, note: userId }); } catch {}
    return { ok: true };
  });

  // Update user password within org (for team management)
  app.patch('/ops/orgs/:orgId/users/:userId', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId, userId } = req.params;
    const { password } = req.body || {};
    
    // Validate password
    if (typeof password !== 'string' || password.length < 6) {
      const e = new Error('password must be at least 6 characters'); e.statusCode = 400; throw e;
    }
    
    // Ensure user is member of this org
    const { data: membership } = await app.supabaseAdmin
      .from('organization_users')
      .select('user_id')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();
    
    if (!membership) {
      const e = new Error('User is not a member of this organization'); e.statusCode = 404; throw e;
    }
    
    // Update user's password
    await app.supabaseAdmin.auth.admin.updateUserById(userId, { password, email_confirm: true });
    
    try { 
      await app.supabaseAdmin.from('audit_events').insert({ 
        org_id: orgId, 
        type: 'ops.update_user_password', 
        actor_user_id: req.user?.sub, 
        note: userId 
      }); 
    } catch {}
    
    return { ok: true };
  });

  // RLS simulate: evaluate membership + effective perms for action
  app.get('/ops/orgs/:orgId/rls-simulate', { preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] }, async (req) => {
    const { orgId } = req.params;
    const { userId, action = 'create', departmentId } = req.query || {};
    if (!userId || typeof userId !== 'string') { const e = new Error('userId required'); e.statusCode = 400; throw e; }
    const admin = app.supabaseAdmin;
    // membership
    const { data: mem } = await admin.from('organization_users').select('role, expires_at').eq('org_id', orgId).eq('user_id', userId).maybeSingle();
    const isMember = !!mem && (!mem.expires_at || new Date(mem.expires_at).getTime() > Date.now());
    // dept membership
    let isDeptMember = null;
    if (departmentId) {
      const { data: du } = await admin.from('department_users').select('user_id').eq('org_id', orgId).eq('user_id', userId).eq('department_id', departmentId).maybeSingle();
      isDeptMember = !!du;
    }
    // effective perms
    let rolePerms = {};
    if (mem?.role) {
      const { data: roleRow } = await admin.from('org_roles').select('permissions').eq('org_id', orgId).eq('key', mem.role).maybeSingle();
      rolePerms = roleRow?.permissions || {};
    }
    const { data: orgOverrideRow } = await admin.from('user_access_overrides').select('permissions').eq('org_id', orgId).eq('user_id', userId).is('department_id', null).maybeSingle();
    const orgOverride = orgOverrideRow?.permissions || {};
    const keys = new Set([ ...Object.keys(rolePerms), ...Object.keys(orgOverride) ]);
    const effective = {};
    for (const k of keys) effective[k] = Object.prototype.hasOwnProperty.call(orgOverride, k) ? !!orgOverride[k] : !!rolePerms[k];
    const needKey = action === 'create' ? 'documents.create' : action === 'update' ? 'documents.update' : action === 'delete' ? 'documents.delete' : 'documents.read';
    const hasPerm = !!effective[needKey];
    return { isMember, isDeptMember, role: mem?.role || null, needKey, hasPerm, effective };
  });

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  // --- Scheduled purge of expired trashed documents (daily) ---
  const PURGE_ENABLED = (process.env.PURGE_ENABLED || 'true').toLowerCase() !== 'false';
  const PURGE_UTC_HOUR = Number(process.env.PURGE_UTC_HOUR || '3'); // default 03:00 UTC

  async function purgeExpiredOnce() {
    try {
      const nowIso = new Date().toISOString();
      app.log.info({ nowIso }, 'Recycle purge: scan start');
      const { data: victims, error } = await app.supabaseAdmin
        .from('documents')
        .select('id, org_id, storage_key')
        .not('deleted_at', 'is', null)
        .lte('purge_after', nowIso)
        .limit(1000);
      if (error) throw error;
      let purged = 0;
      for (const v of victims || []) {
        try {
          if (v.storage_key) {
            try { await app.supabaseAdmin.storage.from('documents').remove([v.storage_key]); } catch (e) { app.log.error(e, 'purge: storage doc remove failed'); }
            try { await app.supabaseAdmin.storage.from('extractions').remove([`${v.org_id}/${v.id}.json`]); } catch {}
          }
          await app.supabaseAdmin.from('documents').delete().eq('org_id', v.org_id).eq('id', v.id);
          try { await app.supabaseAdmin.from('audit_events').insert({ org_id: v.org_id, type: 'documents.purge', doc_id: v.id, note: 'scheduled purge' }); } catch {}
          purged++;
        } catch (e) {
          app.log.error(e, 'purge: failed for doc');
        }
      }
      app.log.info({ purged }, 'Recycle purge: complete');
    } catch (e) {
      app.log.error(e, 'Recycle purge: error');
    }
  }

  function msUntilNextHour(hourUtc) {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  function scheduleDailyPurge() {
    if (!PURGE_ENABLED) return;
    const delay = msUntilNextHour(PURGE_UTC_HOUR);
    app.log.info({ PURGE_UTC_HOUR, delay_ms: delay }, 'Scheduling daily recycle purge');
    setTimeout(async function run() {
      await purgeExpiredOnce();
      // re-schedule roughly every 24h
      setTimeout(run, 24 * 60 * 60 * 1000);
    }, delay);
  }

  scheduleDailyPurge();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
