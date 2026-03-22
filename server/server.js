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
  console.log("checkAndIncrementUsage usage:", JSON.stringify(usage));

  if (usageError && usageError.code !== "PGRST116") {
    throw new Error(`DB read failed: ${usageError.message}`);
  }

  const now = new Date();

  if (!usage) {
    const { error: insertError } = await supabase.from("message_usage").insert({
      user_id: userId,
      message_count: 1,
      last_reset: now.toISOString(),
    });
    console.log("insert error:", insertError?.message ?? "none");
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

  console.log("Referral count for", referrerId, ":", count);

  if (count >= 2) {
    const existing = await getSubscription(referrerId);
    if (!existing) {
      const { error } = await supabase.from("subscriptions").upsert({
        user_id: referrerId,
        plan: "weekly",
        status: "active",
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: "user_id" });
      console.log("Referral subscription upsert error:", error?.message ?? "none");
    }
  }
}

app.get("/", (req, res) => {
  res.status(200).send("ok");
});

app.get("/download", (req, res) => {
  res.redirect("https://github.com/Lethabo3/agrade/releases/latest/download/agrade_0.1.0_x64-setup.exe");
});

app.get("/health", async (req, res) => {
  const { data, error } = await supabase.from("message_usage").select("count").limit(1);
  if (error) return res.status(500).json({ db: "error", detail: error.message });
  res.json({ db: "ok", data });
});

app.post("/ask", express.json({ limit: "10mb" }), async (req, res) => {
  try {
    const { base64Image, message, history = [] } = req.body;
    const token = req.headers.authorization?.replace("Bearer ", "");

    console.log("TOKEN:", token ? "present" : "missing");

    const user = await getUserFromToken(token);
    console.log("USER:", user ? user.id : "null");

    if (!user) {
      console.log("Returning 401");
      return res.status(401).json({
        error: "Unauthorized",
        message: "Please sign in to use agrade.",
      });
    }

    const subscription = await getSubscription(user.id);
    console.log("SUBSCRIPTION:", subscription ? "active" : "none");

    const isPro = !!subscription;

    if (!isPro) {
      const usage = await checkAndIncrementUsage(user.id);
      console.log("USAGE:", JSON.stringify(usage));
      if (!usage.allowed) {
        console.log("Returning 429");
        return res.status(429).json({
          error: "Limit reached",
          message: "You've used your 5 free messages. Upgrade to Pro for unlimited access.",
        });
      }
    }

    const systemMessage = {
      role: "system",
      content: "You are agrade, a helpful AI assistant that can see the user's screen and answer questions. Be concise and direct. When analyzing screens, focus on what's relevant to the user's question. If no question is asked, describe what you see and offer to help.",
    };

    const conversationHistory = history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));

    let userContent;

    if (base64Image && message) {
      userContent = [
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: "text", text: message },
      ];
    } else if (base64Image) {
      userContent = [
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: "text", text: "Analyze this screen and provide a helpful, concise response." },
      ];
    } else {
      userContent = message || "Hello";
    }

    const messages = [
      systemMessage,
      ...conversationHistory,
      { role: "user", content: userContent },
    ];

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages,
        max_tokens: 512,
      }),
    });

    const data = await response.json();
    console.log("Groq response status:", response.status);
    res.json({ result: data.choices[0].message.content });
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
      .from("referrals")
      .select("id")
      .eq("referred_id", user.id)
      .single();

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
    .from("referrals")
    .select("*", { count: "exact", head: true })
    .eq("referrer_id", user.id);

  res.json({ count: count || 0, needed: 2 });
});

app.post("/webhooks/lemonsqueezy", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signingSecret = process.env.LEMONSQUEEZY_SIGNING_SECRET;
    const signature = req.headers["x-signature"];
    const hmac = crypto.createHmac("sha256", signingSecret);
    hmac.update(req.body);
    const digest = hmac.digest("hex");

    if (digest !== signature) {
      console.log("Webhook signature mismatch");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(req.body);
    const eventName = event.meta.event_name;
    const userId = event.meta.custom_data?.user_id;

    console.log("Webhook event:", eventName, "userId:", userId);

    if (!userId) {
      console.log("No user_id in webhook custom data");
      return res.sendStatus(200);
    }

    const variantName = event.data.attributes.variant_name?.toLowerCase() ?? "";
    const plan = variantName.includes("monthly") ? "monthly" : "weekly";
    const periodEnd = event.data.attributes.ends_at || event.data.attributes.renews_at;

    if (eventName === "subscription_created" || eventName === "subscription_updated") {
      const status = event.data.attributes.status === "active" ? "active" : "inactive";
      const { error } = await supabase.from("subscriptions").upsert({
        user_id: userId,
        plan,
        status,
        current_period_start: new Date().toISOString(),
        current_period_end: periodEnd ? new Date(periodEnd).toISOString() : null,
      }, { onConflict: "user_id" });
      console.log("Upsert subscription error:", error?.message ?? "none");
    }

    if (eventName === "subscription_cancelled") {
      await supabase
        .from("subscriptions")
        .update({ status: "cancelled" })
        .eq("user_id", userId);
      console.log("Subscription cancelled for user:", userId);
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
    .from("message_usage")
    .select("*")
    .eq("user_id", user.id)
    .single();

  res.json({
    plan: subscription ? subscription.plan : "free",
    status: subscription ? subscription.status : "inactive",
    message_count: usage?.message_count || 0,
    remaining: Math.max(0, FREE_LIMIT - (usage?.message_count || 0)),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
