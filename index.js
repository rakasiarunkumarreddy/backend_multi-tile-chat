import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import openai from "./openaiClient.js";
import supabase from "./supabaseClient.js";
import razorpay from "./razorpay.js";
import crypto from "crypto";
import { addTokens, getTokens } from "./utils/tokenManager.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const FREE_TOKEN_LIMIT = parseInt(process.env.FREE_TOKEN_LIMIT || "100000");

// 🧠 Log which model is being used
console.log("🧠 Using OpenAI model:", process.env.OPENAI_MODEL);

// 🧩 Smart model fallback
const modelToUse = process.env.OPENAI_MODEL || "gpt-4o-mini";

// 🧠 CHAT ENDPOINT
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, sessionId, tileId, message } = req.body;
    if (!userId || !message)
      return res.status(400).json({ error: "Missing fields" });

    console.log(`📩 Incoming message from user ${userId}: "${message}"`);

    // 🧮 Check token usage
    const usedTokens = await getTokens(userId);
    if (usedTokens >= FREE_TOKEN_LIMIT) {
      console.log(`⚠️ User ${userId} exceeded free token limit.`);
      return res.status(402).json({ error: "quota_exhausted" });
    }

    // ✅ Choose appropriate parameters depending on model
    const params =
      modelToUse.includes("gpt-5-nano")
        ? {
            model: modelToUse,
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful Hinglish assistant. Keep replies short and clear.",
              },
              { role: "user", content: message },
            ],
            max_completion_tokens: 400,
          }
        : {
            model: modelToUse,
            messages: [
              {
                role: "system",
                content:
                  "You are a friendly Hinglish assistant. Answer clearly, simply, and conversationally under 400 words.",
              },
              { role: "user", content: message },
            ],
            max_tokens: 400,
            temperature: 0.8,
          };

    // 💬 Call OpenAI API
    const completion = await openai.chat.completions.create(params);

    // 🪄 Debug logging
    console.log("🔍 Raw OpenAI response:", JSON.stringify(completion, null, 2));

    const aiMessage =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "😅 Mujhe samajh nahi aaya (empty response from model)";
    const tokenCount = completion?.usage?.total_tokens || 0;

    console.log(`🤖 AI reply: "${aiMessage}" (tokens used: ${tokenCount})`);

    // 💾 Save chat to Supabase
    await supabase.from("messages").insert([
      { session_id: sessionId, role: "user", content: message },
      {
        session_id: sessionId,
        role: "assistant",
        content: aiMessage,
        tokens: tokenCount,
      },
    ]);

    // 📊 Update token usage
    const newTotal = await addTokens(userId, tokenCount);

    res.json({
      message: aiMessage,
      tokensUsed: tokenCount,
      totalTokens: newTotal,
    });
  } catch (err) {
    console.error("❌ Chat endpoint error:", err);
    res.status(500).json({ error: "server_error", details: err.message });
  }
});

// 💳 RAZORPAY: Create order
app.post("/api/create-order", async (req, res) => {
  const { userId, plan } = req.body;
  const pricing = { college: 9900, lite: 29900, pro: 59900 }; // in paise
  const amount = pricing[plan];
  if (!amount) return res.status(400).json({ error: "invalid_plan" });

  try {
    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: { userId, plan },
    });

    console.log(
      `💰 Order created for ${userId} — Plan: ${plan}, ₹${amount / 100}`
    );

    await supabase.from("transactions").insert([
      {
        user_id: userId,
        razorpay_order_id: order.id,
        amount,
        currency: "INR",
        status: "created",
      },
    ]);

    res.json({ order });
  } catch (err) {
    console.error("❌ Razorpay order error:", err);
    res.status(500).json({ error: "razorpay_error", details: err.message });
  }
});

// 💳 RAZORPAY: Verify payment
app.post("/api/verify-payment", async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    userId,
  } = req.body;

  try {
    const digest = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (digest !== razorpay_signature) {
      console.warn("⚠️ Invalid Razorpay signature detected.");
      return res.status(400).json({ error: "invalid_signature" });
    }

    await supabase
      .from("transactions")
      .update({ status: "paid", razorpay_payment_id })
      .eq("razorpay_order_id", razorpay_order_id);

    await addTokens(userId, 200000); // Add bonus tokens
    console.log(`✅ Payment verified for user ${userId}. Tokens upgraded.`);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Payment verification error:", err);
    res.status(500).json({ error: "verify_payment_error", details: err.message });
  }
});

// 🩵 Root route
app.get("/", (req, res) => res.send("✅ Multi-Tile Chat Backend Running"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
