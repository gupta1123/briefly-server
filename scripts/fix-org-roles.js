import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const defaults = [
    { key: 'orgAdmin', name: 'Organization Admin', is_system: true, permissions: {
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
    } },
    { key: 'contentManager', name: 'Content Manager', is_system: true, permissions: {
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
    } },
    { key: 'member', name: 'Member', is_system: true, permissions: {
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
      'documents.bulk_delete': false,
      'storage.upload': true,
      'search.semantic': true,
      'chat.save_sessions': false,
      'audit.read': false,
    } },
    { key: 'teamLead', name: 'Team Lead', is_system: true, permissions: {
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
      'documents.bulk_delete': false,
      'storage.upload': true,
      'search.semantic': true,
      'chat.save_sessions': false,
      'audit.read': true,
      'departments.read': true,
      'departments.manage_members': true,
    } },
    { key: 'contentViewer', name: 'Content Viewer', is_system: true, permissions: {
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
    } },
    { key: 'guest', name: 'Guest', is_system: true, permissions: {
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
    } },
  ];

  const { data: orgs, error } = await admin.from('organizations').select('id');
  if (error) throw error;
  for (const org of orgs || []) {
    const rows = defaults.map((r) => ({ org_id: org.id, key: r.key, name: r.name, is_system: r.is_system, permissions: r.permissions }));
    const { error: upErr } = await admin.from('org_roles').upsert(rows, { onConflict: 'org_id,key' });
    if (upErr) {
      console.error('Upsert failed for org', org.id, upErr.message);
    } else {
      console.log('Seeded roles for org', org.id);
    }
  }

  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });

