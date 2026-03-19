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
const LOGIN_URL = "https://sekotonjabulo-rgb.github.io/agrade-web/login.html?source=app";

const WEEKLY_CHECKOUT = "https://sparksocial.lemonsqueezy.com/checkout/buy/801ef0b0-f6fd-4a28-bac2-4f67e6d7333c";
const MONTHLY_CHECKOUT = "https://sparksocial.lemonsqueezy.com/checkout/buy/b7fb5b1f-3ebf-4654-992c-5c08e9c3eb08";

const supabase = createClient(
  "https://llabvdbcvilnbukroqxn.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsYWJ2ZGJjdmlsbmJ1a3JvcXhuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2OTQzNzQsImV4cCI6MjA4OTI3MDM3NH0.WLdB5hNXMHJ63JGwgXgY8TEEGz7k5AVbsV7aVDy6xQU"
);

interface Message {
  role: "user" | "ai";
  text: string;
  screenshotOnly?: boolean;
  isLimit?: boolean;
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

const stripMarkdown = (text: string): string => {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/\*(.+?)\*/gs, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/`(.+?)`/gs, '$1')
    .replace(/^\s*[-•]\s/gm, '· ');
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const [token, setToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleDeepLink = (url: string) => {
    try {
      console.log("handleDeepLink called with:", url);
      const parsed = new URL(url);
      const accessToken = parsed.searchParams.get("token");
      const refreshToken = parsed.searchParams.get("refresh");
      console.log("accessToken:", accessToken ? "present" : "missing");
      console.log("refreshToken:", refreshToken ? "present" : "missing");
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
      console.log("onAuthStateChange fired, session:", session ? "present" : "null");
      if (session?.access_token) {
        tokenRef.current = session.access_token;
        setToken(session.access_token);
        setAuthReady(true);
      } else if (authReady) {
        tokenRef.current = null;
        setToken(null);
        open(LOGIN_URL);
      } else {
        setAuthReady(true);
        open(LOGIN_URL);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const unlisten = onOpenUrl((urls) => {
      console.log("onOpenUrl received:", urls);
      handleDeepLink(urls[0]);
    });

    const unlistenTauri = listen("deep-link-received", (event) => {
      console.log("deep-link-received event:", event.payload);
      handleDeepLink(event.payload as string);
    });

    return () => {
      unlisten.then(fn => fn());
      unlistenTauri.then(fn => fn());
    };
  }, []);

  const handleUpgrade = async (plan: "weekly" | "monthly") => {
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id;
    const baseUrl = plan === "weekly" ? WEEKLY_CHECKOUT : MONTHLY_CHECKOUT;
    const checkoutUrl = userId ? `${baseUrl}?checkout[custom][user_id]=${userId}` : baseUrl;
    open(checkoutUrl);
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    tokenRef.current = null;
    setToken(null);
    setMessages([]);
    setHistory([]);
    open(LOGIN_URL);
  };

  const scrollToBottom = () => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  };

  const sendToServer = async (
    userText: string,
    base64Image?: string,
    currentHistory?: HistoryEntry[]
  ) => {
    const hist = currentHistory ?? history;
    setIsLoading(true);
    setTimeout(scrollToBottom, 50);

    const updatedHistory: HistoryEntry[] = [
      ...hist,
      { role: "user", content: userText || "[screenshot captured]" },
    ];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
        setMessages(prev => [...prev, { role: "ai", text: "Server is waking up — try again in 30 seconds." }]);
      }, 15000);

      const body: Record<string, unknown> = { message: userText, history: updatedHistory };
      if (base64Image) body.base64Image = base64Image;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (tokenRef.current) headers["Authorization"] = `Bearer ${tokenRef.current}`;

      console.log("Sending request, token:", tokenRef.current ? "present" : "missing");

      const res = await fetch(SERVER_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const data = await res.json();

      if (res.status === 429) {
        setMessages(prev => [...prev, {
          role: "ai",
          text: "",
          isLimit: true,
        }]);
        setIsLoading(false);
        return;
      }

      if (res.status === 401) {
        await supabase.auth.signOut();
        tokenRef.current = null;
        setToken(null);
        open(LOGIN_URL);
        setIsLoading(false);
        return;
      }

      const aiText = stripMarkdown(data.result || data.message || "No response received.");
      setMessages(prev => [...prev, { role: "ai", text: aiText }]);
      setHistory([...updatedHistory, { role: "assistant", content: aiText }]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== "AbortError") {
        setMessages(prev => [...prev, { role: "ai", text: "Error: " + String(err) }]);
      }
    } finally {
      setIsLoading(false);
      setTimeout(scrollToBottom, 50);
    }
  };

  const handleSubmit = async () => {
    if (!message.trim() || isLoading) return;
    const userText = message.trim();
    setMessage("");
    setMessages(prev => [...prev, { role: "user", text: userText }]);
    await sendToServer(userText);
  };

  const handleCaptureWithMessage = async () => {
    if (isLoading) return;
    const userText = message.trim();
    const screenBase64 = await invoke<string>("capture_screen");
    setMessage("");
    setMessages(prev => [...prev, { role: "user", text: userText || "", screenshotOnly: !userText }]);
    await sendToServer(userText, screenBase64);
  };

  const handleAskGroq = useCallback(async (base64Image: string, userMessage?: string) => {
    const userText = userMessage?.trim() || "";
    setMessages(prev => [...prev, { role: "user", text: userText || "", screenshotOnly: !userText }]);
    await sendToServer(userText, base64Image, history);
  }, [history]);

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
        const win = getCurrentWindow();
        await win.show();
        await win.setFocus();
      });
      await register("Control+H", async () => { await getCurrentWindow().hide(); });
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
    return () => { shortcuts.forEach(s => unregister(s)); };
  }, [handleAskGroq, message]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };

  const copyLastResponse = () => {
    const lastAi = [...messages].reverse().find(m => m.role === "ai" && !m.isLimit);
    if (lastAi) navigator.clipboard.writeText(lastAi.text);
  };

  const clearConversation = () => { setMessages([]); setHistory([]); };

  const isLimitReached = messages.length > 0 && messages[messages.length - 1].isLimit;

  return (
    <div className="hud-root">
      <div className="hud-panel">
        <div className="hud-header" data-tauri-drag-region>
          <span className="hud-title" data-tauri-drag-region>agrade</span>
          <div className="hud-header-actions">
            {messages.length > 0 && !isLimitReached && (
              <>
                <button className="hud-action-btn" onClick={copyLastResponse} title="Copy last response">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                </button>
                <button className="hud-action-btn" onClick={clearConversation} title="Clear conversation">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6"/><path d="M14 11v6"/>
                  </svg>
                </button>
              </>
            )}
            <button className="hud-action-btn" onClick={handleSignOut} title="Sign out">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
            </button>
            <div className={`hud-status ${isLoading ? "active" : ""}`} />
          </div>
        </div>
        <div className="hud-body" ref={bodyRef}>
          <div className="hud-messages">
            {messages.map((msg, i) => (
              msg.role === "user" ? (
                <div key={i} className="hud-bubble-row user">
                  <div className="hud-bubble user">
                    {msg.screenshotOnly ? (
                      <div className="hud-screenshot-tag">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                          <circle cx="12" cy="13" r="4"/>
                        </svg>
                        Screenshot captured
                      </div>
                    ) : msg.text}
                  </div>
                </div>
              ) : msg.isLimit ? (
                <div key={i} className="hud-limit-block">
                  <p className="hud-limit-text">You've used your 5 free messages</p>
                  <div className="hud-upgrade-options">
                    <button className="hud-upgrade-btn" onClick={() => handleUpgrade("weekly")}>
                      Weekly — $6
                    </button>
                    <button className="hud-upgrade-btn" onClick={() => handleUpgrade("monthly")}>
                      Monthly — $14
                    </button>
                  </div>
                </div>
              ) : (
                <div key={i} className="hud-ai-response">{msg.text}</div>
              )
            ))}
            {isLoading && (
              <div className="hud-thinking">
                <span /><span /><span />
              </div>
            )}
          </div>
        </div>
        {!isLimitReached && (
          <div className="hud-footer">
            <div className="hud-footer-row">
              <button className="hud-icon-btn" onClick={handleCaptureWithMessage} disabled={isLoading} title="Capture screen">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
              </button>
              <div className="hud-input-row">
                <textarea
                  ref={inputRef}
                  className="hud-input"
                  placeholder="Ask anything about screen or conversation..."
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={isLoading}
                />
                <button className="hud-send-btn" onClick={handleSubmit} disabled={isLoading || !message.trim()} title="Send">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2 21l21-9L2 3v7l15 2-15 2z"/>
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
