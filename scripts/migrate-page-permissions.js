#!/usr/bin/env node
/**
 * Migration Script: Add Page Permissions to Existing Roles
 * 
 * This script adds page permissions to all existing roles based on their functional permissions.
 * It's safe to run multiple times (idempotent).
 * 
 * Usage:
 *   node scripts/migrate-page-permissions.js                    # Migrate all orgs
 *   node scripts/migrate-page-permissions.js --orgId <uuid>     # Migrate specific org
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('❌ Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

/**
 * Calculate page permissions from functional permissions
 */
function calculatePagePermissions(functionalPermissions) {
  if (!functionalPermissions || typeof functionalPermissions !== 'object') {
    return {};
  }

  return {
    'pages.upload': functionalPermissions['documents.create'] === true,
    'pages.documents': functionalPermissions['documents.read'] === true,
    'pages.activity': functionalPermissions['audit.read'] === true,
    'pages.recycle_bin': functionalPermissions['org.manage_members'] === true || 
                         functionalPermissions['documents.delete'] === true,
    'pages.chat': true // Default to true for backward compatibility
  };
}

/**
 * Migrate roles for a specific organization
 */
async function migrateOrgRoles(orgId) {
  console.log(`\n🔄 Migrating roles for org: ${orgId}`);
  
  // Fetch all roles for this org
  const { data: roles, error: fetchError } = await supabase
    .from('org_roles')
    .select('id, key, name, permissions')
    .eq('org_id', orgId);

  if (fetchError) {
    console.error(`❌ Error fetching roles for org ${orgId}:`, fetchError);
    return { success: false, error: fetchError };
  }

  if (!roles || roles.length === 0) {
    console.log(`⚠️  No roles found for org ${orgId}`);
    return { success: true, migrated: 0 };
  }

  console.log(`📋 Found ${roles.length} roles to migrate`);

  let migrated = 0;
  let skipped = 0;

  for (const role of roles) {
    const functionalPerms = role.permissions || {};
    
    // Calculate page permissions
    const pagePerms = calculatePagePermissions(functionalPerms);
    
    // Check if page permissions already exist
    const hasPagePerms = Object.keys(functionalPerms).some(key => key.startsWith('pages.'));
    
    if (hasPagePerms) {
      console.log(`⏭️  Role "${role.key}" already has page permissions, skipping`);
      skipped++;
      continue;
    }

    // Merge: preserve existing permissions, add new page permissions
    const updatedPermissions = {
      ...functionalPerms,
      ...pagePerms
    };

    // Update the role
    const { error: updateError } = await supabase
      .from('org_roles')
      .update({ 
        permissions: updatedPermissions,
        updated_at: new Date().toISOString()
      })
      .eq('id', role.id);

    if (updateError) {
      console.error(`❌ Error updating role "${role.key}":`, updateError);
      continue;
    }

    console.log(`✅ Migrated role "${role.key}" - added ${Object.keys(pagePerms).length} page permissions`);
    console.log(`   - pages.upload: ${pagePerms['pages.upload']}`);
    console.log(`   - pages.documents: ${pagePerms['pages.documents']}`);
    console.log(`   - pages.activity: ${pagePerms['pages.activity']}`);
    console.log(`   - pages.recycle_bin: ${pagePerms['pages.recycle_bin']}`);
    console.log(`   - pages.chat: ${pagePerms['pages.chat']}`);
    migrated++;
  }

  return { success: true, migrated, skipped, total: roles.length };
}

/**
 * Main migration function
 */
async function main() {
  console.log('🚀 Starting page permissions migration...\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  const orgIdArg = args.find(arg => arg.startsWith('--orgId='));
  const orgId = orgIdArg ? orgIdArg.split('=')[1] : null;

  if (orgId) {
    // Migrate specific org
    const result = await migrateOrgRoles(orgId);
    if (result.success) {
      console.log(`\n✅ Migration complete!`);
      console.log(`   Migrated: ${result.migrated} roles`);
      console.log(`   Skipped: ${result.skipped} roles`);
      console.log(`   Total: ${result.total} roles`);
    } else {
      console.error(`\n❌ Migration failed:`, result.error);
      process.exit(1);
    }
  } else {
    // Migrate all orgs
    console.log('📦 Migrating all organizations...\n');

    // Get all unique org_ids that have roles
    const { data: orgRoles, error: orgError } = await supabase
      .from('org_roles')
      .select('org_id')
      .order('org_id');

    if (orgError) {
      console.error('❌ Error fetching organizations:', orgError);
      process.exit(1);
    }

    const uniqueOrgIds = [...new Set((orgRoles || []).map(r => r.org_id))];
    console.log(`Found ${uniqueOrgIds.length} organizations to migrate\n`);

    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalRoles = 0;
    let failedOrgs = [];

    for (const orgId of uniqueOrgIds) {
      const result = await migrateOrgRoles(orgId);
      if (result.success) {
        totalMigrated += result.migrated || 0;
        totalSkipped += result.skipped || 0;
        totalRoles += result.total || 0;
      } else {
        failedOrgs.push({ orgId, error: result.error });
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 Migration Summary');
    console.log('='.repeat(50));
    console.log(`Organizations processed: ${uniqueOrgIds.length}`);
    console.log(`Roles migrated: ${totalMigrated}`);
    console.log(`Roles skipped: ${totalSkipped}`);
    console.log(`Total roles: ${totalRoles}`);
    
    if (failedOrgs.length > 0) {
      console.log(`\n⚠️  Failed organizations: ${failedOrgs.length}`);
      failedOrgs.forEach(({ orgId, error }) => {
        console.log(`   - ${orgId}: ${error.message}`);
      });
    } else {
      console.log('\n✅ All migrations completed successfully!');
    }
  }
}

main().catch((e) => {
  console.error('❌ Migration failed:', e);
  process.exit(1);
});

