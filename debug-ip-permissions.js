#!/usr/bin/env node

/**
 * Debug script to check IP permissions for a specific organization and user
 * Usage: node debug-ip-permissions.js <orgId> <userId>
 */

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function debugIpPermissions(orgId, userId) {
  console.log(`🔍 Debugging IP permissions for org: ${orgId}, user: ${userId}`);
  
  try {
    // 1. Check organization IP settings
    console.log('\n📋 Organization IP Settings:');
    const { data: orgSettings, error: orgError } = await supabase
      .from('org_settings')
      .select('ip_allowlist_enabled, ip_allowlist_ips')
      .eq('org_id', orgId)
      .maybeSingle();
    
    if (orgError) {
      console.error('❌ Error fetching org settings:', orgError);
      return;
    }
    
    console.log('IP Allowlist Enabled:', orgSettings?.ip_allowlist_enabled || false);
    console.log('Allowed IPs:', orgSettings?.ip_allowlist_ips || []);
    
    // 2. Check user's role in organization
    console.log('\n👤 User Role in Organization:');
    const { data: membership, error: membershipError } = await supabase
      .from('organization_users')
      .select('role, expires_at')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .maybeSingle();
    
    if (membershipError) {
      console.error('❌ Error fetching membership:', membershipError);
      return;
    }
    
    console.log('Role:', membership?.role || 'No role found');
    console.log('Expires At:', membership?.expires_at || 'Never');
    
    // 3. Check role permissions
    if (membership?.role) {
      console.log('\n🔐 Role Permissions:');
      const { data: roleRow, error: roleError } = await supabase
        .from('org_roles')
        .select('permissions')
        .eq('org_id', orgId)
        .eq('key', membership.role)
        .maybeSingle();
      
      if (roleError) {
        console.error('❌ Error fetching role permissions:', roleError);
        return;
      }
      
      const permissions = roleRow?.permissions || {};
      console.log('All Permissions:', permissions);
      console.log('Has security.ip_bypass:', !!permissions['security.ip_bypass']);
    }
    
    // 4. Check if user has any permission overrides
    console.log('\n🎛️ Permission Overrides:');
    const { data: overrides, error: overrideError } = await supabase
      .from('permission_overrides')
      .select('permission, granted')
      .eq('org_id', orgId)
      .eq('user_id', userId);
    
    if (overrideError) {
      console.error('❌ Error fetching overrides:', overrideError);
    } else {
      console.log('User Overrides:', overrides || []);
      const ipBypassOverride = overrides?.find(o => o.permission === 'security.ip_bypass');
      if (ipBypassOverride) {
        console.log('IP Bypass Override:', ipBypassOverride.granted);
      }
    }
    
    // 5. Simulate IP validation logic
    console.log('\n🌐 IP Validation Simulation:');
    const clientIp = '127.0.0.1';
    console.log('Client IP:', clientIp);
    
    if (!orgSettings || !orgSettings.ip_allowlist_enabled) {
      console.log('✅ Access allowed: IP allowlist is disabled');
      return;
    }
    
    const userRole = membership?.role;
    let hasBypass = false;
    
    if (userRole) {
      const { data: roleRow } = await supabase
        .from('org_roles')
        .select('permissions')
        .eq('org_id', orgId)
        .eq('key', userRole)
        .maybeSingle();
      const perms = roleRow?.permissions || {};
      hasBypass = !!perms['security.ip_bypass'];
    }
    
    console.log('User Role:', userRole);
    console.log('Has Bypass Permission:', hasBypass);
    
    if (hasBypass) {
      console.log('✅ Access allowed: User has security.ip_bypass permission');
      return;
    }
    
    if (userRole === 'orgAdmin') {
      console.log('✅ Access allowed: User is orgAdmin (legacy bypass)');
      return;
    }
    
    const allowedIps = orgSettings.ip_allowlist_ips || [];
    const isAllowed = allowedIps.some(allowedIp => {
      // Simple IP matching for localhost
      if (allowedIp === '127.0.0.1' || allowedIp === 'localhost') return true;
      if (allowedIp.includes('/')) {
        // CIDR notation - simplified check
        const [network, prefix] = allowedIp.split('/');
        return network === '127.0.0.1';
      }
      return allowedIp === clientIp;
    });
    
    console.log('Allowed IPs:', allowedIps);
    console.log('IP Match:', isAllowed);
    
    if (isAllowed) {
      console.log('✅ Access allowed: IP is in allowlist');
    } else {
      console.log('❌ Access denied: IP not in allowlist and no bypass permission');
    }
    
  } catch (error) {
    console.error('❌ Unexpected error:', error);
  }
}

// Get command line arguments
const orgId = process.argv[2];
const userId = process.argv[3];

if (!orgId || !userId) {
  console.log('Usage: node debug-ip-permissions.js <orgId> <userId>');
  console.log('Example: node debug-ip-permissions.js 0eb17226-9124-4963-80e5-d88b211014c4 <user-id>');
  process.exit(1);
}

debugIpPermissions(orgId, userId);
