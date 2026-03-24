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
const MAX_AUTOMATION_ROUNDS = 20;

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
      if (!isNaN(x) && !isNaN(y)) {
        actions.push({ type: "click", x, y });
      }
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleDeepLink = (url: string) => {
    try {
      const parsed = new URL(url);
      const accessToken = parsed.searchParams.get("token");
      const refreshToken = parsed.searchParams.get("refresh");
      if (accessToken && refreshToken) {
        supabase.auth
          .setSession({
            access_token: decodeURIComponent(accessToken),
            refresh_token: decodeURIComponent(refreshToken),
          })
          .then(({ data, error }) => {
            console.log(
              "setSession:",
              data?.session ? "success" : "failed",
              error?.message ?? ""
            );
          });
      }
    } catch (e) {
      console.error("Deep link parse error:", e);
    }
  };

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
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

    const unlistenFocus = getCurrentWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (focused) {
          setTimeout(() => invoke("reapply_stealth").catch(() => {}), 300);
        }
      }
    );

    return () => {
      unlisten.then((fn) => fn());
      unlistenTauri.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
    };
  }, []);

  const scrollToBottom = () => {
    if (bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  };

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

  // ── Core network call ──────────────────────────────────────────────────────
  const fetchFromServer = async (
    userText: string,
    base64Image: string | undefined,
    hist: HistoryEntry[]
  ): Promise<{ rawText: string; newHistory: HistoryEntry[] } | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const body: Record<string, unknown> = { message: userText, history: hist };
      if (base64Image) body.base64Image = base64Image;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tokenRef.current) headers["Authorization"] = `Bearer ${tokenRef.current}`;

      const res = await fetch(SERVER_URL, {
        method: "POST",
        headers,
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
        if (err.name === "AbortError") {
          setMessages((prev) => [
            ...prev,
            { role: "ai", text: "Server is waking up — try again in 30 seconds." },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            { role: "ai", text: "Error: " + err.message },
          ]);
        }
      }
      return null;
    }
  };

  // ── Execute one batch of actions, return fresh screenshot ─────────────────
  const executeActions = async (actions: AutomationAction[]): Promise<string> => {
    await invoke("hide_window").catch(() => {});
    await sleep(150);

    for (const action of actions) {
      try {
        if (action.type === "click" && action.x !== undefined && action.y !== undefined) {
          setAutomationStatus(
            `Clicking (${Math.round(action.x * 100)}%, ${Math.round(action.y * 100)}%)`
          );
          await invoke("click_at", { x: action.x, y: action.y });
          await sleep(120);
        } else if (action.type === "type" && action.text) {
          setAutomationStatus(`Typing answer…`);
          await invoke("type_text", { text: action.text });
          await sleep(100);
        } else if (action.type === "wait") {
          const ms = action.ms ?? 500;
          setAutomationStatus(`Waiting ${ms}ms…`);
          await sleep(ms);
        }
        // screenshot actions handled at end of round
      } catch (err) {
        console.error("Action failed:", action, err);
      }
    }

    await sleep(600); // let UI settle
    const screenshot = await invoke<string>("capture_screen");
    await invoke("show_window").catch(() => {});
    return screenshot;
  };

  // ── Full autonomous loop ───────────────────────────────────────────────────
  const runAutomationLoop = async (
    initialActions: AutomationAction[],
    initialHistory: HistoryEntry[],
    taskDescription: string
  ) => {
    setIsAutomating(true);
    let actions = initialActions;
    let currentHistory = initialHistory;
    let round = 0;

    while (actions.length > 0 && round < MAX_AUTOMATION_ROUNDS) {
      round++;
      setAutomationStatus(`Round ${round} — executing ${actions.length} action(s)…`);
      setTimeout(scrollToBottom, 50);

      const freshScreenshot = await executeActions(actions);

      setIsLoading(true);
      setAutomationStatus(`Round ${round} — evaluating screen…`);

      const followUp = `[AUTO] Continue the task: "${taskDescription}". Study the current screenshot. Complete any remaining questions or steps. If nothing is left to do, respond with exactly: TASK_COMPLETE`;

      const result = await fetchFromServer(followUp, freshScreenshot, currentHistory);
      setIsLoading(false);

      if (!result) break;

      const { rawText, newHistory } = result;

      if (rawText.trim().startsWith("TASK_COMPLETE")) {
        setMessages((prev) => [
          ...prev,
          { role: "ai", text: "✓ Task complete.", isAutomation: true },
        ]);
        setHistory([...newHistory, { role: "assistant", content: "TASK_COMPLETE" }]);
        actions = [];
        break;
      }

      const { actions: nextActions, cleanText } = parseAutomationActions(rawText);
      const aiText = stripMarkdown(cleanText);

      if (aiText) {
        setMessages((prev) => [
          ...prev,
          { role: "ai", text: aiText, isAutomation: nextActions.length > 0 },
        ]);
      }

      currentHistory = [
        ...newHistory,
        { role: "assistant", content: aiText || rawText },
      ];
      setHistory(currentHistory);
      actions = nextActions;
      setTimeout(scrollToBottom, 50);

      if (actions.length === 0) break;
    }

    await invoke("show_window").catch(() => {});
    setIsAutomating(false);
    setAutomationStatus("");

    if (round >= MAX_AUTOMATION_ROUNDS) {
      setMessages((prev) => [
        ...prev,
        {
          role: "ai",
          text: `Reached the ${MAX_AUTOMATION_ROUNDS}-round limit. Task may not be fully complete.`,
          isAutomation: true,
        },
      ]);
    }

    setTimeout(scrollToBottom, 50);
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

    setMessages((prev) => [
      ...prev,
      { role: "ai", text: aiText, isAutomation: hasActions },
    ]);

    const finalHistory: HistoryEntry[] = [
      ...newHistory,
      { role: "assistant", content: aiText },
    ];
    setHistory(finalHistory);
    setTimeout(scrollToBottom, 50);

    if (hasActions) {
      await runAutomationLoop(
        actions,
        finalHistory,
        userText || "complete the task on screen"
      );
    }
  };

  const analyzeScreen = async (base64Image: string): Promise<{
    answer: string;
    type: "multiple_choice" | "text_input";
    confidence: number;
  } | null> => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tokenRef.current) headers["Authorization"] = `Bearer ${tokenRef.current}`;

      const res = await fetch(ANALYZE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ base64Image }),
      });

      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  };

  const findAndClickAnswer = async (
    base64Image: string,
    answerText: string
  ): Promise<boolean> => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tokenRef.current) headers["Authorization"] = `Bearer ${tokenRef.current}`;

      const res = await fetch(SERVER_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          base64Image,
          message: `Find the text "${answerText}" on screen and click it. The text is a clickable answer option. Emit ONLY an [ACTION:click:X:Y] tag for its center coordinates. Nothing else.`,
          history: [],
        }),
      });

      const data = await res.json();
      const rawText = data.result || "";
      const { actions } = parseAutomationActions(rawText);

      const clickAction = actions.find((a) => a.type === "click");
      if (clickAction && clickAction.x !== undefined && clickAction.y !== undefined) {
        await invoke("hide_window").catch(() => {});
        await sleep(150);
        setAutomationStatus(`Clicking "${answerText}"...`);
        await invoke("click_at", { x: clickAction.x, y: clickAction.y });
        await sleep(600);
        await invoke("show_window").catch(() => {});
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };

  // ── One-tap auto button ────────────────────────────────────────────────────
  const handleAutoAnswer = async () => {
    if (isLoading || isAutomating) return;
    setIsAutomating(true);
    setAutomationStatus("Capturing screen...");

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        text: "Auto-answering quiz...",
      },
    ]);

    let round = 0;

    while (round < MAX_AUTOMATION_ROUNDS) {
      round++;

      const screenBase64 = await invoke<string>("capture_screen");
      setAutomationStatus(`Round ${round} - analyzing question...`);

      const analysis = await analyzeScreen(screenBase64);

      if (!analysis) {
        setMessages((prev) => [
          ...prev,
          {
            role: "ai",
            text: "Could not analyze screen.",
            isAutomation: true,
          },
        ]);
        break;
      }

      setAutomationStatus(`Answer: "${analysis.answer}" - locating...`);
      setMessages((prev) => [
        ...prev,
        {
          role: "ai",
          text: `${analysis.answer}`,
          isAutomation: true,
        },
      ]);

      if (analysis.type === "multiple_choice") {
        const clicked = await findAndClickAnswer(screenBase64, analysis.answer);
        if (!clicked) {
          setMessages((prev) => [
            ...prev,
            {
              role: "ai",
              text: "Could not locate answer on screen. Stopping.",
              isAutomation: true,
            },
          ]);
          break;
        }
      } else {
        await invoke("hide_window").catch(() => {});
        await sleep(150);
        await invoke("click_at", { x: 0.5, y: 0.55 });
        await sleep(150);
        await invoke("type_text", { text: analysis.answer });
        await sleep(150);
        await invoke("type_text", { text: "\n" });
        await sleep(600);
        await invoke("show_window").catch(() => {});
      }

      const afterScreenshot = await invoke<string>("capture_screen");
      setAutomationStatus(`Round ${round} - checking progress...`);

      const checkRes = await fetch(SERVER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
        },
        body: JSON.stringify({
          base64Image: afterScreenshot,
          message:
            "[AUTO] Is the quiz or task fully complete with no more questions remaining? Reply with only YES or NO.",
          history: [],
        }),
      });
      const checkData = await checkRes.json();
      const checkText = (checkData.result || "").trim().toUpperCase();

      if (checkText.startsWith("YES")) {
        setMessages((prev) => [
          ...prev,
          {
            role: "ai",
            text: "✓ Task complete.",
            isAutomation: true,
          },
        ]);
        break;
      }

      setTimeout(scrollToBottom, 50);
    }

    setIsAutomating(false);
    setAutomationStatus("");
    setTimeout(scrollToBottom, 50);
  };

  const handleSubmit = async () => {
    if (!message.trim() || isLoading || isAutomating) return;
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
    setMessages((prev) => [
      ...prev,
      { role: "user", text: userText || "", screenshotOnly: !userText },
    ]);
    await sendToServer(userText, screenBase64);
  };

  const handleAskGroq = useCallback(
    async (base64Image: string, userMessage?: string) => {
      const userText = userMessage?.trim() || "";
      setMessages((prev) => [
        ...prev,
        { role: "user", text: userText || "", screenshotOnly: !userText },
      ]);
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

  const isLimitReached =
    messages.length > 0 && messages[messages.length - 1].isLimit;
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
                    ) : (
                      msg.text
                    )}
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
                <div
                  key={i}
                  className={`hud-ai-response${msg.isAutomation ? " hud-ai-automation" : ""}`}
                >
                  {msg.isAutomation && (
                    <span className="hud-automation-badge">⚡ automated</span>
                  )}
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
                  onClick={handleSubmit}
                  disabled={isBlocked || !message.trim()}
                  title="Send"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2 21l21-9L2 3v7l15 2-15 2z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
