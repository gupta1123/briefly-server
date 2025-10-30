#!/usr/bin/env node
// Create Polaad Organization with Teams and Admin User
// Usage: node scripts/create-polaad-org.js --adminEmail admin@polaad.com --adminPassword "StrongPassword123!"

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

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
const ADMIN_EMAIL = args.adminEmail || 'admin@polaad.com';
const ADMIN_PASSWORD = args.adminPassword || 'PolaadAdmin123!';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function createAuthUser(email, password) {
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;
    console.log('✅ Created auth user:', email);
    return data.user.id;
  } catch (e) {
    console.error('❌ Failed to create auth user:', e.message);
    throw e;
  }
}

async function createOrganization() {
  console.log('🚀 Creating Polaad organization...');

  try {
    // 1) Create admin auth user
    const adminId = await createAuthUser(ADMIN_EMAIL, ADMIN_PASSWORD);

    // 2) Create organization
    const { data: orgRow, error: orgErr } = await supabase
      .from('organizations')
      .insert({ name: 'Polaad' })
      .select('*')
      .single();

    if (orgErr) throw orgErr;
    const orgId = orgRow.id;
    console.log('✅ Created organization: Polaad (ID:', orgId, ')');

    // 3) Create app_users entry
    const { error: auErr } = await supabase.from('app_users').upsert({
      id: adminId,
      display_name: 'Polaad Admin'
    });
    if (auErr) throw auErr;
    console.log('✅ Created app user entry');

    // 4) Add admin to organization as orgAdmin
    const { error: memErr } = await supabase.from('organization_users').upsert({
      org_id: orgId,
      user_id: adminId,
      role: 'orgAdmin'
    }, { onConflict: 'org_id,user_id' });
    if (memErr) throw memErr;
    console.log('✅ Added admin to organization as orgAdmin');

    // 5) Create organization roles
    const roles = [
      {
        key: 'orgAdmin',
        name: 'Organization Admin',
        is_system: true,
        permissions: {
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
        },
      },
      {
        key: 'contentManager',
        name: 'Content Manager',
        is_system: true,
        permissions: {
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
        },
      },
      {
        key: 'contentViewer',
        name: 'Content Viewer',
        is_system: true,
        permissions: {
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
        },
      },
      {
        key: 'guest',
        name: 'Guest',
        is_system: true,
        permissions: {
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
        },
      },
    ];

    const roleRows = roles.map((r) => ({ org_id: orgId, ...r }));
    const { error: roleErr } = await supabase.from('org_roles').upsert(roleRows, { onConflict: 'org_id,key' });
    if (roleErr) throw roleErr;
    console.log('✅ Created organization roles');

    // 6) Create departments (including Core)
    const departments = ['Creative', 'Marketing', 'Sales', 'General2', 'Core'];
    const deptInserts = departments.map(name => ({
      org_id: orgId,
      name: name,
      lead_user_id: adminId
    }));

    const { data: deptRows, error: deptErr } = await supabase
      .from('departments')
      .insert(deptInserts)
      .select('*');

    if (deptErr) throw deptErr;
    console.log('✅ Created departments:', departments.join(', '));

    // 7) Add admin as lead of all departments
    const deptUserInserts = deptRows.map(dept => ({
      org_id: orgId,
      department_id: dept.id,
      user_id: adminId,
      role: 'lead'
    }));

    const { error: deptUserErr } = await supabase.from('department_users').upsert(deptUserInserts, { onConflict: 'department_id,user_id' });
    if (deptUserErr) throw deptUserErr;
    console.log('✅ Added admin as lead of all departments');

    // 8) Initialize org settings
    const { error: setErr } = await supabase.from('org_settings').upsert({
      org_id: orgId,
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false,
      ip_allowlist_enabled: false,
      ip_allowlist_ips: [],
      categories: ['General', 'Legal', 'Financial', 'HR', 'Marketing', 'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence']
    }, { onConflict: 'org_id' });
    if (setErr) throw setErr;
    console.log('✅ Initialized organization settings');

    // 9) Initialize user settings
    const { error: userSetErr } = await supabase.from('user_settings').upsert({
      user_id: adminId,
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false
    }, { onConflict: 'user_id' });
    if (userSetErr) throw userSetErr;
    console.log('✅ Initialized user settings');

    console.log('\n🎉 SUCCESS! Polaad organization created successfully!');
    console.log('📧 Admin Email:', ADMIN_EMAIL);
    console.log('🔑 Admin Password:', ADMIN_PASSWORD);
    console.log('🏢 Organization: Polaad');
    console.log('👥 Departments: Creative, Marketing, Sales, General2');
    console.log('👑 Admin Role: Organization Admin (can access everything including Activity/Audit)');

    return { orgId, adminId };

  } catch (error) {
    console.error('❌ Error creating Polaad organization:', error);
    throw error;
  }
}

createOrganization().catch((e) => {
  console.error('Script failed:', e);
  process.exit(1);
});
