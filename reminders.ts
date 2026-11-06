// Masarifi — due-date reminders (Supabase Edge Function "reminders")
// GET  ?action=key           -> { key }  public VAPID application-server key for the browser
// POST { action: "test" }    -> sends a test notification to the signed-in caller's devices
// POST { action: "run" }     -> daily job: notifies every user about unpaid obligations due in 3 days
import * as webpush from "jsr:@negrel/webpush@0.5.0";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

let appServer: webpush.ApplicationServer | null = null;
let publicKey = "";

async function server() {
  if (appServer) return appServer;
  let { data } = await db.from("push_config").select("value").eq("key", "vapid").maybeSingle();
  if (!data) {
    const fresh = await webpush.generateVapidKeys({ extractable: true });
    const exported = await webpush.exportVapidKeys(fresh);
    const ins = await db.from("push_config").insert({ key: "vapid", value: exported });
    if (ins.error) ({ data } = await db.from("push_config").select("value").eq("key", "vapid").single());
    else data = { value: exported };
  }
  const keys = await webpush.importVapidKeys(data!.value, { extractable: false });
  publicKey = await webpush.exportApplicationServerKey(keys);
  appServer = await webpush.ApplicationServer.new({
    contactInformation: "https://ibraheemhaggag.github.io/masarifi/",
    vapidKeys: keys,
  });
  return appServer;
}

type Lang = "ar" | "en" | "de";
const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const MSG: Record<Lang, {
  title: string; locale: string;
  one: (name: string, amt: string, date: string) => string;
  many: (count: number, amt: string, date: string, names: string) => string;
  test: string;
}> = {
  ar: {
    title: "Masarifi · تذكير بالاستحقاق", locale: "ar-EG-u-nu-latn",
    one: (n, a, d) => `«${n}» مستحق بعد ٣ أيام (${d}) — ${a} ر.س`,
    many: (c, a, d, ns) => `عندك ${c} التزامات مستحقة بعد ٣ أيام (${d}) بإجمالي ${a} ر.س: ${ns}`,
    test: "التنبيهات شغّالة ✓ هيوصلك تذكير قبل ميعاد كل التزام بـ ٣ أيام.",
  },
  en: {
    title: "Masarifi · Payment reminder", locale: "en-US",
    one: (n, a, d) => `“${n}” is due in 3 days (${d}) — ${a} SAR`,
    many: (c, a, d, ns) => `${c} obligations are due in 3 days (${d}), totaling ${a} SAR: ${ns}`,
    test: "Reminders are on ✓ You'll be notified 3 days before each due date.",
  },
  de: {
    title: "Masarifi · Zahlungserinnerung", locale: "de-DE",
    one: (n, a, d) => `„${n}“ ist in 3 Tagen fällig (${d}) – ${a} SAR`,
    many: (c, a, d, ns) => `${c} Posten sind in 3 Tagen fällig (${d}), zusammen ${a} SAR: ${ns}`,
    test: "Erinnerungen sind an ✓ Du wirst 3 Tage vor jeder Fälligkeit benachrichtigt.",
  },
};
const langOf = (l: string | null): Lang => (l === "en" || l === "de" ? l : "ar");

function localYmd(tz: string, addDays = 0) {
  let s: string;
  try {
    s = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    s = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + addDays));
  return t.toISOString().slice(0, 10);
}

type Sub = { endpoint: string; user_id: string; subscription: webpush.PushSubscription; lang: string | null; tz: string | null };

async function send(subs: Sub[], payload: Record<string, unknown>) {
  const app = await server();
  let sent = 0;
  for (const s of subs) {
    try {
      await app.subscribe(s.subscription).pushTextMessage(JSON.stringify(payload), { ttl: 86400 } as webpush.PushMessageOptions);
      sent++;
    } catch (e) {
      if (e instanceof webpush.PushMessageError && (e.isGone() || e.response.status === 404)) {
        await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      } else console.error("push failed", s.endpoint.slice(0, 60), String(e));
    }
  }
  return sent;
}

async function runDaily() {
  const { data: subs, error } = await db.from("push_subscriptions").select("endpoint,user_id,subscription,lang,tz");
  if (error) throw error;
  const byUser = new Map<string, Sub[]>();
  for (const s of (subs ?? []) as Sub[]) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s]);
  let users = 0, notified = 0;
  for (const [userId, list] of byUser) {
    users++;
    const tz = list[0].tz || "Asia/Riyadh";
    const target = localYmd(tz, 3);
    const mk = target.slice(0, 7), day = Number(target.slice(8));
    const [ty, tm] = mk.split("-").map(Number);
    const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    const { data: led } = await db.from("ledgers").select("data").eq("user_id", userId).maybeSingle();
    const items = ((led?.data?.months?.[mk]?.items ?? []) as Array<{ name: string; amount: number; day: number; paid: boolean }>)
      .filter((i) => !i.paid && Math.min(Number(i.day) || 1, lastDay) === day);
    if (!items.length) continue;
    const log = await db.from("push_log").insert({ user_id: userId, due_date: target });
    if (log.error) continue; // already reminded for this date
    const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    // group devices by language so each gets its own wording
    const byLang = new Map<Lang, Sub[]>();
    for (const s of list) byLang.set(langOf(s.lang), [...(byLang.get(langOf(s.lang)) ?? []), s]);
    for (const [lg, devs] of byLang) {
      const M = MSG[lg];
      const dateTxt = new Intl.DateTimeFormat(M.locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(target + "T00:00:00Z"));
      const body = items.length === 1
        ? M.one(items[0].name, fmt(Number(items[0].amount) || 0), dateTxt)
        : M.many(items.length, fmt(total), dateTxt, items.map((i) => i.name).join(lg === "ar" ? "، " : ", "));
      notified += await send(devs, { title: M.title, body, tag: "due-" + target, url: "./", lang: lg, dir: lg === "ar" ? "rtl" : "ltr" });
    }
  }
  return { users, notified };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("action") === "key") {
      await server();
      return json({ key: publicKey });
    }
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    if (body.action === "test") {
      // The gateway accepts the public anon key; the signed-in user's token travels in x-user-token and is verified here.
      const jwt = req.headers.get("x-user-token") ?? "";
      if (!jwt) return json({ error: "not signed in" }, 401);
      const { data: u } = await db.auth.getUser(jwt);
      if (!u?.user) return json({ error: "not signed in" }, 401);
      const { data: subs } = await db.from("push_subscriptions").select("endpoint,user_id,subscription,lang,tz").eq("user_id", u.user.id);
      const list = (subs ?? []) as Sub[];
      if (!list.length) return json({ error: "no devices" }, 404);
      const lg = langOf(list[0].lang);
      const sent = await send(list, { title: "Masarifi", body: MSG[lg].test, tag: "test", url: "./", lang: lg, dir: lg === "ar" ? "rtl" : "ltr" });
      return json({ sent });
    }
    if (body.action === "run") return json(await runDaily());
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
