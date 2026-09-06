"use client";
// Browser-side Supabase client — anon key only, exactly like every
// other client-side Supabase usage in this repo (see trading.html's
// SB_ANON constant). Never put the service-role key anywhere this
// module's import graph reaches.
import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
