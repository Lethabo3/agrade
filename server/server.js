const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());

if (!process.env.SUPABASE_SERVICE_KEY) {
  console.error("FATAL: SUPABASE_SERVICE_KEY is not set");
  process.exit(1);
}

const supabase = createClient(
  "https://llabvdbcvilnbukroqxn.supabase.co",
  process.env.SUPABASE_SERVICE_KEY
);

const FREE_LIMIT = 5;

async function getUserFromToken(token) {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  console.log("getUserFromToken error:", error?.message ?? "none");
  if (error || !data.user) return null;
  return data.user;
}

async function getSubscription(userId) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  console.log("getSubscription error:", error?.message ?? "none");
  return data;
}

async function checkAndIncrementUsage(userId) {
  const { data: usage, error: usageError } = await supabase
    .from("message_usage")
    .select("*")
    .eq("user_id", userId)
    .single();

  console.log("checkAndIncrementUsage read error:", usageError?.message ?? "none");

  if (usageError && usageError.code !== "PGRST116") {
    throw new Error(`DB read failed: ${usageError.message}`);
  }

  const now = new Date();

  if (!usage) {
    await supabase.from("message_usage").insert({
      user_id: userId,
      message_count: 1,
      last_reset: now.toISOString(),
    });
    return { allowed: true, remaining: FREE_LIMIT - 1 };
  }

  const lastReset = new Date(usage.last_reset);
  const hoursSinceReset = (now - lastReset) / (1000 * 60 * 60);

  if (hoursSinceReset >= 24) {
    await supabase
      .from("message_usage")
      .update({ message_count: 1, last_reset: now.toISOString() })
      .eq("user_id", userId);
    return { allowed: true, remaining: FREE_LIMIT - 1 };
  }

  if (usage.message_count >= FREE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  await supabase
    .from("message_usage")
    .update({ message_count: usage.message_count + 1 })
    .eq("user_id", userId);

  return { allowed: true, remaining: FREE_LIMIT - usage.message_count - 1 };
}

async function handleReferral(referrerId, referredId) {
  if (!referrerId || !referredId) return;

  await supabase.from("referrals").insert({
    referrer_id: referrerId,
    referred_id: referredId,
  });

  const { count } = await supabase
    .from("referrals")
    .select("*", { count: "exact", head: true })
    .eq("referrer_id", referrerId);

  if (count >= 2) {
    const existing = await getSubscription(referrerId);
    if (!existing) {
      await supabase.from("subscriptions").upsert({
        user_id: referrerId,
        plan: "weekly",
        status: "active",
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: "user_id" });
    }
  }
}

/** First balanced `{...}` in text (handles strings); safer than greedy /\{[\s\S]*\}/ */
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const ANALYZE_SYSTEM_PROMPT = `You are a quiz answering assistant analyzing a screenshot of a quiz page.
The page may show SEVERAL questions at once; the user may need to scroll to see them all.

You MUST respond with ONLY a raw JSON object. No markdown, no backticks, no explanation.

PRIORITY: Identify the single TOPMOST multiple-choice or text-input question that still needs an answer
(a clear selection is not yet made for that question). Ignore questions below it for this response.

IMPORTANT: Options may be full sentences.
- Copy the answer field EXACTLY as the full option text appears on screen, word for word.
- option_index (multiple_choice only): Number EVERY visible radio/circle choice from the TOP of the
  viewport DOWNWARD, across ALL question groups in order (1 = topmost choice on screen,
  then 2, 3, …). Return the 1-based index of the ONE choice that should be selected for that
  first unanswered question (may be up to ~24 if many options appear).

Format: {"answer":"exact full text of correct option","type":"multiple_choice","confidence":0.95,"option_index":6}
For text input: {"answer":"word or phrase to type","type":"text_input","confidence":0.95,"option_index":null}

If there is no unanswered question in the current view (all visible ones appear answered, or no quiz UI):
{"answer":"","type":"multiple_choice","confidence":0,"option_index":null}`;

async function callGroq(messages, model = "meta-llama/llama-4-scout-17b-16e-instruct", maxTokens = 512) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  const data = await response.json();
  console.log("Groq status:", response.status, "model:", model);
  if (!data.choices?.[0]?.message?.content) {
    console.error("Groq bad response:", JSON.stringify(data));
    throw new Error("No content from Groq");
  }
  return data.choices[0].message.content;
}

app.get("/", (req, res) => res.status(200).send("ok"));

app.get("/download", (req, res) => {
  res.redirect("https://github.com/Lethabo3/agrade/releases/latest/download/agrade_0.1.0_x64-setup.exe");
});

app.get("/health", async (req, res) => {
  const { data, error } = await supabase.from("message_usage").select("count").limit(1);
  if (error) return res.status(500).json({ db: "error", detail: error.message });
  res.json({ db: "ok", data });
});

// ── /analyze — returns correct answer as JSON ──────────────────────────────
app.post("/analyze", express.json({ limit: "10mb" }), async (req, res) => {
  try {
    const { base64Image } = req.body;
    const token = req.headers.authorization?.replace("Bearer ", "");

    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    const subscription = await getSubscription(user.id);
    if (!subscription) {
      const usage = await checkAndIncrementUsage(user.id);
      if (!usage.allowed) return res.status(429).json({ error: "Limit reached" });
    }

    if (!base64Image) return res.status(400).json({ error: "No image provided" });

    const raw = await callGroq([
      {
        role: "system",
        content: ANALYZE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
          { type: "text", text: "What is the correct answer? Respond with JSON only." },
        ],
      },
    ], "meta-llama/llama-4-maverick-17b-16e-instruct", 150);

    console.log("Analyze raw response:", raw);

    // Strip any markdown fences just in case
    const clean = raw.replace(/```json|```/gi, "").trim();

    const jsonStr = extractFirstJsonObject(clean);
    if (!jsonStr) {
      console.error("No JSON found in analyze response:", clean);
      return res.status(500).json({ error: "Could not parse answer" });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      console.error("JSON.parse failed:", e.message, jsonStr.slice(0, 200));
      return res.status(500).json({ error: "Could not parse answer" });
    }
    console.log("Analyze parsed:", parsed);
    res.json(parsed);
  } catch (err) {
    console.error("Analyze error:", err.message);
    res.status(500).json({ error: "Analysis failed: " + err.message });
  }
});

// ── /locate — finds coordinates of a specific text on screen ──────────────
app.post("/locate", express.json({ limit: "10mb" }), async (req, res) => {
  try {
    const { base64Image, text } = req.body;
    const token = req.headers.authorization?.replace("Bearer ", "");

    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    if (!base64Image || !text) return res.status(400).json({ error: "Missing image or text" });

    const raw = await callGroq([
      {
        role: "system",
        content: `You are a screen coordinate finder. Given a screenshot and a target text, find where that text appears on screen and return its center coordinates as normalized values (0.0 to 1.0).
You MUST respond with ONLY a raw JSON object. No markdown, no explanation.
Format: {"x":0.35,"y":0.52,"found":true}
If you cannot find the text, return: {"x":0.5,"y":0.5,"found":false}`,
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
          { type: "text", text: `Find the clickable element with text: "${text}". Return its center coordinates as JSON.` },
        ],
      },
    ], "meta-llama/llama-4-maverick-17b-16e-instruct", 100);

    console.log("Locate raw response:", raw);
    const clean = raw.replace(/```json|```/gi, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ x: 0.5, y: 0.5, found: false });

    const parsed = JSON.parse(jsonMatch[0]);
    res.json(parsed);
  } catch (err) {
    console.error("Locate error:", err.message);
    res.status(500).json({ error: "Locate failed" });
  }
});

// ── /ask — main chat + automation endpoint ─────────────────────────────────
app.post("/ask", express.json({ limit: "10mb" }), async (req, res) => {
  try {
    const { base64Image, message, history = [], jsonAnalyze = false } = req.body;
    const token = req.headers.authorization?.replace("Bearer ", "");

    console.log("TOKEN:", token ? "present" : "missing");
    console.log("MESSAGE:", message);
    console.log("HAS IMAGE:", !!base64Image);

    const user = await getUserFromToken(token);
    console.log("USER:", user ? user.id : "null");

    if (!user) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Please sign in to use agrade.",
      });
    }

    const subscription = await getSubscription(user.id);
    const isPro = !!subscription;

    if (!isPro) {
      const usage = await checkAndIncrementUsage(user.id);
      if (!usage.allowed) {
        return res.status(429).json({
          error: "Limit reached",
          message: "You've used your 5 free messages. Upgrade to Pro for unlimited access.",
        });
      }
    }

    const hasImage = !!base64Image;
    const isAutoFollowUp = typeof message === "string" && message.startsWith("[AUTO]");

    let systemContent;
    if (jsonAnalyze && hasImage) {
      // Same behavior as /analyze so the app's fallback can actually parse JSON.
      systemContent = ANALYZE_SYSTEM_PROMPT;
    } else if (!hasImage) {
      systemContent = `You are agrade, a helpful AI assistant. Be concise and direct. Answer the user's question clearly. If they mention their screen or want to share it, remind them to use the camera button or Ctrl+Shift+G.`;
    } else if (isAutoFollowUp) {
      systemContent = `You are agrade, a screen automation agent running in autonomous mode.

AUTONOMOUS LOOP — NO HUMAN PRESENT:
- Study the screenshot carefully.
- If there are unanswered questions or incomplete steps, handle them with action tags.
- If the task is fully complete, respond with exactly: TASK_COMPLETE
- Do not explain. Do not ask questions. Just act.

ACTION TAGS (append after any text):
[ACTION:click:X:Y]    — click at normalized 0.0-1.0 coordinates
[ACTION:type:text]    — type into focused field
[ACTION:wait:ms]      — wait milliseconds
[ACTION:screenshot]   — capture screen

COORDINATES: normalized 0.0-1.0, top-left=(0,0), bottom-right=(1,1). Estimate element centers.
Keep response under 2 sentences. Action tags must be last.`;
    } else {
      systemContent = `You are agrade, a helpful AI assistant that can see the user's screen.
Be concise and direct. Focus on what's relevant to the user's question.
If the user asks you to interact with the screen, use action tags:
[ACTION:click:X:Y] [ACTION:type:text] [ACTION:wait:ms]
Coordinates are normalized 0.0-1.0. Put action tags at the end of your response.`;
    }

    const conversationHistory = history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));

    let userContent;
    if (base64Image && message && message.trim()) {
      userContent = [
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: "text", text: message },
      ];
    } else if (base64Image) {
      userContent = [
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: "text", text: "Describe what you see on screen and offer to help." },
      ];
    } else {
      userContent = message && message.trim() ? message : "Hello";
    }

    const messages = [
      { role: "system", content: systemContent },
      ...conversationHistory,
      { role: "user", content: userContent },
    ];

    const model = hasImage
      ? "meta-llama/llama-4-maverick-17b-16e-instruct"
      : "meta-llama/llama-4-scout-17b-16e-instruct";

    const maxTok = jsonAnalyze && hasImage ? 150 : hasImage ? 256 : 512;
    const result = await callGroq(messages, model, maxTok);
    console.log("Response:", result);
    res.json({ result });
  } catch (err) {
    console.error("ERROR:", err.message);
    res.status(500).json({ error: "Failed to reach Groq" });
  }
});

app.post("/referral", express.json(), async (req, res) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    const { ref } = req.body;
    const user = await getUserFromToken(token);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!ref) return res.status(400).json({ error: "No referrer" });
    if (ref === user.id) return res.status(400).json({ error: "Cannot refer yourself" });

    const { data: existing } = await supabase
      .from("referrals").select("id").eq("referred_id", user.id).single();
    if (existing) return res.status(200).json({ message: "Already referred" });

    await handleReferral(ref, user.id);
    res.json({ success: true });
  } catch (err) {
    console.error("Referral error:", err.message);
    res.status(500).json({ error: "Referral failed" });
  }
});

app.get("/referrals", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const { count } = await supabase
    .from("referrals").select("*", { count: "exact", head: true }).eq("referrer_id", user.id);
  res.json({ count: count || 0, needed: 2 });
});

app.post("/webhooks/lemonsqueezy", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signingSecret = process.env.LEMONSQUEEZY_SIGNING_SECRET;
    const signature = req.headers["x-signature"];
    const hmac = crypto.createHmac("sha256", signingSecret);
    hmac.update(req.body);
    const digest = hmac.digest("hex");
    if (digest !== signature) return res.status(401).json({ error: "Invalid signature" });

    const event = JSON.parse(req.body);
    const eventName = event.meta.event_name;
    const userId = event.meta.custom_data?.user_id;
    if (!userId) return res.sendStatus(200);

    const variantName = event.data.attributes.variant_name?.toLowerCase() ?? "";
    const plan = variantName.includes("monthly") ? "monthly" : "weekly";
    const periodEnd = event.data.attributes.ends_at || event.data.attributes.renews_at;

    if (eventName === "subscription_created" || eventName === "subscription_updated") {
      const status = event.data.attributes.status === "active" ? "active" : "inactive";
      await supabase.from("subscriptions").upsert({
        user_id: userId, plan, status,
        current_period_start: new Date().toISOString(),
        current_period_end: periodEnd ? new Date(periodEnd).toISOString() : null,
      }, { onConflict: "user_id" });
    }

    if (eventName === "subscription_cancelled") {
      await supabase.from("subscriptions").update({ status: "cancelled" }).eq("user_id", userId);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.get("/subscription", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const subscription = await getSubscription(user.id);
  const { data: usage } = await supabase
    .from("message_usage").select("*").eq("user_id", user.id).single();

  res.json({
    plan: subscription ? subscription.plan : "free",
    status: subscription ? subscription.status : "inactive",
    message_count: usage?.message_count || 0,
    remaining: Math.max(0, FREE_LIMIT - (usage?.message_count || 0)),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
