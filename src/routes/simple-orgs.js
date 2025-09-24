// Simple orgs route for Ops dashboard
export function registerSimpleOrgsRoute(app) {
  // Simple orgs list with key metrics
  app.get('/ops/simple-orgs', { 
    preHandler: [app.verifyAuth, app.requireIpAccess, app.ensurePlatformAdmin] 
  }, async () => {
    const admin = app.supabaseAdmin;

    const { data: orgs, error: orgsError } = await admin
      .from('organizations')
      .select('id, name')
      .order('name');

    if (orgsError) throw orgsError;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sinceIso = thirtyDaysAgo.toISOString();

    const stats = await Promise.all((orgs || []).map(async (org) => {
      const [teamsRes, membersRes, storageRowsRes, recentDocsRes] = await Promise.all([
        admin
          .from('departments')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', org.id),
        admin
          .from('organization_users')
          .select('user_id', { count: 'exact', head: true })
          .eq('org_id', org.id),
        admin
          .from('documents')
          .select('file_size_bytes')
          .eq('org_id', org.id)
          .neq('type', 'folder'),
        admin
          .from('documents')
          .select('id', { count: 'exact', head: true })
          .eq('org_id', org.id)
          .neq('type', 'folder')
          .gte('uploaded_at', sinceIso),
      ]);

      if (teamsRes.error) throw teamsRes.error;
      if (membersRes.error) throw membersRes.error;
      if (storageRowsRes.error) throw storageRowsRes.error;
      if (recentDocsRes.error) throw recentDocsRes.error;

      const storageValue = (storageRowsRes.data || []).reduce((acc, row) => acc + (row.file_size_bytes || 0), 0);

      return {
        id: org.id,
        name: org.name,
        teamsCount: teamsRes.count || 0,
        membersCount: membersRes.count || 0,
        storageUsed: storageValue,
        docsUpdated: recentDocsRes.count || 0,
      };
    }));

    return stats;
  });
}
