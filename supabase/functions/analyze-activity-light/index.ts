import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ── TYPES ──
interface StreamData {
  data: number[];
  series_type: string;
  resolution: string;
}

interface StravaStreams {
  heartrate?: StreamData;
  velocity_smooth?: StreamData;
  cadence?: StreamData;
  distance?: StreamData;
  altitude?: StreamData;
  time?: StreamData;
  ground_contact_time?: StreamData;
  vertical_oscillation?: StreamData;
  stride_length?: StreamData;
}

interface Block {
  start_index: number;
  end_index: number;
  duration_sec: number;
  distance_m: number;
  avg_hr: number;
  max_hr: number;
  avg_pace_min_km: string;
  avg_cadence: number | null;
  cardiac_drift_pct: number | null;
  pace_fade_pct: number | null;
  intensity_vs_base_pct: number;
}

// ── HELPERS ──
function avg(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function msToMinKm(ms: number): string {
  if (!ms || ms <= 0) return "--";
  const secPerKm = 1000 / ms;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function round(n: number, decimals = 2): number {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

// ── STRAVA TOKEN (per gebruiker uit Supabase) ──
async function getStravaToken(
  supabase: ReturnType<typeof createClient>,
  userKey: string
): Promise<string> {
  const { data, error } = await supabase
    .from("coach_light_data")
    .select("content")
    .eq("user_key", userKey)
    .eq("data_type", "strava_tokens")
    .single();

  if (error || !data) {
    throw new Error("Geen Strava-koppeling gevonden voor deze gebruiker.");
  }

  const tokens = data.content as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };

  // Refresh als token binnen 5 minuten verloopt
  if (tokens.expires_at - 300 < Math.floor(Date.now() / 1000)) {
    const res = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("STRAVA_CLIENT_ID_LIGHT")!,
        client_secret: Deno.env.get("STRAVA_CLIENT_SECRET_LIGHT")!,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const fresh = await res.json();

    await supabase
      .from("coach_light_data")
      .update({
        content: {
          ...tokens,
          access_token: fresh.access_token,
          refresh_token: fresh.refresh_token,
          expires_at: fresh.expires_at,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("user_key", userKey)
      .eq("data_type", "strava_tokens");

    return fresh.access_token;
  }

  return tokens.access_token;
}

// ── BLOCK DETECTION ──
const THRESHOLD_FACTOR = 1.05;
const MIN_BLOCK_SEC = 60;
const GAP_TOLERANCE = 20;

function detectBlocks(streams: StravaStreams): Block[] {
  const velocity = streams.velocity_smooth?.data;
  const hr = streams.heartrate?.data;
  const cadence = streams.cadence?.data;
  const distance = streams.distance?.data;

  if (!velocity || velocity.length < 60) return [];

  const baseline = avg(velocity.filter((v) => v > 0));
  const threshold = baseline * THRESHOLD_FACTOR;
  const inBlock = velocity.map((v) => v >= threshold);

  for (let i = 1; i < inBlock.length - 1; i++) {
    if (!inBlock[i]) {
      let gapEnd = i;
      while (gapEnd < inBlock.length && !inBlock[gapEnd]) gapEnd++;
      if (gapEnd - i <= GAP_TOLERANCE) {
        for (let j = i; j < gapEnd; j++) inBlock[j] = true;
      }
    }
  }

  const blocks: Block[] = [];
  let blockStart = -1;

  for (let i = 0; i <= inBlock.length; i++) {
    const active = i < inBlock.length && inBlock[i];
    if (active && blockStart === -1) blockStart = i;
    if (!active && blockStart !== -1) {
      const duration = i - blockStart;
      if (duration >= MIN_BLOCK_SEC) {
        const slice = (arr: number[] | undefined) =>
          arr ? arr.slice(blockStart, i) : [];
        const vSlice = slice(velocity);
        const hrSlice = slice(hr);
        const cdSlice = slice(cadence);

        const distStart = distance ? distance[blockStart] : 0;
        const distEnd = distance ? distance[i - 1] : 0;
        const distM = round(distEnd - distStart, 0);

        let cardiacDrift: number | null = null;
        let paceFade: number | null = null;

        if (hrSlice.length >= 60) {
          const q = Math.floor(hrSlice.length / 4);
          const q1Hr = avg(hrSlice.slice(0, q));
          const q4Hr = avg(hrSlice.slice(-q));
          cardiacDrift = round(((q4Hr - q1Hr) / q1Hr) * 100);
          const q1Pace = avg(vSlice.slice(0, q));
          const q4Pace = avg(vSlice.slice(-q));
          if (q1Pace > 0)
            paceFade = round(((q1Pace - q4Pace) / q1Pace) * 100);
        }

        const avgVelocity = avg(vSlice);
        const intensityPct = round(
          ((avgVelocity - baseline) / baseline) * 100
        );

        let avgCad: number | null = null;
        if (cdSlice.length) {
          const rawCad = avg(cdSlice);
          avgCad = round(rawCad > 60 && rawCad < 120 ? rawCad * 2 : rawCad, 1);
        }

        blocks.push({
          start_index: blockStart,
          end_index: i - 1,
          duration_sec: duration,
          distance_m: distM,
          avg_hr: round(avg(hrSlice), 1),
          max_hr: hrSlice.length ? Math.max(...hrSlice) : 0,
          avg_pace_min_km: msToMinKm(avgVelocity),
          avg_cadence: avgCad,
          cardiac_drift_pct: cardiacDrift,
          pace_fade_pct: paceFade,
          intensity_vs_base_pct: intensityPct,
        });
      }
      blockStart = -1;
    }
  }
  return blocks;
}

// ── OVERALL STATS ──
function overallStats(streams: StravaStreams) {
  const hr = streams.heartrate?.data || [];
  const velocity = streams.velocity_smooth?.data || [];
  const cadence = streams.cadence?.data || [];
  const gct = streams.ground_contact_time?.data || [];
  const vo = streams.vertical_oscillation?.data || [];
  const stride = streams.stride_length?.data || [];

  const activeIndices = velocity
    .map((v, i) => (v > 1 ? i : -1))
    .filter((i) => i !== -1);
  const activeHr = activeIndices.map((i) => hr[i]).filter((v) => v > 0);
  const activeVel = activeIndices.map((i) => velocity[i]);
  const avgVel = avg(activeVel);

  let cardiacDrift: number | null = null;
  let paceFade: number | null = null;

  if (activeHr.length >= 120) {
    const q = Math.floor(activeHr.length / 4);
    const q1Hr = avg(activeHr.slice(0, q));
    const q4Hr = avg(activeHr.slice(-q));
    cardiacDrift = round(((q4Hr - q1Hr) / q1Hr) * 100);
    const q1V = avg(activeVel.slice(0, q));
    const q4V = avg(activeVel.slice(-q));
    if (q1V > 0) paceFade = round(((q1V - q4V) / q1V) * 100);
  }

  let avgCad: number | null = null;
  if (cadence.length) {
    const raw = avg(cadence);
    avgCad = round(raw > 60 && raw < 120 ? raw * 2 : raw, 1);
  }

  const activeGct = activeIndices.map((i) => gct[i]).filter((v) => v > 0);
  const activeVo = activeIndices.map((i) => vo[i]).filter((v) => v > 0);
  const activeStride = activeIndices
    .map((i) => stride[i])
    .filter((v) => v > 0);

  let gct_verval: number | null = null;
  if (activeGct.length >= 60) {
    const q = Math.floor(activeGct.length / 4);
    gct_verval = round(
      ((avg(activeGct.slice(-q)) - avg(activeGct.slice(0, q))) /
        avg(activeGct.slice(0, q))) *
        100
    );
  }

  let vo_verval: number | null = null;
  if (activeVo.length >= 60) {
    const q = Math.floor(activeVo.length / 4);
    vo_verval = round(
      ((avg(activeVo.slice(-q)) - avg(activeVo.slice(0, q))) /
        avg(activeVo.slice(0, q))) *
        100
    );
  }

  const isProgressive =
    cardiacDrift !== null && Math.abs(cardiacDrift) > 10;
  const avgGct = activeGct.length ? round(avg(activeGct), 1) : null;
  const avgVoVal = activeVo.length ? round(avg(activeVo), 1) : null;
  const avgStride = activeStride.length ? round(avg(activeStride), 2) : null;

  let loopeconomie_label = "geen data";
  if (avgGct !== null) {
    if (avgGct < 230) loopeconomie_label = "uitstekend — kort grondcontact";
    else if (avgGct < 260) loopeconomie_label = "goed";
    else if (avgGct < 280) loopeconomie_label = "matig — overstriding risico";
    else loopeconomie_label = "hoog — overstriding aanwezig";
  }

  return {
    avg_hr: round(avg(activeHr), 1),
    max_hr: hr.length ? Math.max(...hr) : null,
    avg_pace_min_km: msToMinKm(avgVel),
    avg_cadence: avgCad,
    cardiac_drift_pct: cardiacDrift,
    pace_fade_pct: paceFade,
    aerobic_decoupling:
      cardiacDrift !== null && paceFade !== null
        ? round(cardiacDrift - paceFade)
        : null,
    data_points: activeHr.length,
    is_progressive_session: isProgressive,
    loopeconomie: {
      avg_ground_contact_time_ms: avgGct,
      avg_vertical_oscillation_cm: avgVoVal,
      avg_stride_length_m: avgStride,
      gct_verval_pct: gct_verval,
      vo_verval_pct: vo_verval,
      label: loopeconomie_label,
    },
  };
}

// ── PACE-HR CORRELATIE ──
// Buckets in m/s (velocity_smooth is m/s)
const PACE_BUCKETS = [
  { label: "<4:30/km", minV: 3.70, maxV: 99 },
  { label: "4:30–5:00/km", minV: 3.33, maxV: 3.70 },
  { label: "5:00–5:30/km", minV: 3.03, maxV: 3.33 },
  { label: "5:30–6:00/km", minV: 2.78, maxV: 3.03 },
  { label: "6:00–6:30/km", minV: 2.56, maxV: 2.78 },
  { label: ">6:30/km",     minV: 0.5,  maxV: 2.56 },
];

function paceHrCorrelatie(pairs: { v: number; hr: number }[]) {
  return PACE_BUCKETS.map(b => {
    const p = pairs.filter(x => x.v >= b.minV && x.v < b.maxV && x.hr > 40);
    if (p.length < 20) return null;
    return { tempo: b.label, avg_hr: round(avg(p.map(x => x.hr)), 1), datapunten: p.length };
  }).filter(Boolean);
}

// ── STREAMS OPHALEN ──
async function fetchStreams(stravaId: string, token: string): Promise<StravaStreams | null> {
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${stravaId}/streams` +
      `?keys=heartrate,velocity_smooth,cadence,distance,altitude,time,ground_contact_time,vertical_oscillation,stride_length&key_by_type=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  return await res.json();
}

// ── SESSIE SAMENVATTEN ──
function formatSessie(id: string, naam: string, datum: string, streams: StravaStreams) {
  const overall = overallStats(streams);
  const blocks = detectBlocks(streams);

  const driftLabel = (pct: number | null, prog = false) => {
    if (pct === null) return "onvoldoende data";
    if (prog && overall.is_progressive_session) return "niet bruikbaar — progressieve training";
    if (pct < 3) return "uitstekend";
    if (pct < 5) return "goed";
    if (pct < 8) return "matig";
    if (pct < 12) return "hoog";
    return "zeer hoog";
  };

  return {
    strava_id: id,
    naam,
    datum: datum.split("T")[0],
    overall: {
      ...overall,
      cardiac_drift_interpretatie: driftLabel(overall.cardiac_drift_pct, true),
      aerobic_decoupling_interpretatie: overall.aerobic_decoupling === null
        ? "onvoldoende data"
        : overall.aerobic_decoupling < 5 ? "HR en pace goed gekoppeld"
        : overall.aerobic_decoupling < 8 ? "lichte ontkoppeling"
        : "duidelijke ontkoppeling",
    },
    blokken: blocks.map((b, i) => ({
      blok: i + 1,
      ...b,
      duur_min: round(b.duration_sec / 60, 1),
      afstand_km: round(b.distance_m / 1000, 2),
      cardiac_drift_interpretatie: driftLabel(b.cardiac_drift_pct),
    })),
    samenvatting: {
      aantal_blokken: blocks.length,
      totale_blok_tijd_min: round(blocks.reduce((s, b) => s + b.duration_sec, 0) / 60, 1),
    },
  };
}

// ── MAIN ──
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const stravaId = url.searchParams.get("strava_id");
  const userKey = url.searchParams.get("user_key");

  if (!userKey) {
    return new Response(
      JSON.stringify({ error: "user_key is verplicht" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let token: string;
  try {
    token = await getStravaToken(supabase, userKey);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: (e as Error).message }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Enkelvoudige activiteit
  if (stravaId) {
    const streams = await fetchStreams(stravaId, token);
    if (!streams) {
      return new Response(
        JSON.stringify({ error: "Strava streams niet beschikbaar", strava_id: stravaId }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const sessie = formatSessie(stravaId, "Activiteit", new Date().toISOString(), streams);
    return new Response(
      JSON.stringify({ activity_name: sessie.naam, start_date: sessie.datum, ...sessie }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Multi-sessie: haal laatste 3 runs op
  const activitiesRes = await fetch(
    "https://www.strava.com/api/v3/athlete/activities?per_page=15&page=1",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!activitiesRes.ok) {
    return new Response(
      JSON.stringify({ error: "Kon Strava-activiteiten niet ophalen", detail: await activitiesRes.text() }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const activities = await activitiesRes.json();
  type StravaActivity = { type: string; sport_type: string; id: number; name: string; start_date: string };
  const runs: StravaActivity[] = activities
    .filter((a: StravaActivity) => a.type === "Run" || a.sport_type === "Run")
    .slice(0, 3);

  if (runs.length === 0) {
    return new Response(
      JSON.stringify({ error: "Geen recente hardloopsessies gevonden op Strava" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Streams parallel ophalen
  const streamsPerRun = await Promise.all(
    runs.map(r => fetchStreams(String(r.id), token))
  );

  const sessies = runs
    .map((r, i) => {
      const s = streamsPerRun[i];
      if (!s) return null;
      return formatSessie(String(r.id), r.name, r.start_date, s);
    })
    .filter(Boolean);

  // Gecombineerde pace-HR correlatie over alle sessies
  const allPairs: { v: number; hr: number }[] = [];
  streamsPerRun.forEach(s => {
    if (!s?.velocity_smooth?.data || !s?.heartrate?.data) return;
    const vel = s.velocity_smooth.data;
    const hr = s.heartrate.data;
    const len = Math.min(vel.length, hr.length);
    for (let i = 0; i < len; i++) {
      if (vel[i] > 0.5) allPairs.push({ v: vel[i], hr: hr[i] });
    }
  });

  const meestRecente = sessies[0];

  return new Response(
    JSON.stringify({
      activity_name: runs[0].name,
      start_date: runs[0].start_date,
      sessies,
      pace_hr_correlatie: paceHrCorrelatie(allPairs),
      // Backward compat: meest recente sessie ook op top-level
      overall: meestRecente?.overall,
      blokken: meestRecente?.blokken,
      samenvatting: meestRecente?.samenvatting,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
