#!/usr/bin/env node
// Seed a new organization with roles and users (admin + optional members)
// Usage examples:
//   node scripts/seed-org.js \
//     --org "Acme Inc" \
//     --adminEmail admin@acme.test \
//     --adminPassword "StrongPassword123!" \
//     --members "viewer1@acme.test:Passw0rd!,manager@acme.test:Passw0rd!@contentManager"
//
// Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getCompleteRolePermissions } from '../src/lib/permission-helpers.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
      args[key] = val;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORG_NAME = args.org || process.env.ORG_NAME || 'Test Organization';
const ADMIN_EMAIL = args.adminEmail || process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = args.adminPassword || process.env.ADMIN_PASSWORD;
const MEMBERS_ARG = args.members || process.env.MEMBERS || '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error('Missing admin credentials. Provide --adminEmail and --adminPassword');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function ensureAuthUserByEmail(email, password) {
  // Try create; if exists, fall back to list and find by email
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    return data.user.id;
  } catch (e) {
    // Find by listing (no filter API available)
    const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) throw listErr;
    const user = (list?.users || []).find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (!user) throw new Error(`User not found and could not create: ${email}`);
    return user.id;
  }
}

function usernameFromEmail(email) {
  return (email || '').split('@')[0];
}

function parseMembersArg(members) {
  // Format: "email:password[:role],email2:password2[:role]"
  const out = [];
  const items = String(members || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const it of items) {
    const parts = it.split(':');
    const email = parts[0] || '';
    const password = parts[1] || '';
    const role = parts[2] || 'contentViewer';
    if (email && password) out.push({ email, password, role });
  }
  return out;
}

async function upsertOrgRoles(orgId) {
  const roles = [
    {
      key: 'orgAdmin',
      name: 'Organization Admin',
      is_system: true,
      permissions: {
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
          'chat.save_sessions': true,
          'audit.read': true,
        }),
        'dashboard.view': 'admin'
      },
    },
    {
      key: 'contentManager',
      name: 'Content Manager',
      is_system: true,
      permissions: {
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
          'chat.save_sessions': true,
          'audit.read': true,
        }),
        'dashboard.view': 'regular'
      },
    },
    {
      key: 'contentViewer',
      name: 'Content Viewer',
      is_system: true,
      permissions: {
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
          'chat.save_sessions': false,
          'audit.read': true,
        }),
        'dashboard.view': 'regular'
      },
    },
    {
      key: 'guest',
      name: 'Guest',
      is_system: true,
      permissions: {
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
          'search.semantic': false,
          'chat.save_sessions': false,
          'audit.read': false,
        }),
        'dashboard.view': 'regular'
      },
    },
  ];
  const rows = roles.map((r) => ({ org_id: orgId, key: r.key, name: r.name, is_system: r.is_system, permissions: r.permissions }));
  const { error } = await supabase.from('org_roles').upsert(rows, { onConflict: 'org_id,key' });
  if (error) throw error;
}

async function main() {
  console.log('Seeding organization + users...');
  // 1) Create admin auth user (or find existing)
  const adminId = await ensureAuthUserByEmail(ADMIN_EMAIL, ADMIN_PASSWORD);
  console.log('Admin user id:', adminId);

  // 2) Optional members
  const members = parseMembersArg(MEMBERS_ARG);
  const memberIds = [];
  for (const m of members) {
    const uid = await ensureAuthUserByEmail(m.email, m.password);
    memberIds.push({ id: uid, role: m.role, email: m.email });
    console.log('Member user id:', uid, 'role:', m.role);
  }

  // 3) Create organization
  const { data: orgRow, error: orgErr } = await supabase
    .from('organizations')
    .insert({ name: ORG_NAME })
    .select('*')
    .single();
  if (orgErr) throw orgErr;
  const orgId = orgRow.id;
  console.log('Organization id:', orgId);

  // 4) Seed roles
  await upsertOrgRoles(orgId);
  console.log('Seeded roles');

  // 5) Ensure app_users rows
  const appUsers = [{ id: adminId, display_name: 'Admin ' + usernameFromEmail(ADMIN_EMAIL) }]
    .concat(memberIds.map((m) => ({ id: m.id, display_name: usernameFromEmail(m.email) })));
  const { error: auErr } = await supabase.from('app_users').upsert(appUsers);
  if (auErr) throw auErr;
  console.log('Upserted app_users');

  // 6) Add memberships
  const memberships = [
    { org_id: orgId, user_id: adminId, role: 'orgAdmin' },
    ...memberIds.map((m) => ({ org_id: orgId, user_id: m.id, role: m.role || 'contentViewer' })),
  ];
  const { error: memErr } = await supabase.from('organization_users').upsert(memberships, { onConflict: 'org_id,user_id' });
  if (memErr) throw memErr;
  console.log('Added memberships');

  // 7) Initialize org_settings
  const { error: setErr } = await supabase.from('org_settings').upsert({ org_id: orgId }, { onConflict: 'org_id' });
  if (setErr) throw setErr;
  console.log('Initialized org_settings');

  console.log('\nDone. Org:', orgId);
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});

