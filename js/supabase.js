import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://bchlhvgddguhjtgfenmo.supabase.co';

// =====================================================================
// IMPORTANTE: sustituir el placeholder por la publishable key real del
// proyecto pdli-clases (Supabase Dashboard → Settings → API → anon key).
// La key vive en cliente — usa siempre la "publishable" (anon),
// nunca la service_role.
// =====================================================================
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_mVaO8PaXBm6ZxSSapBLLIg_IZzapkTL';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
