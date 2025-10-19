import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

// ============= CONFIG =============
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN      = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_SECRET     = process.env.LINE_CHANNEL_SECRET;
const PORT            = process.env.PORT || 3001;

// จำนวนข้อความ/คนในการทดลอง
const MAX_TURNS = 10;

// โอกาสส่งสติ๊กเกอร์ประกอบ (0.0 - 1.0)
const STICKER_PROBABILITY = 0.35;

// สติ๊กเกอร์ที่สุ่มใช้ (line sticker ids)
const STICKERS = [
  { packageId: "11537", stickerId: "52002768" }, // หัวใจวิ้งๆ
  { packageId: "11539", stickerId: "52114110" }, // โบกมือ
  { packageId: "11537", stickerId: "52002734" }, // ยิ้มตาหวาน
  { packageId: "8525",  stickerId: "16581249" }, // โห่เชียร์
];

// Prompt บุคลิก “พี่พลอย BN9”
const SYSTEM_HINT =
  "คุณคือ “พี่พลอย BN9” แอดมินผู้ช่วยของแบรนด์ BN9 พูดสุภาพ อบอุ่น เป็นกันเอง มีอีโมจิน่ารักเล็กน้อย ไม่ยาวเกิน 3 บรรทัดต่อครั้ง " +
  "ถ้าไม่แน่ใจให้ถามกลับสุภาพ ให้กำลังใจนิดๆ ได้ ใช้คำไทยธรรมชาติ";

const GOODBYE_TEXT =
  "ขอบคุณที่คุยกับพี่พลอยนะคะ ✨\n" +
  "นี่เป็นแชทบอทตัวเทสของคุณสำเริง ตั้งไว้ **10 ข้อความ** ในการทดลองเท่านั้นค่ะ 💚";

// ============= APP SETUP ==========
const app = express();
// เก็บ rawBody เพื่อตรวจลายเซ็น LINE
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; }}));

// ============= MEMORY (per-user turns) ==========
/** { [userId: string]: { count: number, ts: number } } */
const turns = new Map();
// ล้างข้อมูลในความจำทุก 24 ชม. แบบง่ายๆ
setInterval(() => turns.clear(), 24*60*60*1000);

// ============= HELPERS ============
function randSticker() {
  return STICKERS[Math.floor(Math.random()*STICKERS.length)];
}

function chunkText(text, maxLen = 350) {
  // ตัดตามคำ (กันกลางคำ) และใส่หัวเรื่อง (1/2/3) อัตโนมัติภายหลัง
  const parts = [];
  let buf = "";
  for (const word of text.split(/(\s+)/)) {
    if ((buf + word).length > maxLen) {
      parts.push(buf.trim());
      buf = word.trimStart();
    } else {
      buf += word;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

async function askOpenAI(message) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_HINT },
        { role: "user",   content: message }
      ],
      temperature: 0.7,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("OpenAI error:", data);
    throw new Error("OpenAI failed");
  }
  return data?.choices?.[0]?.message?.content || "พี่พลอยตอบไม่ออกค่า 😅";
}

async function lineReply(replyToken, messages){
  return fetch("https://api.line.me/v2/bot/message/reply",{
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

// ============= HTTP DEMO (ยังคงไว้) ============
app.post("/api/chat", async (req, res) => {
  try {
    const msg = req.body?.message;
    if (!msg) return res.status(400).json({ error: "missing message" });
    const reply = await askOpenAI(msg);
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "OpenAI failed" });
  }
});

app.get("/health", (_req,res)=>res.json({ status:"ok" }));

// ============= LINE WEBHOOK ============
app.post("/webhooks/line", async (req, res) => {
  try {
    // ตรวจลายเซ็น
    const signature = req.get("x-line-signature");
    const hmac = crypto.createHmac("sha256", LINE_SECRET);
    hmac.update(req.rawBody);
    if (signature !== hmac.digest("base64")) {
      return res.status(401).send("bad signature");
    }

    const { events = [] } = req.body || {};
    await Promise.all(events.map(async (ev) => {
      if (ev.type !== "message" || ev.message?.type !== "text") return;

      const userId  = ev.source?.userId || "anon";
      const textIn  = ev.message.text?.trim() || "";

      // นับจำนวนรอบ
      const now  = Date.now();
      const info = turns.get(userId) || { count: 0, ts: now };
      info.count += 1;
      info.ts = now;
      turns.set(userId, info);

      // ถ้าเกิน MAX_TURNS ให้บอกปิดทดสอบ
      if (info.count >= MAX_TURNS) {
        const farewellMsgs = [
          { type: "text", text: GOODBYE_TEXT },
          // ใส่สติ๊กเกอร์ปิดท้ายเล็กน้อย
          ...(Math.random()<0.8 ? [{ type:"sticker", ...randSticker() }] : []),
        ];
        await lineReply(ev.replyToken, farewellMsgs);
        return;
      }

      // เรียก GPT
      const gpt = await askOpenAI(textIn);

      // แบ่งตอน 1/2/3
      const parts = chunkText(gpt, 350).slice(0, 3);
      const messages = [];

      // ใส่สติ๊กเกอร์สุ่มขึ้นต้น (น่ารักนิดๆ)
      if (Math.random() < STICKER_PROBABILITY) {
        messages.push({ type: "sticker", ...randSticker() });
      }

      parts.forEach((p, i) => {
        const head = parts.length > 1 ? `(${i+1}/${parts.length}) ` : "";
        // แอบอ้อนเบาๆ บางครั้ง
        const tail = (i === parts.length-1 && Math.random()<0.25) ? " 🩷" : "";
        messages.push({ type:"text", text: `${head}${p}${tail}`.slice(0, 490) });
      });

      // ถ้าสั้นมากและวันนี้ยังไม่ได้อ้อนเลย เพิ่มบรรทัดหวานๆ เบาๆ
      if (messages.filter(m=>m.type==="text").length === 1 && Math.random()<0.25) {
        messages.push({ type:"text", text:"ถ้ายังสงสัยเพิ่มเติม ทักพี่พลอยต่อได้เลยน้า 🤍" });
      }

      await lineReply(ev.replyToken, messages);
    }));

    res.status(200).send("ok");
  } catch (e) {
    console.error("LINE webhook error:", e);
    res.status(500).send("error");
  }
});

// ============= START =============
app.listen(PORT, () => {
  console.log(`✅ BN9 test bot running on :${PORT}`);
});

