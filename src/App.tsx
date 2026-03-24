import { useCallback, useEffect, useState, useRef } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { listen } from "@tauri-apps/api/event";
import { createClient } from "@supabase/supabase-js";
import "./App.css";

const SERVER_URL = "https://agrade-cbwf.onrender.com/ask";
const ANALYZE_URL = "https://agrade-cbwf.onrender.com/analyze";
const LOGIN_URL = "https://agradee.online/login.html?source=app";
const PRICING_BASE_URL = "https://agradee.online/pricing.html";
const MAX_AUTOMATION_ROUNDS = 30;

const supabase = createClient(
  "https://llabvdbcvilnbukroqxn.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsYWJ2ZGJjdmlsbmJ1a3JvcXhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2OTQzNzQsImV4cCI6MjA4OTI3MDM3NH0.WLdB5hNXMHJ63JGwgXgY8TEEGz7k5AVbsV7aVDy6xQU"
);

interface Message {
  role: "user" | "ai";
  text: string;
  screenshotOnly?: boolean;
  isLimit?: boolean;
  isAutomation?: boolean;
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

interface AutomationAction {
  type: "click" | "type" | "wait" | "screenshot";
  x?: number;
  y?: number;
  text?: string;
  ms?: number;
}

const stripMarkdown = (text: string): string => {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/\*(.+?)\*/gs, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/`(.+?)`/gs, "$1")
    .replace(/^\s*[-•]\s/gm, "· ");
};

const parseAutomationActions = (
  text: string
): { actions: AutomationAction[]; cleanText: string } => {
  const actions: AutomationAction[] = [];
  const actionRegex = /\[ACTION:([^\]]+)\]/g;
  let match;

  while ((match = actionRegex.exec(text)) !== null) {
    const parts = match[1].split(":");
    const type = parts[0] as AutomationAction["type"];
    if (type === "click" && parts.length >= 3) {
      const x = parseFloat(parts[1]);
      const y = parseFloat(parts[2]);
      if (!isNaN(x) && !isNaN(y)) actions.push({ type: "click", x, y });
    } else if (type === "type" && parts.length >= 2) {
      actions.push({ type: "type", text: parts.slice(1).join(":") });
    } else if (type === "wait" && parts.length >= 2) {
      actions.push({ type: "wait", ms: parseInt(parts[1], 10) });
    } else if (type === "screenshot") {
      actions.push({ type: "screenshot" });
    }
  }

  const cleanText = text.replace(actionRegex, "").replace(/\n{3,}/g, "\n\n").trim();
  return { actions, cleanText };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isAutomating, setIsAutomating] = useState<boolean>(false);
  const [automationStatus, setAutomationStatus] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [authReady, setAuthReady] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const stopAutomationRef = useRef<boolean>(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    if (bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  };

  const authHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (tokenRef.current) h["Authorization"] = `Bearer ${tokenRef.current}`;
    return h;
  };

  const captureQuizScreenshot = async (): Promise<string> => {
    // Hide overlay before capture so model sees the browser page, not this app.
    await invoke("hide_window").catch(() => {});
    await sleep(180);
    const shot = await invoke<string>("capture_screen");
    await sleep(80);
    await invoke("show_window").catch(() => {});
    return shot;
  };

  const isSafeClickPoint = (x: number, y: number): boolean => {
    // Block risky edges/title-bar/taskbar zones to avoid closing windows/apps.
    if (x < 0.06 || x > 0.94) return false;
    if (y < 0.12 || y > 0.92) return false;
    // Extra block for common top-right window controls.
    if (x > 0.82 && y < 0.16) return false;
    return true;
  };

  const handleDeepLink = (url: string) => {
    try {
      const parsed = new URL(url);
      const accessToken = parsed.searchParams.get("token");
      const refreshToken = parsed.searchParams.get("refresh");
      if (accessToken && refreshToken) {
        supabase.auth.setSession({
          access_token: decodeURIComponent(accessToken),
          refresh_token: decodeURIComponent(refreshToken),
        }).then(({ data, error }) => {
          console.log("setSession:", data?.session ? "success" : "failed", error?.message ?? "");
        });
      }
    } catch (e) {
      console.error("Deep link parse error:", e);
    }
  };

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) {
        tokenRef.current = session.access_token;
        setAuthReady(true);
      } else if (authReady) {
        tokenRef.current = null;
        open(LOGIN_URL);
      } else {
        setAuthReady(true);
        open(LOGIN_URL);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const unlisten = onOpenUrl((urls) => handleDeepLink(urls[0]));
    const unlistenTauri = listen("deep-link-received", (event) => {
      handleDeepLink(event.payload as string);
    });
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) setTimeout(() => invoke("reapply_stealth").catch(() => {}), 300);
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenTauri.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
    };
  }, []);

  const handleUpgrade = async () => {
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id;
    open(userId ? `${PRICING_BASE_URL}?user_id=${userId}` : PRICING_BASE_URL);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    tokenRef.current = null;
    setMessages([]);
    setHistory([]);
    open(LOGIN_URL);
  };

  // ── Core fetch ─────────────────────────────────────────────────────────────
  const fetchFromServer = async (
    userText: string,
    base64Image: string | undefined,
    hist: HistoryEntry[]
  ): Promise<{ rawText: string; newHistory: HistoryEntry[] } | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);

      const body: Record<string, unknown> = {
        message: userText || "",
        history: hist,
      };
      if (base64Image) body.base64Image = base64Image;

      const res = await fetch(SERVER_URL, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const data = await res.json();

      if (res.status === 429) {
        setMessages((prev) => [...prev, { role: "ai", text: "", isLimit: true }]);
        return null;
      }
      if (res.status === 401) {
        await supabase.auth.signOut();
        tokenRef.current = null;
        open(LOGIN_URL);
        return null;
      }

      const rawText = data.result || data.message || "No response received.";
      const newHistory: HistoryEntry[] = [
        ...hist,
        { role: "user", content: userText || "[screenshot captured]" },
      ];
      return { rawText, newHistory };
    } catch (err: unknown) {
      if (err instanceof Error) {
        const msg = err.name === "AbortError"
          ? "Server is waking up — try again in 30 seconds."
          : "Error: " + err.message;
        setMessages((prev) => [...prev, { role: "ai", text: msg }]);
      }
      return null;
    }
  };

  const parseAnalyzeJson = (
    raw: string
  ): { answer: string; type: "multiple_choice" | "text_input"; confidence: number } | null => {
    const normalize = (
      value: unknown
    ): { answer: string; type: "multiple_choice" | "text_input"; confidence: number } | null => {
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      if (!record.answer || !record.type) return null;
      const type = record.type === "text_input" ? "text_input" : "multiple_choice";
      const confidence =
        typeof record.confidence === "number"
          ? Math.max(0, Math.min(1, record.confidence))
          : 0.6;
      return { answer: String(record.answer), type, confidence };
    };

    const extractFirstJsonChunk = (text: string): string | null => {
      const start = text.search(/[\[{]/);
      if (start < 0) return null;
      let depth = 0;
      let inString = false;
      let escaped = false;
      const openChar = text[start];
      const closeChar = openChar === "[" ? "]" : "}";

      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (ch === "\\") {
            escaped = true;
          } else if (ch === "\"") {
            inString = false;
          }
          continue;
        }

        if (ch === "\"") {
          inString = true;
          continue;
        }

        if (ch === openChar) depth++;
        if (ch === closeChar) {
          depth--;
          if (depth === 0) {
            return text.slice(start, i + 1);
          }
        }
      }
      return null;
    };

    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      const direct = JSON.parse(clean);
      if (Array.isArray(direct)) return normalize(direct[0]);
      return normalize(direct);
    } catch {}

    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      const chunk = extractFirstJsonChunk(clean);
      if (!chunk) return null;
      const parsed = JSON.parse(chunk);
      if (Array.isArray(parsed)) return normalize(parsed[0]);
      return normalize(parsed);
    } catch {
      return null;
    }
  };

  // ── Analyze screen — returns answer as structured JSON ────────────────────
  const analyzeScreen = async (
    base64Image: string
  ): Promise<{
    analysis: {
      answer: string;
      type: "multiple_choice" | "text_input";
      confidence: number;
    } | null;
    reason?: string;
  }> => {
    try {
      if (!base64Image || base64Image.length < 100) {
        return { analysis: null, reason: "Screenshot appears empty or too small." };
      }

      // Primary path: dedicated /analyze endpoint
      for (let attempt = 1; attempt <= 2; attempt++) {
        const res = await fetch(ANALYZE_URL, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ base64Image }),
        });
        if (!res.ok) {
          const detail = (await res.text()).slice(0, 180);
          const reason =
            res.status === 401
              ? "Unauthorized (401) - sign in again."
              : res.status === 429
                ? "Rate limit reached (429)."
                : `Analyze endpoint error (${res.status})${detail ? `: ${detail}` : ""}`;
          console.error("Analyze failed:", reason);
          if (attempt === 2) {
            // continue to fallback path after final primary attempt
          }
          await sleep(250);
          continue;
        }
        const data = await res.json();
        if (data?.answer && data?.type) {
          return {
            analysis: {
              answer: String(data.answer),
              type: data.type === "text_input" ? "text_input" : "multiple_choice",
              confidence:
                typeof data.confidence === "number"
                  ? Math.max(0, Math.min(1, data.confidence))
                  : 0.7,
            },
          };
        }
      }

      // Fallback path: ask endpoint with strict JSON instruction
      const fallbackRes = await fetch(SERVER_URL, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          base64Image,
          message:
            'You are analyzing a browser quiz screenshot. Return JSON only: {"answer":"exact answer text","type":"multiple_choice or text_input","confidence":0.0-1.0}. If a quiz question/options are not clearly visible, return {"answer":"","type":"multiple_choice","confidence":0}.',
          history: [],
        }),
      });
      if (!fallbackRes.ok) {
        const detail = (await fallbackRes.text()).slice(0, 180);
        return {
          analysis: null,
          reason:
            fallbackRes.status === 401
              ? "Unauthorized (401) on fallback."
              : fallbackRes.status === 429
                ? "Rate limit reached (429) on fallback."
                : `Fallback endpoint error (${fallbackRes.status})${detail ? `: ${detail}` : ""}`,
        };
      }
      const fallbackData = await fallbackRes.json();
      const rawText = String(fallbackData?.result || "");
      const parsed = parseAnalyzeJson(rawText);
      if (parsed) return { analysis: parsed };
      return {
        analysis: null,
        reason: `Fallback returned non-JSON/invalid JSON. Raw: ${rawText.slice(0, 160)}`,
      };
    } catch (err) {
      console.error("analyzeScreen exception:", err);
      return {
        analysis: null,
        reason: err instanceof Error ? err.message : "Unknown analyze exception",
      };
    }
  };

  // ── Locate text on screen — returns normalized coordinates ────────────────
  const locateOnScreen = async (
    base64Image: string,
    text: string
  ): Promise<{ x: number; y: number; found: boolean }> => {
    try {
      const compact = text.replace(/\s+/g, " ").trim();
      const words = compact.split(" ").filter(Boolean);
      const shortPhrase = words.slice(0, 8).join(" ");
      const anchorPhrase =
        words.length > 14 ? `${words.slice(0, 4).join(" ")} ... ${words.slice(-4).join(" ")}` : compact;

      const prompts = [
        `Find the quiz answer option text "${compact}" on the browser page and click its center. Ignore app overlays, IDE/editor text, taskbar, and system UI. Emit ONLY one [ACTION:click:X:Y] tag. If not found, emit nothing.`,
        `Find and click the answer option that BEST MATCHES this phrase: "${shortPhrase}". The full option may be longer/truncated. Ignore app overlays and non-browser UI. Emit ONLY one [ACTION:click:X:Y] tag.`,
        `Find and click the quiz option semantically matching: "${anchorPhrase}". Do not click chrome tabs, address bar, close buttons, taskbar, or this app. Emit ONLY one [ACTION:click:X:Y] tag.`,
      ];

      for (const message of prompts) {
        const res = await fetch(SERVER_URL, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            base64Image,
            message,
            history: [],
          }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const rawText = String(data?.result || "");
        const { actions } = parseAutomationActions(rawText);
        const clickAction = actions.find((a) => a.type === "click");
        if (clickAction && clickAction.x !== undefined && clickAction.y !== undefined) {
          if (!isSafeClickPoint(clickAction.x, clickAction.y)) continue;
          return { x: clickAction.x, y: clickAction.y, found: true };
        }
      }

      return { x: 0.5, y: 0.5, found: false };
    } catch {
      return { x: 0.5, y: 0.5, found: false };
    }
  };

  // ── Execute actions ────────────────────────────────────────────────────────
  const executeActions = async (actions: AutomationAction[]): Promise<string> => {
    await invoke("hide_window").catch(() => {});
    await sleep(150);

    for (const action of actions) {
      try {
        if (action.type === "click" && action.x !== undefined && action.y !== undefined) {
          if (!isSafeClickPoint(action.x, action.y)) {
            console.warn("Blocked unsafe click:", action);
            continue;
          }
          setAutomationStatus(`Clicking (${Math.round(action.x * 100)}%, ${Math.round(action.y * 100)}%)`);
          await invoke("click_at", { x: action.x, y: action.y });
          await sleep(120);
        } else if (action.type === "type" && action.text) {
          setAutomationStatus(`Typing…`);
          await invoke("type_text", { text: action.text });
          await sleep(100);
        } else if (action.type === "wait") {
          await sleep(action.ms ?? 500);
        }
      } catch (err) {
        console.error("Action failed:", action, err);
      }
    }

    await sleep(600);
    const screenshot = await invoke<string>("capture_screen");
    await invoke("show_window").catch(() => {});
    return screenshot;
  };

  // ── Auto-answer loop using analyze + locate ───────────────────────────────
  const handleAutoAnswer = async () => {
    if (isLoading || isAutomating) return;
    stopAutomationRef.current = false;
    setIsAutomating(true);

    setMessages((prev) => [...prev, {
      role: "user",
      text: "Auto-answering quiz…",
    }]);

    let round = 0;
    let consecutiveFailures = 0;
    let lastAnalyzeReason = "";

    while (
      round < MAX_AUTOMATION_ROUNDS &&
      consecutiveFailures < 3 &&
      !stopAutomationRef.current
    ) {
      round++;
      setAutomationStatus(`Round ${round} — analyzing…`);
      setTimeout(scrollToBottom, 50);

      const screenBase64 = await captureQuizScreenshot();
      const analyzeResult = await analyzeScreen(screenBase64);
      const analysis = analyzeResult.analysis;
      if (stopAutomationRef.current) break;

      if (!analysis) {
        consecutiveFailures++;
        lastAnalyzeReason = analyzeResult.reason || "Unknown analyze failure";
        setAutomationStatus(
          `Round ${round} — analyze failed (${lastAnalyzeReason.slice(0, 70)}), retrying...`
        );
        if (consecutiveFailures === 1) {
          setMessages((prev) => [...prev, {
            role: "ai",
            text: `Analyze failed: ${lastAnalyzeReason}`,
            isAutomation: true,
          }]);
        }
        await sleep(1000);
        continue;
      }

      if (!analysis.answer || analysis.confidence < 0.35) {
        setMessages((prev) => [...prev, {
          role: "ai",
          text: "Quiz question was not clearly detected on screen. Stopping automation.",
          isAutomation: true,
        }]);
        break;
      }

      consecutiveFailures = 0;
      console.log("Analysis:", analysis);

      // Show the answer in chat
      setMessages((prev) => [...prev, {
        role: "ai",
        text: analysis.answer,
        isAutomation: true,
      }]);

      if (analysis.type === "multiple_choice") {
        // Locate the answer text on screen
        setAutomationStatus(`Locating "${analysis.answer}"…`);
        const location = await locateOnScreen(screenBase64, analysis.answer);
        console.log("Location:", location);

        if (location.found) {
          if (!isSafeClickPoint(location.x, location.y)) {
            setMessages((prev) => [...prev, {
              role: "ai",
              text: "Blocked unsafe click near window controls. Stopping.",
              isAutomation: true,
            }]);
            break;
          }
          await invoke("hide_window").catch(() => {});
          await sleep(150);
          setAutomationStatus(`Clicking "${analysis.answer}"…`);
          await invoke("click_at", { x: location.x, y: location.y });
          await sleep(800);
          await invoke("show_window").catch(() => {});
        } else {
          setMessages((prev) => [...prev, {
            role: "ai",
            text: `Could not locate "${analysis.answer}" on screen.`,
            isAutomation: true,
          }]);
          consecutiveFailures++;
          await sleep(500);
          continue;
        }
      } else {
        // Text input
        await invoke("hide_window").catch(() => {});
        await sleep(150);
        setAutomationStatus(`Typing "${analysis.answer}"…`);
        // Click center of screen to focus input
        await invoke("click_at", { x: 0.5, y: 0.55 });
        await sleep(200);
        await invoke("type_text", { text: analysis.answer });
        await sleep(150);
        await invoke("type_text", { text: "\n" });
        await sleep(800);
        await invoke("show_window").catch(() => {});
      }
      if (stopAutomationRef.current) break;

      // Check if done
      setAutomationStatus(`Round ${round} — checking if complete…`);
      const afterScreen = await captureQuizScreenshot();

      const checkResult = await fetchFromServer(
        "[AUTO] Is this quiz or task now fully complete with no more unanswered questions? Reply YES or NO only.",
        afterScreen,
        []
      );

      const checkText = (checkResult?.rawText || "").trim().toUpperCase();
      console.log("Completion check:", checkText);

      if (checkText.startsWith("YES")) {
        setMessages((prev) => [...prev, {
          role: "ai",
          text: "✓ Task complete.",
          isAutomation: true,
        }]);
        break;
      }

      // Small pause before next round
      await sleep(300);
      setTimeout(scrollToBottom, 50);
    }

    if (stopAutomationRef.current) {
      setMessages((prev) => [...prev, {
        role: "ai",
        text: "Automation stopped.",
        isAutomation: true,
      }]);
    } else if (consecutiveFailures >= 3) {
      setMessages((prev) => [...prev, {
        role: "ai",
        text: `Could not analyze screen after multiple attempts. Last error: ${lastAnalyzeReason || "Unknown failure"}`,
        isAutomation: true,
      }]);
    }

    if (!stopAutomationRef.current && round >= MAX_AUTOMATION_ROUNDS) {
      setMessages((prev) => [...prev, {
        role: "ai",
        text: `Reached ${MAX_AUTOMATION_ROUNDS}-round limit.`,
        isAutomation: true,
      }]);
    }

    setIsAutomating(false);
    setAutomationStatus("");
    stopAutomationRef.current = false;
    setTimeout(scrollToBottom, 50);
  };

  const handleStopAutomation = () => {
    if (!isAutomating) return;
    stopAutomationRef.current = true;
    setAutomationStatus("Stopping automation...");
  };

  // ── Normal send ────────────────────────────────────────────────────────────
  const sendToServer = async (
    userText: string,
    base64Image?: string,
    currentHistory?: HistoryEntry[]
  ) => {
    const hist = currentHistory ?? history;
    setIsLoading(true);
    setTimeout(scrollToBottom, 50);

    const result = await fetchFromServer(userText, base64Image, hist);
    setIsLoading(false);

    if (!result) return;

    const { rawText, newHistory } = result;
    const { actions, cleanText } = parseAutomationActions(rawText);
    const aiText = stripMarkdown(cleanText);
    const hasActions = actions.length > 0;

    setMessages((prev) => [...prev, {
      role: "ai",
      text: aiText,
      isAutomation: hasActions,
    }]);

    const finalHistory: HistoryEntry[] = [
      ...newHistory,
      { role: "assistant", content: aiText },
    ];
    setHistory(finalHistory);
    setTimeout(scrollToBottom, 50);

    if (hasActions) {
      setIsAutomating(true);
      await executeActions(actions);
      setIsAutomating(false);
      setAutomationStatus("");
    }
  };

  const handleSubmit = async () => {
    if (isAutomating) {
      handleStopAutomation();
      return;
    }
    if (!message.trim() || isLoading) return;
    const userText = message.trim();
    setMessage("");
    setMessages((prev) => [...prev, { role: "user", text: userText }]);
    await sendToServer(userText);
  };

  const handleCaptureWithMessage = async () => {
    if (isLoading || isAutomating) return;
    const userText = message.trim();
    const screenBase64 = await invoke<string>("capture_screen");
    setMessage("");
    setMessages((prev) => [...prev, {
      role: "user",
      text: userText || "",
      screenshotOnly: !userText,
    }]);
    await sendToServer(userText, screenBase64);
  };

  const handleAskGroq = useCallback(
    async (base64Image: string, userMessage?: string) => {
      const userText = userMessage?.trim() || "";
      setMessages((prev) => [...prev, {
        role: "user",
        text: userText || "",
        screenshotOnly: !userText,
      }]);
      await sendToServer(userText, base64Image, history);
    },
    [history]
  );

  useEffect(() => {
    const shortcuts: string[] = [
      "CommandOrControl+Shift+G",
      "CommandOrControl+B",
      "Control+H",
      "Control+Left",
      "Control+Right",
      "Control+Up",
      "Control+Down",
    ];

    const setupShortcuts = async () => {
      for (const s of shortcuts) {
        try { await unregister(s); } catch (_) {}
      }
      await register("CommandOrControl+Shift+G", async () => {
        const screenBase64 = await invoke<string>("capture_screen");
        handleAskGroq(screenBase64, message);
        setMessage("");
      });
      await register("CommandOrControl+B", async () => {
        await invoke("show_window");
        await getCurrentWindow().setFocus();
      });
      await register("Control+H", async () => {
        await invoke("hide_window");
      });
      const STEP = 40;
      await register("Control+Left", async () => {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        await win.setPosition({ type: "Physical", x: pos.x - STEP, y: pos.y } as any);
      });
      await register("Control+Right", async () => {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        await win.setPosition({ type: "Physical", x: pos.x + STEP, y: pos.y } as any);
      });
      await register("Control+Up", async () => {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        await win.setPosition({ type: "Physical", x: pos.x, y: pos.y - STEP } as any);
      });
      await register("Control+Down", async () => {
        const win = getCurrentWindow();
        const pos = await win.outerPosition();
        await win.setPosition({ type: "Physical", x: pos.x, y: pos.y + STEP } as any);
      });
    };

    setupShortcuts();
    return () => { shortcuts.forEach((s) => unregister(s)); };
  }, [handleAskGroq, message]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const copyLastResponse = () => {
    const lastAi = [...messages].reverse().find((m) => m.role === "ai" && !m.isLimit);
    if (lastAi) navigator.clipboard.writeText(lastAi.text);
  };

  const clearConversation = () => {
    setMessages([]);
    setHistory([]);
  };

  const isLimitReached = messages.length > 0 && messages[messages.length - 1].isLimit;
  const isBlocked = isLoading || isAutomating;

  return (
    <div className="hud-root">
      <div className="hud-panel">

        {/* ── Header ── */}
        <div className="hud-header" data-tauri-drag-region>
          <span className="hud-title" data-tauri-drag-region>agrade</span>
          <div className="hud-header-actions">
            {messages.length > 0 && !isLimitReached && (
              <>
                <button className="hud-action-btn" onClick={copyLastResponse} title="Copy last response">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                </button>
                <button className="hud-action-btn" onClick={clearConversation} title="Clear conversation">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    <path d="M10 11v6" /><path d="M14 11v6" />
                  </svg>
                </button>
              </>
            )}
            <button className="hud-action-btn" onClick={handleSignOut} title="Sign out">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
            <div className={`hud-status ${isBlocked ? "active" : ""}`} />
          </div>
        </div>

        {/* ── Body ── */}
        <div className="hud-body" ref={bodyRef}>
          <div className="hud-messages">
            {messages.map((msg, i) =>
              msg.role === "user" ? (
                <div key={i} className="hud-bubble-row user">
                  <div className="hud-bubble user">
                    {msg.screenshotOnly ? (
                      <div className="hud-screenshot-tag">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                          <circle cx="12" cy="13" r="4" />
                        </svg>
                        Screenshot captured
                      </div>
                    ) : msg.text}
                  </div>
                </div>
              ) : msg.isLimit ? (
                <div key={i} className="hud-limit-block">
                  <p className="hud-limit-text">You've used your 5 free messages</p>
                  <button className="hud-upgrade-btn" onClick={handleUpgrade}>
                    Upgrade to Pro
                  </button>
                </div>
              ) : (
                <div key={i} className={`hud-ai-response${msg.isAutomation ? " hud-ai-automation" : ""}`}>
                  {msg.isAutomation && <span className="hud-automation-badge">⚡ automated</span>}
                  {msg.text}
                </div>
              )
            )}

            {isLoading && (
              <div className="hud-thinking">
                <span /><span /><span />
              </div>
            )}

            {isAutomating && (
              <div className="hud-automation-status">
                <span className="hud-automation-spinner" />
                {automationStatus || "Automating…"}
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        {!isLimitReached && (
          <div className="hud-footer">
            <div className="hud-footer-row">

              {/* Screenshot button */}
              <button
                className="hud-icon-btn"
                onClick={handleCaptureWithMessage}
                disabled={isBlocked}
                title="Capture screen"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>

              {/* Auto-answer button */}
              <button
                className="hud-icon-btn"
                onClick={handleAutoAnswer}
                disabled={isBlocked}
                title="Auto-answer quiz"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
              </button>

              <div className="hud-input-row">
                <textarea
                  ref={inputRef}
                  className="hud-input"
                  placeholder={
                    isAutomating
                      ? automationStatus || "Automating…"
                      : "Ask anything or capture screen…"
                  }
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={isBlocked}
                />
                <button
                  className="hud-send-btn"
                  onClick={isAutomating ? handleStopAutomation : handleSubmit}
                  disabled={isLoading || (!isAutomating && !message.trim())}
                  title={isAutomating ? "Stop automation" : "Send"}
                >
                  {isAutomating ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="5" y="5" width="14" height="14" rx="2" />
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
