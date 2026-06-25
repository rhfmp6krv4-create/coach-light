import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { code, user_key, redirect_uri } = await req.json();

  if (!code || !user_key || !redirect_uri) {
    return new Response(
      JSON.stringify({ error: "code, user_key en redirect_uri zijn verplicht" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const tokenRes = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("STRAVA_CLIENT_ID")!,
      client_secret: Deno.env.get("STRAVA_CLIENT_SECRET")!,
      code,
      grant_type: "authorization_code",
      redirect_uri,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return new Response(
      JSON.stringify({ error: "Strava token exchange mislukt", detail }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const tokenData = await tokenRes.json();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { error } = await supabase
    .from("coach_light_data")
    .upsert(
      {
        user_key,
        data_type: "strava_tokens",
        content: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: tokenData.expires_at,
          athlete_id: tokenData.athlete?.id,
          athlete_name: tokenData.athlete?.firstname,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_key,data_type" }
    );

  if (error) {
    return new Response(
      JSON.stringify({ error: "Opslaan mislukt", detail: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ success: true, athlete_name: tokenData.athlete?.firstname }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
