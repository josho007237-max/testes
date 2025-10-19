import express from "express";
import crypto from "crypto";

// ===== CONFIG =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;        // ต้องเป็น sk-xxxxxx (ไม่ใช่ sk-proj-)
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const LINE_TOKEN     = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET    = process.env.LINE_CHANNEL_SECRET;
const PORT           = process.env.PORT || 3001;

// ===== Test Mode =====
const MAX_TURNS = 10;            // จำกัด 10 ข้อความ/คน
const OPENAI_TIMEOUT_MS = 8000;  // กันช้า/ค้าง

// โอกาสส่งสติ๊กเกอร์สุ่ม (0.0 - 1.0)
const STICKER_PROBABILITY = 0.35;
const STICKERS = [
  { packageId: "11537", stickerId: "52002768" },
  { packageId: "11539", stickerId: "52114110" },
  { packageId: "11537", stickerId: "52002734" },
  { packageId: "8525",  stickerId: "16581249" }
];

// บุคลิก “พี่พลอย BN9”
const SYSTEM_HINT =
  "คุณคือ 'พี่พลอย BN9' แอดมินผู้ช่วยของ BN9 พูดสุภาพ อบอุ่น เป็นกันเอง " +
  "ใช้อีโมจิน่ารักได้เล็กน้อย และตอบไม่เกิน 3 บรรทัดต่อครั้ง ถ้าไม่แน่ใจให้ถามกลับสุภาพ";

// ข้อความปิดท้ายเมื่อครบ 10
const GOODBYE_TEXT =
  "ขอบคุณที่คุยกับพี่พลอยนะคะ ✨\n" +
  "นี่เป็นแชทบอทตัวเทสของคุณสำเริง ตั้งไว้ **10 ข้อความ** ในการทดลองเท่านั้นค่ะ 💚";

// ===== APP =====
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; }}));

// หน่วยความจำจำกัดรอบต่อผู้ใช้ (RAM)
const turns = new Map(); // userId -> { count:number, ts:number }
setInterval(() => turns.clear(), 24 * 60 * 60 * 1000); // ล้างทุก 24 ชม.

// ===== Helpers =====
function randSticker() {
  return STICKERS[Math.floor(Math.random() * STICKERS.length)];
}

function chunkText(text, maxLen = 350) {
  const parts = [];
  let buf = "";
  for (const w of text.split(/(\s+)/)) {
    if ((buf + w).length > maxLen) {
      parts.push(buf.trim());
      buf = w.trimStart();
    } else {
      buf += w;
    }
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
        temperature: 0.7
      })
    });

    const text = await r.text();
    if (!r.ok) {
      console.error("OpenAI error:", r.status, text);
      throw new Error(`OpenAI ${r.status}`);
    }
    const data = JSON.parse(text);
    return data?.choices?.[0]?.message?.content?.trim() || "โอเคค่ะ";
  } finally {
    clearTimeout(t);
  }
}

async function lineReply(replyToken, messages) {
  return fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages })
  });
}

// ===== HTTP Demo (คงไว้) =====
app.post("/api/chat", async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg) return res.status(400).json({ error: "missing message" });
    const reply = await askOpenAI(msg);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    // ตอบ 200 พร้อมข้อความ fallback เพื่อไม่ให้ client error
    res.status(200).json({ reply: "ขออภัย ตอนนี้ระบบหลักมีปัญหาเล็กน้อยค่ะ 🙏" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// (ตัวเลือก) Endpoint เช็กค่าคอนฟิกแบบ mask — ใช้ชั่วคราวระหว่างตั้งค่า
// app.get("/debug/config", (req, res) => {
//   const mask = (v) => (v ? v.slice(0, 3) + "…" + v.slice(-4) : null);
//   res.json({
//     openaiKeyMasked: mask(process.env.OPENAI_API_KEY || ""),
//     openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
//     hasLineToken: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
//     hasLineSecret: !!process.env.LINE_CHANNEL_SECRET,
//     nodeVersion: process.version,
//   });
// });

// ===== LINE Webhook =====
app.post("/webhooks/line", async (req, res) => {
  try {
    // 1) ตรวจลายเซ็น
    const signature = req.get("x-line-signature");
    if (!LINE_SECRET) {
      console.error("Missing LINE_CHANNEL_SECRET");
      return res.status(200).send("ok"); // อย่าล้ม webhook
    }
    const hmac = crypto.createHmac("sha256", LINE_SECRET);
    hmac.update(req.rawBody || Buffer.from(""));
    const expected = hmac.digest("base64");
    if (signature !== expected) {
      console.warn("bad signature");
      return res.status(200).send("ok");
    }

    // 2) ประมวลผลทุก event แบบกันล้ม
    const { events = [] } = req.body || {};
    await Promise.all(events.map(async (ev) => {
      try {
        if (ev.type !== "message" || ev.message?.type !== "text") return;

        const userId = ev.source?.userId || "anon";
        const textIn = (ev.message.text || "").trim();

        // 3) นับรอบ/จำกัดโควต้า
        const now  = Date.now();
        const info = turns.get(userId) || { count: 0, ts: now };
        info.count += 1;
        info.ts = now;
        turns.set(userId, info);

        if (info.count >= MAX_TURNS) {
          const msgs = [
            { type: "text", text: GOODBYE_TEXT },
            ...(Math.random() < 0.8 ? [{ type: "sticker", ...randSticker() }] : [])
          ];
          await lineReply(ev.replyToken, msgs);
          return;
        }

        // 4) เรียก GPT (กันล่มด้วย fallback)
        let answer = "ขออภัย ระบบกำลังตั้งค่าคีย์ใหม่อยู่ค่ะ 🙏";
        try {
          answer = await askOpenAI(textIn);
        } catch (err) {
          console.error("OpenAI failed:", err?.message);
        }

        // 5) แบ่งตอน + สติ๊กเกอร์สุ่ม
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
    }));

    // 6) ตอบกลับ LINE เสมอ
    return res.status(200).send("ok");
  } catch (e) {
    console.error("LINE webhook fatal:", e);
    return res.status(200).send("ok"); // อย่าปล่อย 500/499
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`✅ BN9 test bot running on :${PORT}`);
});
