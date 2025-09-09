// Optimized API endpoints for better performance

// 1. Optimized dashboard team stats endpoint
export function registerOptimizedDashboardRoutes(app) {
  // Admin: Get optimized team statistics
  app.get('/orgs/:orgId/dashboard/teams', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;

    // Check if user is admin
    const { data: userRole } = await db
      .from('organization_users')
      .select('role')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .single();

    if (userRole?.role !== 'orgAdmin') {
      return { error: 'Access denied. Admin only.' };
    }

    // Use optimized query with materialized view or stored procedure
    try {
      // Try to use the stored procedure first
      const { data: teamStats, error: procError } = await db.rpc('get_department_stats', {
        org_id_param: orgId
      });

      if (!procError && teamStats) {
        return { teams: teamStats };
      }
    } catch (procError) {
      console.log('Stored procedure failed, falling back to optimized query');
    }

    // Fallback to optimized batch query
    const { data: departments, error: deptError } = await db
      .from('departments')
      .select(`
        id, 
        name, 
        lead_user_id,
        department_users!inner(user_id, role),
        documents(
          id, 
          uploaded_at, 
          type, 
          deleted_at
        )
      `)
      .eq('org_id', orgId)
      .neq('name', 'Core');

    if (deptError) throw deptError;

    // Calculate stats in memory for better performance
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const teamStats = (departments || []).map(dept => {
      // Count unique members
      const memberCount = new Set(dept.department_users.map(du => du.user_id)).size;

      // Filter documents once and count for different periods
      const validDocs = (dept.documents || []).filter(doc => 
        doc.type !== 'folder' && !doc.deleted_at
      );

      const todayCount = validDocs.filter(doc => 
        new Date(doc.uploaded_at) >= today
      ).length;

      const yesterdayCount = validDocs.filter(doc => 
        new Date(doc.uploaded_at) >= yesterday && new Date(doc.uploaded_at) < today
      ).length;

      const weekCount = validDocs.filter(doc => 
        new Date(doc.uploaded_at) >= weekAgo
      ).length;

      return {
        id: dept.id,
        name: dept.name,
        memberCount,
        docsToday: todayCount,
        docsYesterday: yesterdayCount,
        docsThisWeek: weekCount,
        leadUserId: dept.lead_user_id
      };
    });

    return { teams: teamStats };
  });

  // Optimized team lead member statistics
  app.get('/orgs/:orgId/dashboard/members', { preHandler: app.verifyAuth }, async (req) => {
    const db = req.supabase;
    const orgId = await ensureActiveMember(req);
    const userId = req.user?.sub;

    // Get user's departments where they are team lead using single optimized query
    const { data: allMembers, error: memberError } = await db
      .from('department_users')
      .select(`
        user_id,
        role,
        department_id,
        departments!inner(name, id),
        app_users(display_name)
      `)
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .eq('role', 'lead');

    if (memberError) throw memberError;

    if (!allMembers || allMembers.length === 0) {
      return { error: 'No teams found where you are team lead.' };
    }

    // Get all members in the user's departments with their document stats
    const deptIds = [...new Set(allMembers.map(m => m.department_id))];

    // Single optimized query to get all members and their stats
    const { data: membersWithStats, error: statsError } = await db
      .from('department_users')
      .select(`
        user_id,
        role,
        department_id,
        departments(name),
        app_users(display_name),
        documents(
          id,
          uploaded_at,
          type,
          deleted_at,
          department_id,
          owner_user_id
        )
      `)
      .eq('org_id', orgId)
      .in('department_id', deptIds);

    if (statsError) throw statsError;

    // Group by user and calculate stats
    const userStatsMap = new Map();

    membersWithStats.forEach(member => {
      if (!userStatsMap.has(member.user_id)) {
        userStatsMap.set(member.user_id, {
          userId: member.user_id,
          displayName: member.app_users?.display_name || member.user_id,
          role: member.role,
          departmentName: member.departments?.name || 'Unknown',
          docsToday: 0,
          docsYesterday: 0,
          docsThisWeek: 0
        });
      }

      // Calculate document stats for this member
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);

      const validDocs = (member.documents || []).filter(doc => 
        doc.type !== 'folder' && 
        doc.deleted_at === null &&
        doc.department_id === member.department_id &&
        doc.owner_user_id === member.user_id
      );

      const userStats = userStatsMap.get(member.user_id);
      userStats.docsToday += validDocs.filter(doc => 
        new Date(doc.uploaded_at) >= today
      ).length;

      userStats.docsYesterday += validDocs.filter(doc => 
        new Date(doc.uploaded_at) >= yesterday && new Date(doc.uploaded_at) < today
      ).length;

      userStats.docsThisWeek += validDocs.filter(doc => 
        new Date(doc.uploaded_at) >= weekAgo
      ).length;
    });

    const memberStats = Array.from(userStatsMap.values());

    return { members: memberStats };
  });
}

// 2. Optimized bootstrap endpoint
app.get('/me/bootstrap', { preHandler: app.verifyAuth }, async (req) => {
  console.log('Optimized Bootstrap endpoint called for user:', req.user?.sub);
  const db = req.supabase;
  const userId = req.user?.sub;
  
  // Use single optimized query to get all bootstrap data
  try {
    const { data: bootstrapData, error: bootstrapError } = await db.rpc('get_user_bootstrap_data', {
      p_user_id: userId,
      p_org_id: req.headers['x-org-id'] || null
    });

    if (!bootstrapError && bootstrapData) {
      // Return the data directly from the stored procedure
      return bootstrapData[0];
    }
  } catch (procError) {
    console.log('Stored procedure failed, falling back to optimized queries');
  }

  // Fallback to optimized parallel queries
  const [
    userResult,
    orgsResult,
    orgSettingsResult,
    userSettingsResult
  ] = await Promise.all([
    // User profile
    db.from('app_users').select('*').eq('id', userId).maybeSingle(),
    
    // Organization memberships with names
    db.from('organization_users')
      .select('org_id, role, expires_at, organizations(name)')
      .eq('user_id', userId),
    
    // Selected org settings (if header provided)
    req.headers['x-org-id'] 
      ? db.from('org_settings').select('*').eq('org_id', req.headers['x-org-id']).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    
    // User settings
    db.from('user_settings').select('*').eq('user_id', userId).maybeSingle()
  ]);

  if (userResult.error) throw userResult.error;
  if (orgsResult.error) throw orgsResult.error;

  // Filter out expired memberships
  const now = Date.now();
  const orgs = (orgsResult.data || []).filter((r) => 
    !r.expires_at || new Date(r.expires_at).getTime() > now
  );

  // Choose selected org id
  const hdrOrg = req.headers['x-org-id'] ? String(req.headers['x-org-id']) : null;
  const roleOrder = { guest: 0, contentViewer: 1, member: 2, contentManager: 2, teamLead: 3, orgAdmin: 4 };
  let selectedOrgId = null;
  
  if (hdrOrg && orgs.some((o) => String(o.org_id) === hdrOrg)) {
    selectedOrgId = hdrOrg;
  } else if (orgs.length > 0) {
    const best = orgs.reduce((acc, r) => 
      (roleOrder[r.role] > roleOrder[acc.role] ? r : acc), orgs[0]);
    selectedOrgId = String(best.org_id);
  }

  // Get departments with membership flags using optimized single query
  let departments = [];
  if (selectedOrgId) {
    const { data: deptData, error: deptError } = await db
      .from('departments')
      .select(`
        id, 
        org_id, 
        name, 
        lead_user_id, 
        color, 
        categories,
        department_users!inner(user_id, role)
      `)
      .eq('org_id', selectedOrgId)
      .order('name');

    if (!deptError && deptData) {
      const userId = req.user?.sub;
      departments = deptData.map(dept => {
        const isMember = dept.department_users.some(du => du.user_id === userId);
        const isLead = dept.department_users.some(du => 
          du.user_id === userId && du.role === 'lead'
        );
        
        return {
          ...dept,
          is_member: isMember,
          is_lead: isLead,
          categories: dept.categories || [
            'General', 'Legal', 'Financial', 'HR', 'Marketing', 
            'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'
          ]
        };
      });
    }
  }

  const result = {
    user: { 
      id: userId, 
      displayName: userResult.data?.display_name || null 
    },
    orgs: orgs.map((r) => ({ 
      orgId: r.org_id, 
      role: r.role, 
      name: r.organizations?.name, 
      expiresAt: r.expires_at 
    })),
    selectedOrgId,
    orgSettings: orgSettingsResult.data || {
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false,
      ip_allowlist_enabled: false,
      ip_allowlist_ips: [],
      categories: [
        'General', 'Legal', 'Financial', 'HR', 'Marketing', 
        'Technical', 'Invoice', 'Contract', 'Report', 'Correspondence'
      ],
    },
    userSettings: userSettingsResult.data || {
      date_format: 'd MMM yyyy',
      accent_color: 'default',
      dark_mode: false,
      chat_filters_enabled: false,
    },
    permissions: {}, // Would be populated with actual permissions
    departments
  };

  console.log('Optimized bootstrap returning data:', {
    userId,
    selectedOrgId,
    orgCount: orgs.length,
    departmentCount: departments.length
  });

  return result;
});

// 3. Optimized organization users endpoint
app.get('/orgs/:orgId/users', { preHandler: app.verifyAuth }, async (req) => {
  const db = req.supabase;
  const orgId = await ensureActiveMember(req);
  
  // Use optimized single query with joins
  const { data: usersWithDetails, error } = await db
    .from('organization_users')
    .select(`
      user_id,
      role,
      expires_at,
      app_users(display_name),
      department_users(department_id, role)
    `)
    .eq('org_id', orgId);

  if (error) throw error;

  // Get department information in a single query
  const { data: departments } = await db
    .from('departments')
    .select('id, name, color')
    .eq('org_id', orgId);

  const deptMap = new Map((departments || []).map(d => [d.id, d]));

  // Process results efficiently
  const userList = (usersWithDetails || []).map(user => {
    const departments = (user.department_users || []).map(du => {
      const dept = deptMap.get(du.department_id);
      return dept ? { 
        id: dept.id, 
        name: dept.name, 
        color: dept.color || null 
      } : null;
    }).filter(Boolean);

    return {
      userId: user.user_id,
      role: user.role,
      displayName: user.app_users?.display_name || null,
      expires_at: user.expires_at || null,
      departments
    };
  });

  return userList;
});