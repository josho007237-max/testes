import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

// เก็บ raw body ไว้ตรวจลายเซ็น LINE
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

// ---- OpenAI helper (ใช้ซ้ำ) ----
async function askOpenAI(message) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "คุณคือพี่พลอย BN9 แอดมินผู้ช่วย พูดสุภาพ อบอุ่น" },
        { role: "user", content: message }
      ],
    }),
  });
  const data = await r.json();
  return data?.choices?.[0]?.message?.content || "พี่พลอยตอบไม่ออกค่า 😅";
}

// ---- เดโม API ตรง ๆ (/api/chat) ----
app.post("/api/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "missing message" });
  try {
    const reply = await askOpenAI(message);
    res.json({ reply });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "OpenAI failed" });
  }
});

// ---- LINE Webhook ----
app.post("/webhooks/line", async (req, res) => {
  try {
    // 1) ตรวจลายเซ็น
    const signature = req.get("x-line-signature");
    const hmac = crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET);
    hmac.update(req.rawBody);
    const expected = hmac.digest("base64");
    if (signature !== expected) return res.status(401).send("bad signature");

    // 2) วนทุก event
    const { events = [] } = req.body || {};
    await Promise.all(events.map(async (ev) => {
      if (ev.type !== "message" || ev.message?.type !== "text") return;

      const userText = ev.message.text || "";
      const replyText = await askOpenAI(userText);

      // 3) ตอบกลับไปที่ LINE
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: ev.replyToken,
          messages: [{ type: "text", text: replyText.slice(0, 490) }],
        }),
      });
    }));

    res.status(200).send("ok");
  } catch (e) {
    console.error("LINE webhook error:", e);
    res.status(500).send("error");
  }
});

// ---- Health ----
app.get("/health", (_req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("✅ Chat backend ready on port", PORT));

