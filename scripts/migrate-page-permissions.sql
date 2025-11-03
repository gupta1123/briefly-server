-- Migration Script: Add Page Permissions to Existing Roles
-- 
-- This script adds page permissions to all existing roles based on their functional permissions.
-- It's safe to run multiple times (idempotent).
--
-- Usage:
--   1. Copy and paste this entire script into Supabase SQL Editor
--   2. Run it once to migrate all organizations
--
-- What it does:
--   - Adds pages.upload based on documents.create
--   - Adds pages.documents based on documents.read
--   - Adds pages.activity based on audit.read
--   - Adds pages.recycle_bin based on org.manage_members OR documents.delete
--   - Adds pages.chat as true (default for backward compatibility)
--
-- Page Permissions Mapping:
--   pages.upload = documents.create
--   pages.documents = documents.read
--   pages.activity = audit.read
--   pages.recycle_bin = org.manage_members OR documents.delete
--   pages.chat = true (default)

-- Function to merge page permissions into existing permissions JSONB
DO $$
DECLARE
  role_rec RECORD;
  updated_permissions JSONB;
  page_perms JSONB;
  has_page_perms BOOLEAN;
BEGIN
  -- Loop through all roles
  FOR role_rec IN 
    SELECT id, org_id, key, name, permissions
    FROM org_roles
  LOOP
    -- Check if page permissions already exist
    has_page_perms := (
      role_rec.permissions ? 'pages.upload' OR
      role_rec.permissions ? 'pages.documents' OR
      role_rec.permissions ? 'pages.activity' OR
      role_rec.permissions ? 'pages.recycle_bin' OR
      role_rec.permissions ? 'pages.chat'
    );
    
    -- Skip if page permissions already exist
    IF has_page_perms THEN
      RAISE NOTICE 'Skipping role % (org_id: %, key: %) - page permissions already exist', 
        role_rec.id, role_rec.org_id, role_rec.key;
      CONTINUE;
    END IF;
    
    -- Calculate page permissions based on functional permissions
    page_perms := jsonb_build_object(
      'pages.upload', COALESCE((role_rec.permissions->>'documents.create')::boolean, false),
      'pages.documents', COALESCE((role_rec.permissions->>'documents.read')::boolean, false),
      'pages.activity', COALESCE((role_rec.permissions->>'audit.read')::boolean, false),
      'pages.recycle_bin', COALESCE(
        (role_rec.permissions->>'org.manage_members')::boolean, false
      ) OR COALESCE(
        (role_rec.permissions->>'documents.delete')::boolean, false
      ),
      'pages.chat', true  -- Default to true for backward compatibility
    );
    
    -- Merge with existing permissions (preserve all existing permissions)
    updated_permissions := role_rec.permissions || page_perms;
    
    -- Update the role
    UPDATE org_roles
    SET 
      permissions = updated_permissions,
      updated_at = NOW()
    WHERE id = role_rec.id;
    
    RAISE NOTICE 'Updated role % (org_id: %, key: %) - added page permissions', 
      role_rec.id, role_rec.org_id, role_rec.key;
    
  END LOOP;
  
  RAISE NOTICE 'Migration completed successfully!';
END $$;

-- Verification query: Show roles with their page permissions
-- Uncomment the following to verify the migration:
/*
SELECT 
  org_id,
  key,
  name,
  CASE 
    WHEN permissions ? 'pages.upload' THEN permissions->>'pages.upload'
    ELSE 'NOT SET'
  END as pages_upload,
  CASE 
    WHEN permissions ? 'pages.documents' THEN permissions->>'pages.documents'
    ELSE 'NOT SET'
  END as pages_documents,
  CASE 
    WHEN permissions ? 'pages.activity' THEN permissions->>'pages.activity'
    ELSE 'NOT SET'
  END as pages_activity,
  CASE 
    WHEN permissions ? 'pages.recycle_bin' THEN permissions->>'pages.recycle_bin'
    ELSE 'NOT SET'
  END as pages_recycle_bin,
  CASE 
    WHEN permissions ? 'pages.chat' THEN permissions->>'pages.chat'
    ELSE 'NOT SET'
  END as pages_chat
FROM org_roles
ORDER BY org_id, key;
*/

-- Summary query: Count roles with and without page permissions
SELECT 
  COUNT(*) FILTER (WHERE permissions ? 'pages.upload') as roles_with_upload,
  COUNT(*) FILTER (WHERE permissions ? 'pages.documents') as roles_with_documents,
  COUNT(*) FILTER (WHERE permissions ? 'pages.activity') as roles_with_activity,
  COUNT(*) FILTER (WHERE permissions ? 'pages.recycle_bin') as roles_with_recycle_bin,
  COUNT(*) FILTER (WHERE permissions ? 'pages.chat') as roles_with_chat,
  COUNT(*) as total_roles
FROM org_roles;

