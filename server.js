import express from "express";
import crypto from "crypto";

// ===== CONFIG =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const LINE_TOKEN     = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET    = process.env.LINE_CHANNEL_SECRET;
const PORT           = process.env.PORT || 3001;

// ===== TEST MODE =====
const MAX_TURNS = 10;
const OPENAI_TIMEOUT_MS = 5000;
const STICKER_PROBABILITY = 0.35;
const STICKERS = [
  { packageId: "11537", stickerId: "52002768" },
  { packageId: "11539", stickerId: "52114110" },
  { packageId: "11537", stickerId: "52002734" },
  { packageId: "8525",  stickerId: "16581249" }
];

// ===== PERSONALITY =====
const SYSTEM_HINT =
  "คุณคือ 'พี่พลอย BN9' แอดมินผู้ช่วยของ BN9 ที่พูดจาอบอุ่น สดใส และเป็นกันเองสุด ๆ \
ใส่อีโมจิน่ารักได้บ้าง (เช่น 💚✨🩷) แต่ไม่เยอะเกินไป ตอบไม่เกิน 3 บรรทัดต่อครั้ง \
ถ้าไม่แน่ใจให้ถามกลับด้วยความสุภาพ เช่น 'ขอพี่พลอยดูรายละเอียดเพิ่มอีกนิดได้ไหมคะ 💚'";

const GOODBYE_TEXT =
  "ขอบคุณที่คุยกับพี่พลอยนะคะ ✨\nนี่เป็นแชทบอทตัวเทสของคุณสำเริง 💚\nตั้งไว้ 10 ข้อความต่อวันสำหรับทดลองค่ะ 💫";

const LIMIT_TEXT =
  "อุ๊ยย หมดรอบแล้วค่ะ 🩷\nนี่คือ *เดโม่บอทของคุณสำเริง แซ่ห่อ* สำหรับทดสอบระบบเท่านั้นนะคะ 🎀\nไว้คุยกันใหม่รอบหน้าจ้า 💚";

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; }}));

// หน่วยความจำจำกัดรอบต่อผู้ใช้ (รีเซ็ตทุก 24 ชม.)
const turns = new Map();
setInterval(() => turns.clear(), 24 * 60 * 60 * 1000);

// ===== Helpers =====
function randSticker() {
  return STICKERS[Math.floor(Math.random() * STICKERS.length)];
}
function chunkText(text, maxLen = 350) {
  const parts = []; let buf = "";
  for (const w of text.split(/(\s+)/)) {
    if ((buf + w).length > maxLen) { parts.push(buf.trim()); buf = w.trimStart(); }
    else buf += w;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

async function askOpenAI(message) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_HINT },
          { role: "user",   content: message }
        ],
        temperature: 0.8,
        max_tokens: 150
      })
    });
    const text = await r.text();
    if (!r.ok) {
      console.error("OpenAI error:", r.status, text);
      throw new Error(`OpenAI ${r.status}`);
    }
    const data = JSON.parse(text);
    return data?.choices?.[0]?.message?.content?.trim() || "โอเคค่ะ 💚";
  } finally { clearTimeout(t); }
}

async function lineReply(replyToken, messages) {
  return fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages })
  });
}

// ===== HEALTH =====
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ===== WEBHOOK =====
app.post("/webhooks/line", (req, res) => {
  try {
    const signature = req.get("x-line-signature");
    const hmac = crypto.createHmac("sha256", LINE_SECRET);
    hmac.update(req.rawBody || Buffer.from(""));
    if (signature !== hmac.digest("base64")) return res.status(200).send("ok");

    const { events = [] } = req.body || {};
    res.status(200).send("ok"); // ✅ ส่งกลับไว กัน 499

    // ทำงานจริงหลังบ้าน
    queueMicrotask(async () => {
      for (const ev of events) {
        try {
          if (ev.type !== "message" || ev.message?.type !== "text") continue;
          const userId = ev.source?.userId || "anon";
          const textIn = (ev.message.text || "").trim();

          const now  = Date.now();
          const info = turns.get(userId) || { count: 0, ts: now };
          info.count += 1; info.ts = now;
          turns.set(userId, info);

          // ===== จำกัดจำนวนต่อวัน =====
          if (info.count > MAX_TURNS) {
            const msgs = [
              { type: "text", text: LIMIT_TEXT },
              { type: "sticker", ...randSticker() }
            ];
            await lineReply(ev.replyToken, msgs);
            continue;
          }

          // ===== ถ้าถึงรอบสุดท้าย =====
          if (info.count === MAX_TURNS) {
            const msgs = [
              { type: "text", text: GOODBYE_TEXT },
              ...(Math.random() < 0.8 ? [{ type: "sticker", ...randSticker() }] : [])
            ];
            await lineReply(ev.replyToken, msgs);
            continue;
          }

          // ===== ปกติ =====
          let answer = "ขอพี่พลอยเช็กให้นะคะ 💚";
          try { answer = await askOpenAI(textIn); }
          catch (err) { console.error("OpenAI failed:", err?.message); }

          const parts = chunkText(answer, 350).slice(0, 3);
          const messages = [];

          if (Math.random() < STICKER_PROBABILITY) {
            messages.push({ type: "sticker", ...randSticker() });
          }

          parts.forEach((p, i) => {
            const head = parts.length > 1 ? `(${i + 1}/${parts.length}) ` : "";
            const tail = (i === parts.length - 1 && Math.random() < 0.25) ? " 🩷" : "";
            messages.push({ type: "text", text: `${head}${p}${tail}`.slice(0, 490) });
          });

          await lineReply(ev.replyToken, messages);
        } catch (inner) {
          console.error("handle event error:", inner);
        }
      }
    });
  } catch (e) {
    console.error("LINE webhook fatal:", e);
    try { res.status(200).send("ok"); } catch {}
  }
});

// ===== START =====
app.listen(PORT, () => console.log(`✅ BN9 test bot running on :${PORT}`));
