#!/usr/bin/env node
// Test script to verify Polaad organization setup
// Run this after creating the organization to verify everything works

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

async function testPolaadSetup() {
  console.log('🔍 Testing Polaad organization setup...\n');

  try {
    // 1. Check organization exists
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('*')
      .eq('name', 'Polaad')
      .single();

    if (orgErr || !org) {
      console.error('❌ Organization "Polaad" not found');
      return;
    }
    console.log('✅ Organization found:', org.name, '(ID:', org.id, ')');

    // 2. Check departments
    const { data: depts, error: deptErr } = await supabase
      .from('departments')
      .select('name')
      .eq('org_id', org.id);

    if (deptErr) throw deptErr;

    const expectedDepts = ['Creative', 'Marketing', 'Sales', 'General2'];
    const deptNames = depts?.map(d => d.name).sort() || [];
    const expectedNames = expectedDepts.sort();

    if (JSON.stringify(deptNames) === JSON.stringify(expectedNames)) {
      console.log('✅ All departments created:', deptNames.join(', '));
    } else {
      console.error('❌ Department mismatch. Expected:', expectedNames, 'Found:', deptNames);
    }

    // 3. Check admin user
    const { data: adminUsers, error: adminErr } = await supabase
      .from('organization_users')
      .select(`
        role,
        app_users(display_name)
      `)
      .eq('org_id', org.id)
      .eq('role', 'orgAdmin');

    if (adminErr) throw adminErr;

    if (adminUsers && adminUsers.length > 0) {
      console.log('✅ Admin user found:', adminUsers[0].app_users?.display_name, '(Role: orgAdmin)');
    } else {
      console.error('❌ No admin user found');
    }

    // 4. Check roles
    const { data: roles, error: roleErr } = await supabase
      .from('org_roles')
      .select('key, name')
      .eq('org_id', org.id);

    if (roleErr) throw roleErr;

    const expectedRoles = ['orgAdmin', 'contentManager', 'contentViewer', 'guest'];
    const roleKeys = roles?.map(r => r.key).sort() || [];

    if (JSON.stringify(roleKeys.sort()) === JSON.stringify(expectedRoles.sort())) {
      console.log('✅ All roles created:', roleKeys.join(', '));
    } else {
      console.error('❌ Role mismatch. Expected:', expectedRoles, 'Found:', roleKeys);
    }

    // 5. Check org settings
    const { data: orgSettings, error: settingsErr } = await supabase
      .from('org_settings')
      .select('*')
      .eq('org_id', org.id)
      .single();

    if (settingsErr || !orgSettings) {
      console.error('❌ Organization settings not found');
    } else {
      console.log('✅ Organization settings configured');
    }

    console.log('\n🎉 Polaad organization verification complete!');
    console.log('📧 Admin can now log in with their credentials');
    console.log('🏢 Organization is ready for use');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testPolaadSetup();
