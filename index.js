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
const FREE_TOKEN_LIMIT = parseInt(process.env.FREE_TOKEN_LIMIT || "100000", 10);

// Helper: build request params safely depending on model
function buildParams(model, userMessage, opts = {}) {
  const m = String(model || "").toLowerCase();

  // If model name indicates nano, use nano-safe params
  if (m.includes("gpt-5-nano")) {
    // nanoReasoningLimit: primary then retry smaller
    const nanoLimit = opts.nanoLimit ?? 150;
    return {
      model,
      messages: [
        {
          role: "system",
          content: "You are a friendly Hinglish assistant. Keep responses short, clear, and conversational.",
        },
        { role: "user", content: userMessage },
      ],
      // nano expects completion token param name
      max_completion_tokens: nanoLimit,
    };
  }

  // Fallback: use text-capable models (gpt-4o-mini, etc.)
  return {
    model,
    messages: [
      {
        role: "system",
        content: "You are a friendly Hinglish assistant. Answer clearly, simply, and conversationally under 400 words.",
      },
      { role: "user", content: userMessage },
    ],
    max_tokens: 400,
    temperature: 1.0,
  };
}

// Helper: attempt to call OpenAI with retry/fallback logic
async function callOpenAIWithRetries(userMessage) {
  // Read configured model at runtime (so Render env updates apply after redeploy)
  const configuredModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
  console.log("🧠 Configured OPENAI_MODEL (env):", configuredModel);

  // Attempt order:
  // 1) configuredModel with safe nano/text params
  // 2) if configuredModel is nano and returns empty -> retry nano with smaller limit
  // 3) fallback to gpt-4o-mini (text model)
  const attempts = [
    { model: configuredModel, type: "primary", nanoLimit: 150 },
    { model: configuredModel, type: "nano-retry", nanoLimit: 80 }, // used only if first was nano and empty
    { model: "gpt-4o-mini", type: "fallback", nanoLimit: 150 }, // fallback text model
  ];

  let lastError = null;
  let completion = null;

  // attempt primary
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];

    // Skip nano-retry if primary wasn't nano
    if (attempt.type === "nano-retry" && !String(attempts[0].model).toLowerCase().includes("gpt-5-nano")) {
      continue;
    }

    const params = buildParams(attempt.model, userMessage, { nanoLimit: attempt.nanoLimit });

    try {
      console.log(`🛰️ OpenAI call attempt ${i + 1} with model: ${params.model} params: ${JSON.stringify(params).slice(0, 300)}...`);
      completion = await openai.chat.completions.create(params);
      console.log(`🔍 Raw OpenAI response (attempt ${i + 1}):`, JSON.stringify(completion, null, 2));

      // Check for a text answer
      const candidate = completion?.choices?.[0]?.message?.content?.trim();
      const finishReason = completion?.choices?.[0]?.finish_reason || "unknown";

      // If non-empty content, return it
      if (candidate) {
        console.log(`✅ Model ${params.model} returned text (finish_reason=${finishReason})`);
        return { completion, modelUsed: params.model };
      }

      // If empty content, log and continue to next attempt (retry or fallback)
      console.warn(`⚠️ Model ${params.model} returned empty content (finish_reason=${finishReason}).`);

      // If this was last attempt, break and return empty
      // Otherwise, loop continues to next attempt (nano-retry or fallback)
      lastError = new Error("empty_response");
      continue;
    } catch (err) {
      // Capture and analyze OpenAI error messages to determine fallback behavior
      console.error(`❌ OpenAI error on attempt ${i + 1} with model ${attempt.model}:`, err?.message || err);

      // If invalid model id — immediately try fallback gpt-4o-mini (unless it's already fallback)
      const msg = String(err?.message || "").toLowerCase();
      if ((msg.includes("invalid model") || msg.includes("invalid model id") || msg.includes("unknown model")) && attempt.model !== "gpt-4o-mini") {
        console.warn("⚠️ Invalid model detected. Falling back to gpt-4o-mini.");
        // set next attempt to fallback by continuing
        lastError = err;
        continue;
      }

      // If unsupported parameter error (e.g., max_tokens vs max_completion_tokens), try fallback to gpt-4o-mini
      if (msg.includes("unsupported parameter") || msg.includes("unsupported value")) {
        console.warn("⚠️ Unsupported param or value reported by OpenAI. Falling back to gpt-4o-mini.");
        lastError = err;
        continue;
      }

      // For rate limits or other transient errors, set lastError and let attempts continue
      lastError = err;
      continue;
    }
  }

  // If we reach here, no successful completion
  return { completion: null, modelUsed: null, lastError };
}

// CHAT ENDPOINT
app.post("/api/chat", async (req, res) => {
  try {
    const { userId, sessionId, tileId, message } = req.body;
    if (!userId || !message) return res.status(400).json({ error: "Missing fields" });

    console.log(`📩 Incoming message from user ${userId}: "${message}"`);

    // Check token usage
    const usedTokens = await getTokens(userId);
    if (usedTokens >= FREE_TOKEN_LIMIT) {
      console.log(`⚠️ User ${userId} exceeded free token limit (${usedTokens} >= ${FREE_TOKEN_LIMIT}).`);
      return res.status(402).json({ error: "quota_exhausted" });
    }

    // Call OpenAI with smart retries/fallbacks
    const result = await callOpenAIWithRetries(message);

    const completion = result.completion;
    if (!completion) {
      console.error("❌ All OpenAI attempts failed or returned empty. lastError:", result.lastError);
      // Return user-friendly error
      return res.status(500).json({ error: "model_failure", details: result.lastError?.message || "no_response_from_model" });
    }

    // Extract final aiMessage
    const aiMessage = completion?.choices?.[0]?.message?.content?.trim() || "😅 Mujhe samajh nahi aaya (empty response after retries)";
    const tokenCount = completion?.usage?.total_tokens || 0;

    console.log(`🤖 AI reply: "${aiMessage}" (tokens used: ${tokenCount})`);

    // Save to Supabase (safe: don't block response on DB failure)
    try {
      await supabase.from("messages").insert([
        { session_id: sessionId, role: "user", content: message },
        { session_id: sessionId, role: "assistant", content: aiMessage, tokens: tokenCount },
      ]);
    } catch (dbErr) {
      console.error("❌ Supabase insert error:", dbErr);
    }

    // Update token usage (safe)
    try {
      await addTokens(userId, tokenCount);
    } catch (tokErr) {
      console.error("❌ addTokens error:", tokErr);
    }

    // Return success
    const totalTokens = await getTokens(userId).catch(() => null);
    res.json({ message: aiMessage, tokensUsed: tokenCount, totalTokens });
  } catch (err) {
    console.error("❌ Chat endpoint error (final):", err);
    res.status(500).json({ error: "server_error", details: err?.message || String(err) });
  }
});

// RAZORPAY: Create order
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

    console.log(`💰 Order created for ${userId} — Plan: ${plan}, ₹${amount / 100}`);

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
    res.status(500).json({ error: "razorpay_error", details: err?.message || String(err) });
  }
});

// RAZORPAY: Verify payment
app.post("/api/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId } = req.body;

  try {
    const digest = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");

    if (digest !== razorpay_signature) {
      console.warn("⚠️ Invalid Razorpay signature detected.");
      return res.status(400).json({ error: "invalid_signature" });
    }

    await supabase.from("transactions").update({ status: "paid", razorpay_payment_id }).eq("razorpay_order_id", razorpay_order_id);

    await addTokens(userId, 200000); // Add bonus tokens
    console.log(`✅ Payment verified for user ${userId}. Tokens upgraded.`);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Payment verification error:", err);
    res.status(500).json({ error: "verify_payment_error", details: err?.message || String(err) });
  }
});

// Root route
app.get("/", (req, res) => res.send("✅ Multi-Tile Chat Backend Running"));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
