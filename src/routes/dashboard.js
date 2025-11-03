// Dashboard-specific routes
// Contains APIs for admin team stats and team lead member stats

import { getEffectivePermissions } from '../routes.js';

// Cache key: userId; value: { email, displayName, expiresAt }
const ADMIN_USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const adminUserCache = new Map();

async function getAdminUserCached(app, userId) {
  try {
    const now = Date.now();
    const hit = adminUserCache.get(userId);
    if (hit && hit.expiresAt > now) return hit;
    const { data } = await app.supabaseAdmin.auth.admin.getUserById(userId);
    const email = data?.user?.email || null;
    const displayName = (data?.user?.user_metadata?.display_name) || (data?.user?.user_metadata?.full_name) || null;
    const entry = { email, displayName, expiresAt: now + ADMIN_USER_CACHE_TTL_MS };
    adminUserCache.set(userId, entry);
    return entry;
  } catch (error) {
    console.error(`Error fetching admin user ${userId}:`, error);
    return { email: null, displayName: null };
  }
}

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

export function registerDashboardRoutes(app) {
  // Admin: Get team statistics (docs uploaded today, yesterday, this week, member count)
  app.get('/orgs/:orgId/dashboard/teams', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;

    // Check dashboard permission level instead of just role
    let hasAdminDashboard = false;
    try {
      const { data: userDepts } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      const userDeptIds = userDepts?.map(d => d.department_id) || [];
      const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
      
      const permResult = await getEffectivePermissions(req, orgId, app, { departmentId: deptContext });
      const permissions = permResult?.permissions || {};
      const dashboardLevel = permissions['dashboard.view'] || 'regular';
      hasAdminDashboard = dashboardLevel === 'admin';
    } catch (error) {
      console.warn('Failed to get effective permissions for dashboard teams, falling back to role check:', error);
    }
    
    // Also check if user is orgAdmin (backward compatibility)
    const { data: userRole } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();

    const isOrgAdmin = userRole?.role === 'orgAdmin';
    const canAccess = hasAdminDashboard || isOrgAdmin;

    if (!canAccess) {
      return { error: 'Access denied. Admin dashboard required.' };
    }

    // Get all departments except Core (which is restricted)
    const { data: departments, error: deptError } = await db
      .from('departments')
      .select('id, name, lead_user_id')
      .eq('org_id', orgId)
      .neq('name', 'Core'); // Exclude restricted Core department

    if (deptError) throw deptError;

    // For each department, get stats
    const teamStats = await Promise.all(
      (departments || []).map(async (dept) => {
        // Get member count
        const { count: memberCount } = await db
          .from('department_users')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id);

        // Get document upload stats
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);

        // Documents uploaded today
        const { count: todayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id)
          .neq('type', 'folder') // Exclude folder placeholders
          .gte('uploaded_at', today.toISOString());

        // Documents uploaded yesterday
        const { count: yesterdayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id)
          .neq('type', 'folder') // Exclude folder placeholders
          .gte('uploaded_at', yesterday.toISOString())
          .lt('uploaded_at', today.toISOString());

        // Documents uploaded this week
        const { count: weekCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', dept.id)
          .neq('type', 'folder') // Exclude folder placeholders
          .gte('uploaded_at', weekAgo.toISOString());

        return {
          id: dept.id,
          name: dept.name,
          memberCount: memberCount || 0,
          docsToday: todayCount || 0,
          docsYesterday: yesterdayCount || 0,
          docsThisWeek: weekCount || 0,
          leadUserId: dept.lead_user_id
        };
      })
    );

    return { teams: teamStats };
  });

  // Team Lead: Get member statistics for their teams
  app.get('/orgs/:orgId/dashboard/members', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;

    // Check dashboard permission - if admin dashboard, don't show member cards (use teams endpoint instead)
    let dashboardLevel = 'regular';
    try {
      const { data: userDeptsForPerm } = await db
        .from('department_users')
        .select('department_id')
        .eq('org_id', orgId)
        .eq('user_id', userId);
      const userDeptIds = userDeptsForPerm?.map(d => d.department_id) || [];
      const deptContext = userDeptIds.length > 0 ? userDeptIds[0] : null;
      
      const permResult = await getEffectivePermissions(req, orgId, app, { departmentId: deptContext });
      const permissions = permResult?.permissions || {};
      dashboardLevel = permissions['dashboard.view'] || 'regular';
    } catch (error) {
      console.warn('Failed to get effective permissions for dashboard members, falling back to role check:', error);
    }
    
    // If user has admin dashboard, they should use /dashboard/teams endpoint instead
    if (dashboardLevel === 'admin') {
      return { error: 'Admin dashboard users should use /dashboard/teams endpoint instead.' };
    }

    // Get user's departments where they are team lead
    const { data: userDepts, error: deptError } = await db
      .from('department_users')
      .select('department_id, departments!inner(name)')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .eq('role', 'lead');

    if (deptError) throw deptError;

    console.log('🔍 [TEAM_LEAD_DASHBOARD] User ID:', userId);
    console.log('🔍 [TEAM_LEAD_DASHBOARD] Org ID:', orgId);
    console.log('🔍 [TEAM_LEAD_DASHBOARD] User departments found:', userDepts?.length || 0);
    console.log('🔍 [TEAM_LEAD_DASHBOARD] User departments details:', JSON.stringify(userDepts, null, 2));

    // Additional validation for yashLead1
    if (userId === 'f1b30930-96e7-46e4-b125-3f0d423cfc9f') {
      console.log('🎯 DEBUG: This is yashLead1 - checking expected departments');
      console.log('🎯 DEBUG: Expected department: d5d41293-c8d1-4edf-a2ee-40c9e5be9bd5 (Electricity Control)');
    }

    if (!userDepts || userDepts.length === 0) {
      return { error: 'No teams found where you are team lead.' };
    }

    // Get all members in the user's departments
    const deptIds = userDepts.map(ud => ud.department_id);
    console.log('🔍 [TEAM_LEAD_DASHBOARD] Department IDs for filtering:', deptIds);

    // Debug: Try a simpler query first to see if the issue is with joins
    console.log('🔍 [TEAM_LEAD_DASHBOARD] About to query members with deptIds:', deptIds);

    // Get members with proper joins
    const { data: allMembers, error: memberError } = await db
      .from('department_users')
      .select(`
        user_id,
        role,
        department_id,
        departments(name),
        app_users(display_name)
      `)
      .eq('org_id', orgId)
      .in('department_id', deptIds);

    // If joins failed, get display names separately
    if (allMembers && allMembers.length > 0) {
      const userIds = allMembers.map(m => m.user_id);

      // Get display names for users where the join might have failed
      console.log('🔍 [TEAM_LEAD_DASHBOARD] Looking up display names for user IDs:', userIds);
      const { data: userProfiles, error: profileError } = await db
        .from('app_users')
        .select('id, display_name')
        .in('id', userIds);

      console.log('🔍 [TEAM_LEAD_DASHBOARD] app_users query result:', { userProfiles, profileError });

      // Create a map to track all users and their display names
      const displayNameMap = new Map();

      // First, add any found profiles
      if (userProfiles) {
        userProfiles.forEach(profile => {
          if (profile.display_name) {
            displayNameMap.set(profile.id, profile.display_name);
            console.log(`✅ [TEAM_LEAD_DASHBOARD] Found display name in app_users: ${profile.id} -> ${profile.display_name}`);
          }
        });
      }

      // For users not found in app_users or missing display names, try known names first, then Supabase Auth
      const missingUsers = userIds.filter(id => !displayNameMap.has(id));
      console.log('🔍 [TEAM_LEAD_DASHBOARD] Users missing display names:', missingUsers);



      if (missingUsers.length > 0) {
        console.log('⚠️ [TEAM_LEAD_DASHBOARD] Resolving display names for missing users...');
        
        for (const userId of missingUsers) {
          let resolvedName = null;

          // Try to get from Supabase Auth
          try {
            const authUser = await getAdminUserCached(app, userId);
            if (authUser?.email) {
              resolvedName = authUser.email.split('@')[0];
              console.log(`✅ [TEAM_LEAD_DASHBOARD] Set display name from auth email: ${userId} -> ${resolvedName}`);
            } else if (authUser?.displayName) {
              resolvedName = authUser.displayName;
              console.log(`✅ [TEAM_LEAD_DASHBOARD] Set display name from auth metadata: ${userId} -> ${resolvedName}`);
            } else {
              console.log(`⚠️ [TEAM_LEAD_DASHBOARD] No email or display name found for user ${userId}`);
            }
          } catch (authError) {
            console.log(`⚠️ [TEAM_LEAD_DASHBOARD] Could not get auth data for ${userId}:`, authError.message);
          }

          // If we resolved a name, add it to the map and save to app_users
          if (resolvedName) {
            displayNameMap.set(userId, resolvedName);
            
            // Also insert into app_users table for future use
            try {
              // Use service role to upsert cross-user profiles (bypass self-only RLS)
              await app.supabaseAdmin
                .from('app_users')
                .upsert({ 
                  id: userId, 
                  display_name: resolvedName
                });
              console.log(`✅ [TEAM_LEAD_DASHBOARD] Inserted display name into app_users (admin): ${userId} -> ${resolvedName}`);
            } catch (insertError) {
              console.log(`⚠️ [TEAM_LEAD_DASHBOARD] Could not insert into app_users:`, insertError.message);
            }
          }
        }
      }

      console.log('🔍 [TEAM_LEAD_DASHBOARD] Final display name map:', Object.fromEntries(displayNameMap));

      if (userProfiles) {
        const profileMap = new Map(userProfiles.map(p => [p.id, p.display_name]));
        console.log('🔍 [TEAM_LEAD_DASHBOARD] User profiles found:', userProfiles.length);
        console.log('🔍 [TEAM_LEAD_DASHBOARD] Profile map:', Object.fromEntries(profileMap));

        // Update members with display names from our comprehensive map
        allMembers.forEach(member => {
          const existingDisplayName = member.app_users?.display_name;
          const mappedDisplayName = displayNameMap.get(member.user_id);

          console.log(`🔍 [TEAM_LEAD_DASHBOARD] Member ${member.user_id}: existing="${existingDisplayName}", mapped="${mappedDisplayName}"`);

          if (!existingDisplayName && mappedDisplayName) {
            console.log(`🔍 [TEAM_LEAD_DASHBOARD] Updating display name for ${member.user_id} to "${mappedDisplayName}"`);
            member.app_users = { display_name: mappedDisplayName };
          } else if (!existingDisplayName && !mappedDisplayName) {
            console.log(`⚠️ [TEAM_LEAD_DASHBOARD] No display name found for ${member.user_id}, will use user ID fallback`);
          }
        });
      }
    }

    if (memberError) {
      console.error('❌ [TEAM_LEAD_DASHBOARD] Member query error:', memberError);
      throw memberError;
    }

    console.log('🔍 [TEAM_LEAD_DASHBOARD] Filtered members found:', allMembers?.length || 0);
    console.log('🔍 [TEAM_LEAD_DASHBOARD] Filtered members details:', JSON.stringify(allMembers, null, 2));

    // If no members found, try a direct query without joins to debug
    if (!allMembers || allMembers.length === 0) {
      console.log('⚠️ [TEAM_LEAD_DASHBOARD] No members found with joins, trying direct query...');

      const { data: directMembers, error: directError } = await db
        .from('department_users')
        .select('user_id, role, department_id')
        .eq('org_id', orgId)
        .in('department_id', deptIds);

      console.log('🔍 [TEAM_LEAD_DASHBOARD] Direct query result:', directMembers?.length || 0, directMembers);
      if (directError) console.error('❌ [TEAM_LEAD_DASHBOARD] Direct query error:', directError);
    }

    // Additional validation for yashLead1
    if (userId === 'f1b30930-96e7-46e4-b125-3f0d423cfc9f') {
      console.log('🎯 DEBUG: yashLead1 - expected 3 members in Electricity Control');
      console.log('🎯 DEBUG: Expected users:');
      console.log('  - f1b30930-96e7-46e4-b125-3f0d423cfc9f (yashLead1)');
      console.log('  - 6ac8d09a-0c61-4740-90b9-e9c15c3a4eca (Admin)');
      console.log('  - 5bb3cb46-0d0f-4706-a7e2-c0ed080bafec (yash name)');
    }

    // Group members by department and get their upload stats
    console.log('🔍 [TEAM_LEAD_DASHBOARD] Processing member stats for', allMembers?.length || 0, 'members');

    const memberStats = await Promise.all(
      (allMembers || []).map(async (member) => {
        let displayName = member.app_users?.display_name || member.user_id || 'Unknown User';

        // If we still have a user ID, make it more readable
        if (displayName === member.user_id && displayName.length > 8) {
          displayName = `User ${displayName.substring(0, 8)}`;
        }

        console.log('🔍 [TEAM_LEAD_DASHBOARD] Processing member:', member.user_id, '->', displayName, '(from:', member.app_users?.display_name ? 'app_users' : 'fallback)');
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const weekAgo = new Date(today);
        weekAgo.setDate(weekAgo.getDate() - 7);

        // Documents uploaded by this user today
        const { count: todayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', member.department_id)
          .eq('owner_user_id', member.user_id)
          .neq('type', 'folder') // Exclude folder placeholders
          .gte('uploaded_at', today.toISOString());

        // Documents uploaded by this user yesterday
        const { count: yesterdayCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', member.department_id)
          .eq('owner_user_id', member.user_id)
          .neq('type', 'folder') // Exclude folder placeholders
          .gte('uploaded_at', yesterday.toISOString())
          .lt('uploaded_at', today.toISOString());

        // Documents uploaded by this user this week
        const { count: weekCount } = await db
          .from('documents')
          .select('*', { count: 'exact', head: true })
          .eq('org_id', orgId)
          .eq('department_id', member.department_id)
          .eq('owner_user_id', member.user_id)
          .neq('type', 'folder') // Exclude folder placeholders
          .gte('uploaded_at', weekAgo.toISOString());

        return {
          userId: member.user_id,
          displayName: displayName,
          role: member.role,
          departmentName: member.departments?.name || 'Unknown',
          docsToday: todayCount || 0,
          docsYesterday: yesterdayCount || 0,
          docsThisWeek: weekCount || 0
        };
      })
    );

    console.log('🔍 [TEAM_LEAD_DASHBOARD] Member stats processing complete');
    console.log('🔍 [TEAM_LEAD_DASHBOARD] Final member stats count:', memberStats?.length || 0);
    console.log('🔍 [TEAM_LEAD_DASHBOARD] Display names in response:', memberStats?.map(m => `${m.userId} -> ${m.displayName}`));
    console.log('🔍 [TEAM_LEAD_DASHBOARD] Final member stats:', JSON.stringify(memberStats, null, 2));

    return { members: memberStats };
  });
}
