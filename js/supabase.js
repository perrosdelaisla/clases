import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://sydzfwwiruxqaxojymdz.supabase.co';

// =====================================================================
// Publishable key de Victoria (proyecto sydzfwwiruxqaxojymdz,
// Supabase Dashboard → Settings → API → anon key).
// La key vive en cliente — usa siempre la "publishable" (anon),
// nunca la service_role.
// =====================================================================
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_-ooEdkLOkFgPlHp4zhaqjQ_0cBVQJ3B';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
