/**
 * Basyouni Port AI — Cloudflare Worker (Backend Demo) — Gemini Edition
 * ---------------------------------------------------------------
 * المطلوب من إعدادات الـ Worker (Variables and Secrets):
 *   GEMINI_API_KEY = مفتاحك من aistudio.google.com (مجاني)
 * ---------------------------------------------------------------
 * Endpoints:
 *   POST /api/parse  ← PDF/صورة (صفحة أو صفحتين) → بيانات مستخرجة بالـ AI
 *   POST /api/fill   ← محاكاة تفريغ (Demo) مع Screenshot وهمي
 *   POST /api/feedback + GET /api/feedback ← تقييمات (Workers KV)
 */

const GEMINI_URL = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
// فري تير 2026: gemini-3-flash (~1,500 طلب/يوم، 10 RPM) — لو الموديل مش متاح في منطقتك جرّب gemini-2.5-flash
const MODEL = "gemini-3-flash";

// ── حماية بسيطة من الإسراف (Rate Limit): 15 طلب/دقيقة لكل IP ──
const hits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 60_000);
  if (arr.length >= 8) return false; // 8/دقيقة — آمن تحت حد Gemini 10 RPM
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // تنظيف الذاكرة
  return true;
}

function cors(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

const SYSTEM_PROMPT = `You are a maritime shipping document OCR expert.
Extract fields from the shipping document image and return STRICT JSON only (no markdown, no explanation) in this exact format:
{
  "ok": true,
  "summary": "One short sentence describing the shipment in English",
  "data": {
    "bl_reference": "", "shipper": "", "shipper_phone": "", "shipper_tax": "",
    "consignee": "", "consignee_tax": "", "notify_name": "", "notify_phone": "",
    "vessel": "", "pol": "", "pod": "", "destination_port": "",
    "container_no": "", "container_type": "", "description": "", "hs_code": "",
    "incoterms": "", "terms": "", "date_of_issue": "", "issue_place": "", "forwarder": "", "signatory": ""
  }
}
Rules:
- Keep original values exactly as written (names, numbers, codes).
- If a field is missing, set it to null (not empty string).
- date_of_issue as YYYY-MM-DD.
- hs_code keep dots.
- The user message may contain 1 or 2 document page images (page 1 first, page 2 second). Merge info from all pages.
- Return ONLY the JSON object.`;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors({ ok: true });
    const url = new URL(request.url);

    // ─────────── 1) استخراج البيانات بالـ AI ───────────
    if (url.pathname === "/api/parse" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      if (!rateLimit(ip)) return cors({ ok: false, error: "Too many requests — wait a minute and retry." }, 429);
      if (!env.GEMINI_API_KEY) return cors({ ok: false, error: "GEMINI_API_KEY is not set in Worker settings." }, 500);

      try {
        const form = await request.formData();
        const file = form.get("file");
        const file2 = form.get("file2"); // الصفحة التانية لو الملف PDF (متكون من صور جاهزة)
        if (!file) return cors({ ok: false, error: "No file uploaded." }, 400);

        const toB64 = async (f) => {
          const m = f.type || "image/png";
          if (!m.startsWith("image/")) {
            throw new Error("Demo mode: please upload a PDF or an IMAGE (PNG/JPG/WEBP) of the shipping document.");
          }
          const b = new Uint8Array(await f.arrayBuffer());
          let bin = "";
          for (let i = 0; i < b.length; i += 8192) bin += String.fromCharCode(...b.subarray(i, i + 8192));
          return { mime: m, b64: btoa(bin) };
        };

        const img1 = await toB64(file);
        const img2 = file2 ? await toB64(file2) : null;

        const geminiRes = await fetch(GEMINI_URL(MODEL), {
          method: "POST",
          headers: {
            "x-goog-api-key": env.GEMINI_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: SYSTEM_PROMPT + "\n\nExtract the shipping document fields from the page image(s). Page 1 first, page 2 second (if present). Merge info from all pages." },
                { inline_data: { mime_type: img1.mime, data: img1.b64 } },
                ...(img2 ? [{ inline_data: { mime_type: img2.mime, data: img2.b64 } }] : []),
              ],
            }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0,
              maxOutputTokens: 2048,
            },
          }),
        });

        if (!geminiRes.ok) {
          const errJson = await geminiRes.json().catch(() => null);
          const msg = errJson?.error?.message || `AI provider error (${geminiRes.status}). Try again.`;
          return cors({ ok: false, error: msg }, geminiRes.status === 429 ? 429 : 502);
        }

        const geminiJson = await geminiRes.json();
        let raw = geminiJson.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "{}";
        raw = raw.replace(/```(?:json)?/gi, "").trim();
        const parsed = JSON.parse(raw);

        if (!parsed.data || typeof parsed.data !== "object") {
          return cors({ ok: false, error: "AI could not read this document clearly. Try a sharper image." }, 422);
        }

        // تنظيف: استبدال null بقيم فاضية عشان الواجهة
        const data = {};
        for (const [k, v] of Object.entries(parsed.data)) data[k] = v ?? "";

        return cors({
          ok: true,
          summary: parsed.summary || "Shipping data extracted successfully.",
          data,
        });
      } catch (e) {
        return cors({ ok: false, error: "Parse failed: " + (e.message || e) }, 500);
      }
    }

    // ─────────── 2) محاكاة التفريغ (Demo) ───────────
    if (url.pathname === "/api/fill" && request.method === "POST") {
      try {
        const { url: target, data } = await request.json();
        if (!target) return cors({ ok: false, error: "Target URL is required." }, 400);
        if (!data || typeof data !== "object") return cors({ ok: false, error: "No extracted data provided." }, 400);

        const filledFields = Object.entries(data)
          .filter(([, v]) => v && String(v).trim() !== "")
          .map(([k]) => k);

        // Screenshot وهمي (SVG) يعرض البيانات — بيشتغل في وسم <img> مباشرة
        const rows = filledFields.slice(0, 12).map((k, i) =>
          `<text x="30" y="${110 + i * 26}" font-family="monospace" font-size="13" fill="#0F2A3D"><tspan fill="#0E7BB8" font-weight="bold">${k}</tspan> : ${String(data[k]).replace(/&/g,"&amp;").replace(/</g,"&lt;")}</text>`
        ).join("");
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${140 + Math.min(filledFields.length,12)*26}">
          <rect width="100%" height="100%" fill="#F4F7FA"/>
          <rect x="10" y="10" width="620" height="60" rx="10" fill="#0F2A3D"/>
          <text x="30" y="47" font-family="sans-serif" font-size="18" font-weight="bold" fill="#12B8A6">✅ Demo Discharge — Basyouni AI</text>
          ${rows}
          <text x="30" y="${140 + Math.min(filledFields.length,12)*26 - 14}" font-family="sans-serif" font-size="11" fill="#93A5B8">Target: ${target.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</text>
        </svg>`;
        const screenshot = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));

        return cors({ ok: true, fields: filledFields, screenshot });
      } catch (e) {
        return cors({ ok: false, error: "Fill failed: " + (e.message || e) }, 500);
      }
    }

// ─────────── 3) استقبال التقييمات (Workers KV) ───────────
    if (url.pathname === "/api/feedback" && request.method === "POST") {
      if (!env.FEEDBACK) return cors({ ok: false, error: "KV binding FEEDBACK is not set." }, 500);
      try {
        const body = await request.json().catch(() => null);
        if (!body || !body.rating || body.rating < 1 || body.rating > 5) {
          return cors({ ok: false, error: "Rating (1-5) is required." }, 400);
        }
        const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        await env.FEEDBACK.put(id, JSON.stringify({
          rating: body.rating,
          comment: String(body.comment || "").slice(0, 500),
          lang: String(body.lang || "").slice(0, 10),
          ts: new Date().toISOString(),
          ip,
        }));
        return cors({ ok: true });
      } catch (e) {
        return cors({ ok: false, error: "Feedback failed: " + (e.message || e) }, 500);
      }
    }

    // ─────────── 4) صفحة الأدمن — تشوف كل التقييمات ───────────
    if (url.pathname === "/api/feedback" && request.method === "GET") {
      if (!env.FEEDBACK) return cors({ ok: false, error: "KV binding FEEDBACK is not set." }, 500);
      if (url.searchParams.get("key") !== env.ADMIN_KEY) {
        return cors({ ok: false, error: "Unauthorized. Add ?key=YOUR_ADMIN_KEY" }, 401);
      }
      const listed = await env.FEEDBACK.list();
      const items = await Promise.all(listed.keys.map(k => env.FEEDBACK.get(k.name, "json")));
      items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      const avg = items.length ? (items.reduce((s, x) => s + x.rating, 0) / items.length).toFixed(2) : 0;
      // صفحة HTML بسيطة للعرض
      const rows = items.map(x =>
        `<tr><td>${x.rating}⭐</td><td>${(x.comment||"").replace(/</g,"&lt;")}</td><td>${x.lang||""}</td><td>${x.ts||""}</td></tr>`
      ).join("");
      const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Basyouni Feedback</title>
        <style>body{font-family:sans-serif;max-width:900px;margin:30px auto;padding:0 16px}
        h1{font-size:20px}table{width:100%;border-collapse:collapse;font-size:13px}
        td,th{border:1px solid #ddd;padding:8px;text-align:start}th{background:#f4f7fa}
        .avg{background:#12B8A6;color:#fff;padding:6px 16px;border-radius:20px;display:inline-block;font-weight:bold}</style>
        </head><body><h1>📊 Basyouni Demo Feedback (${items.length} تقييم)</h1>
        <p class="avg">متوسط التقييم: ${avg} ⭐</p>
        <table><tr><th>التقييم</th><th>الرأي</th><th>اللغة</th><th>الوقت</th></tr>${rows}</table>
        </body></html>`;
      return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return cors({ ok: true, message: "Basyouni Port AI API is running 🚢" });
  },
};
