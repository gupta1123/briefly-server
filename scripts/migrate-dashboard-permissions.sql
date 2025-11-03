-- Migration Script: Add Dashboard View Permission to Existing Roles
-- 
-- This script adds dashboard.view permission to all existing roles based on their role key.
-- It's safe to run multiple times (idempotent).
--
-- Usage:
--   1. Copy and paste this entire script into Supabase SQL Editor
--   2. Run it once to migrate all organizations
--
-- What it does:
--   - Sets dashboard.view to 'admin' for orgAdmin roles
--   - Sets dashboard.view to 'regular' for all other roles (teamLead, member, contentViewer, contentManager, guest)
--   - Preserves existing dashboard.view values if already set
--
-- Default Dashboard View Mapping:
--   orgAdmin -> 'admin' (org-wide dashboard)
--   All other roles -> 'regular' (role-based dashboard)

-- Function to set dashboard.view permission based on role key
DO $$
DECLARE
  role_rec RECORD;
  updated_permissions JSONB;
  dashboard_value TEXT;
BEGIN
  -- Loop through all roles
  FOR role_rec IN 
    SELECT id, org_id, key, name, permissions
    FROM org_roles
  LOOP
    -- Skip if dashboard.view is already set
    IF role_rec.permissions ? 'dashboard.view' THEN
      RAISE NOTICE 'Skipping role % (org_id: %, key: %) - dashboard.view already set to %', 
        role_rec.id, role_rec.org_id, role_rec.key, role_rec.permissions->>'dashboard.view';
      CONTINUE;
    END IF;
    
    -- Determine dashboard value based on role key
    IF role_rec.key = 'orgAdmin' THEN
      dashboard_value := 'admin';
    ELSE
      -- All other roles get regular dashboard (role-based)
      dashboard_value := 'regular';
    END IF;
    
    -- Merge dashboard.view with existing permissions
    updated_permissions := role_rec.permissions || jsonb_build_object('dashboard.view', dashboard_value);
    
    -- Update the role
    UPDATE org_roles
    SET 
      permissions = updated_permissions,
      updated_at = NOW()
    WHERE id = role_rec.id;
    
    RAISE NOTICE 'Updated role % (org_id: %, key: %) - set dashboard.view to %', 
      role_rec.id, role_rec.org_id, role_rec.key, dashboard_value;
    
  END LOOP;
  
  RAISE NOTICE 'Migration completed successfully!';
END $$;

-- Verification query: Show roles with their dashboard.view permission
-- Uncomment the following to verify the migration:
/*
SELECT 
  org_id,
  key,
  name,
  CASE 
    WHEN permissions ? 'dashboard.view' THEN permissions->>'dashboard.view'
    ELSE 'NOT SET'
  END as dashboard_view
FROM org_roles
ORDER BY org_id, key;
*/

-- Summary query: Count roles with dashboard.view permission
SELECT 
  COUNT(*) FILTER (WHERE permissions ? 'dashboard.view') as roles_with_dashboard_view,
  COUNT(*) FILTER (WHERE permissions->>'dashboard.view' = 'admin') as roles_with_admin_dashboard,
  COUNT(*) FILTER (WHERE permissions->>'dashboard.view' = 'regular') as roles_with_regular_dashboard,
  COUNT(*) as total_roles
FROM org_roles;

