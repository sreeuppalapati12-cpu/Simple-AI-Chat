import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { getHealthCheckQueryKey, useHealthCheck } from '@workspace/api-client-react';
import { ArrowDown, ArrowUp, Check, CircleStop, Copy, Plus, Sparkles } from 'lucide-react';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

type Message = { role: 'user' | 'assistant'; content: string };

const queryClient = new QueryClient();
const promptIdeas = [
  { label: 'Make a good morning routine', icon: '01' },
  { label: 'Explain something I keep hearing', icon: '02' },
  { label: 'Help me put a meal together', icon: '03' },
];

function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const retryRef = useRef<{ request: Message[]; responseIndex: number } | null>(null);
  const health = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30_000 },
  });
  const serviceReady = health.data?.status === 'ok' || health.data?.status === 'healthy';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function streamReply(request: Message[], responseIndex: number) {
    const controller = new AbortController();
    controllerRef.current = controller;
    setStreaming(true);
    setError('');
    let accumulated = '';
    const applyText = (next: string) => {
      accumulated += next;
      setMessages((current) => current.map((message, index) =>
        index === responseIndex ? { ...message, content: accumulated } : message,
      ));
    };
    const handlePayload = (raw: string) => {
      if (!raw.trim()) return false;
      try {
        const payload = JSON.parse(raw) as { content?: string; done?: boolean; error?: string };
        if (payload.error) throw new Error(payload.error);
        if (typeof payload.content === 'string') applyText(payload.content);
        return payload.done === true;
      } catch (caught) {
        if (caught instanceof SyntaxError) return false;
        throw caught;
      }
    };

    try {
      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ messages: request }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let message = `The reply couldn’t start (${response.status}). Try again in a moment.`;
        try {
          const payload = await response.json() as { error?: string };
          if (payload.error) message = payload.error;
        } catch { /* Keep the useful HTTP fallback. */ }
        throw new Error(message);
      }
      if (!response.body) throw new Error('This connection cannot stream a reply. Please try again.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;
      while (!done) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          if (handlePayload(line.slice(5).trim())) done = true;
        }
        if (result.done) {
          if (buffer.startsWith('data:')) handlePayload(buffer.slice(5).trim());
          break;
        }
      }
      if (!accumulated.trim() && !controller.signal.aborted) {
        throw new Error('No reply came through. Please try once more.');
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        if (!accumulated.trim()) {
          setMessages((current) => current.filter((_, index) => index !== responseIndex));
        }
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
      if (!accumulated.trim()) {
        setMessages((current) => current.filter((_, index) => index !== responseIndex));
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setStreaming(false);
      }
    }
  }

  function sendMessage(value = draft) {
    const content = value.trim();
    if (!content || streaming) return;
    if (content.length > 4000) {
      setNotice('Keep each message under 4,000 characters.');
      return;
    }
    if (messages.length + 2 > 30) {
      setNotice('This conversation has reached its 30-message limit. Start a fresh one to keep going.');
      return;
    }
    const request = [...messages, { role: 'user' as const, content }];
    const responseIndex = request.length;
    setMessages([...request, { role: 'assistant', content: '' }]);
    setDraft('');
    setError('');
    setNotice('');
    retryRef.current = { request, responseIndex };
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    void streamReply(request, responseIndex);
  }

  function retryReply() {
    if (!retryRef.current || streaming) return;
    const { request } = retryRef.current;
    const responseIndex = request.length;
    retryRef.current = { request, responseIndex };
    setMessages([...request, { role: 'assistant', content: '' }]);
    void streamReply(request, responseIndex);
  }

  function startFresh() {
    controllerRef.current?.abort();
    setMessages([]);
    setDraft('');
    setError('');
    setNotice('');
    retryRef.current = null;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function copyMessage(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedAt(index);
      window.setTimeout(() => setCopiedAt(null), 1400);
    } catch {
      setNotice('Clipboard access is unavailable in this browser.');
    }
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    sendMessage();
  }

  const atLimit = messages.length >= 30;

  return (
    <main className="chat-shell chat-grain relative flex min-h-[100dvh] flex-col overflow-hidden text-foreground">
      <header className="relative z-10 flex h-[72px] shrink-0 items-center justify-between border-b border-[hsl(var(--border)/.72)] px-5 sm:px-9">
        <button
          type="button"
          onClick={startFresh}
          data-testid="button-new-chat"
          aria-label="Start a new chat"
          className="group flex items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <span className="grid size-9 place-items-center rounded-[13px] bg-primary text-primary-foreground shadow-[0_5px_14px_hsl(173_39%_31%/.18)] transition-transform duration-200 group-hover:rotate-[-5deg]">
            <Sparkles size={17} strokeWidth={1.8} />
          </span>
          <span className="flex flex-col">
            <span className="font-[Manrope] text-[15px] font-extrabold tracking-[-.04em]">little things</span>
            <span className="mt-[-1px] text-[10px] font-medium uppercase tracking-[.16em] text-muted-foreground">A chat with Gemini</span>
          </span>
        </button>

        <div className="flex items-center gap-3">
          <div
            className="hidden items-center gap-2 rounded-full border border-border/80 bg-card/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground sm:flex"
            data-testid="status-connection"
            aria-live="polite"
          >
            <span className={`size-1.5 rounded-full ${health.isError ? 'bg-destructive' : health.isLoading ? 'bg-amber-500 animate-pulse' : 'bg-[hsl(158_38%_43%)]'}`} />
            {health.isError ? 'Connection interrupted' : health.isLoading ? 'Checking connection' : serviceReady ? 'Ready when you are' : 'Ready when you are'}
          </div>
          <button
            type="button"
            onClick={startFresh}
            data-testid="button-clear-chat"
            className="flex h-9 items-center gap-2 rounded-full border border-border/80 bg-card/60 px-3.5 text-xs font-semibold text-foreground/75 transition-all duration-200 hover:border-primary/30 hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Plus size={14} strokeWidth={2.2} />
            <span className="hidden sm:inline">New chat</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </header>

      <section className="relative z-[1] flex min-h-0 flex-1 flex-col">
        {messages.length === 0 ? (
          <div className="mx-auto flex w-full max-w-[790px] flex-1 flex-col justify-center px-5 pb-10 pt-12 sm:px-9 sm:pt-16">
            <div className="mb-5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.19em] text-primary">
              <span className="h-px w-7 bg-primary/45" />
              A little space to think
            </div>
            <h1 className="max-w-[690px] font-[Manrope] text-[clamp(2.7rem,7vw,5.4rem)] font-semibold leading-[.99] tracking-[-.075em] text-foreground">
              What’s on your
              <br />
              <span className="text-primary">mind today?</span>
            </h1>
            <p className="mt-6 max-w-[430px] text-[15px] leading-7 text-muted-foreground sm:text-[16px]">
              Ask the small thing, the big thing, or the thing you’re not quite sure how to phrase yet.
            </p>

            <div className="mt-11 grid gap-2.5 sm:mt-14 sm:grid-cols-3">
              {promptIdeas.map((idea, index) => (
                <button
                  key={idea.label}
                  type="button"
                  onClick={() => sendMessage(idea.label)}
                  data-testid={`button-prompt-${index + 1}`}
                  className="group flex min-h-[91px] flex-col justify-between rounded-[17px] border border-border/85 bg-card/55 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/35 hover:bg-card hover:shadow-[0_10px_24px_hsl(218_25%_19%/.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span className="font-mono text-[10px] tracking-[.09em] text-primary/70">{idea.icon}</span>
                  <span className="flex items-center justify-between gap-2 text-[13px] font-semibold tracking-[-.015em]">
                    {idea.label}
                    <ArrowDown className="rotate-[-45deg] text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-primary" size={15} />
                  </span>
                </button>
              ))}
            </div>
            <div className="mt-8 flex items-center gap-2 text-[11px] text-muted-foreground/80" data-testid="text-session-note">
              <span className="grid size-[18px] place-items-center rounded-full border border-border/80 text-[9px]">i</span>
              This conversation stays in this tab only.
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-[790px] flex-1 flex-col px-5 sm:px-9">
            <div className="flex-1 pb-6 pt-10 sm:pt-14" aria-live="polite" data-testid="list-messages">
              <div className="mb-10 flex items-center justify-between border-b border-border/70 pb-4">
                <span className="text-[11px] font-semibold uppercase tracking-[.16em] text-muted-foreground">A conversation</span>
                <span className="font-mono text-[10px] text-muted-foreground/75" data-testid="text-message-count">{messages.length} / 30</span>
              </div>
              <div className="space-y-8 sm:space-y-10">
                {messages.map((message, index) => (
                  <article
                    key={`${message.role}-${index}`}
                    className={`message-enter ${message.role === 'user' ? 'ml-auto max-w-[88%] sm:max-w-[80%]' : 'mr-auto w-full'}`}
                    data-testid={`message-${message.role}-${index}`}
                  >
                    {message.role === 'user' ? (
                      <div className="rounded-[20px] rounded-br-[7px] bg-[hsl(173_39%_31%)] px-5 py-3.5 text-[14px] leading-[1.75] text-[hsl(42_38%_97%)] shadow-[0_4px_12px_hsl(173_39%_31%/.12)] whitespace-pre-wrap break-words">
                        {message.content}
                      </div>
                    ) : (
                      <div className="flex items-start gap-3.5">
                        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[11px] bg-accent text-primary">
                          <Sparkles size={15} strokeWidth={1.9} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 text-[11px] font-bold tracking-[.01em] text-foreground/75">Gemini</div>
                          {message.content ? (
                            <div className="whitespace-pre-wrap break-words text-[14px] leading-[1.85] text-foreground/90 sm:text-[15px]" data-testid={`text-response-${index}`}>
                              {message.content}
                              {streaming && index === messages.length - 1 && <span className="ml-0.5 inline-block h-[17px] w-[2px] translate-y-[3px] animate-pulse bg-primary/75" aria-label="Writing" />}
                            </div>
                          ) : streaming && index === messages.length - 1 ? (
                            <div className="flex h-7 items-center gap-1.5" data-testid="status-thinking" aria-label="Gemini is thinking">
                              <span className="typing-dot size-1.5 rounded-full bg-primary/70" />
                              <span className="typing-dot size-1.5 rounded-full bg-primary/70" />
                              <span className="typing-dot size-1.5 rounded-full bg-primary/70" />
                            </div>
                          ) : null}
                          {message.content && !streaming && (
                            <button
                              type="button"
                              onClick={() => void copyMessage(message.content, index)}
                              data-testid={`button-copy-${index}`}
                              className="mt-3 flex items-center gap-1.5 rounded-md px-1 py-1 text-[10px] font-semibold text-muted-foreground/70 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                              {copiedAt === index ? <Check size={12} /> : <Copy size={12} />}
                              {copiedAt === index ? 'Copied' : 'Copy'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {error && (
                <div className="ml-11 mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[hsl(var(--destructive)/.22)] bg-[hsl(var(--destructive)/.055)] px-4 py-3 text-[12px] text-[hsl(var(--destructive))]" data-testid="status-error" role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={retryReply} data-testid="button-retry" className="font-bold underline underline-offset-2 hover:no-underline">Try again</button>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>
        )}
      </section>

      <footer className="relative z-[2] shrink-0 px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3 sm:px-9 sm:pb-7">
        <div className="mx-auto w-full max-w-[790px]">
          {notice && <p className="mb-2 px-1 text-xs text-[hsl(var(--destructive))]" data-testid="status-notice" role="status">{notice}</p>}
          <form
            onSubmit={submitForm}
            className="relative rounded-[20px] border border-[hsl(var(--border)/.95)] bg-card/90 p-2 shadow-[0_12px_35px_hsl(218_25%_19%/.08),0_2px_6px_hsl(218_25%_19%/.04)] backdrop-blur-md transition-all duration-200 focus-within:border-primary/45 focus-within:shadow-[0_12px_38px_hsl(173_39%_31%/.11)]"
          >
            <label htmlFor="chat-composer" className="sr-only">Your message</label>
            <textarea
              ref={textareaRef}
              id="chat-composer"
              value={draft}
              maxLength={4000}
              rows={1}
              placeholder="Ask anything, big or small..."
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice('');
                event.target.style.height = 'auto';
                event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              disabled={streaming || atLimit}
              data-testid="input-message"
              className="block max-h-40 min-h-[46px] w-full resize-none bg-transparent px-3.5 pb-2 pt-3 text-[14px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-60"
            />
            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground/75">
                <span className="font-mono">{draft.length}/4000</span>
                <span className="h-3 w-px bg-border" />
                <span className="hidden sm:inline">Return to send · Shift + Return for a new line</span>
                <span className="sm:hidden">Return to send</span>
              </div>
              {streaming ? (
                <button
                  type="button"
                  onClick={() => controllerRef.current?.abort()}
                  data-testid="button-stop"
                  aria-label="Stop generating"
                  className="grid size-9 place-items-center rounded-[12px] border border-border bg-background text-foreground/75 transition-all hover:border-destructive/40 hover:bg-[hsl(var(--destructive)/.07)] hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <CircleStop size={17} strokeWidth={1.8} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!draft.trim() || atLimit}
                  data-testid="button-send"
                  aria-label="Send message"
                  className="grid size-9 place-items-center rounded-[12px] bg-primary text-primary-foreground shadow-[0_3px_8px_hsl(173_39%_31%/.19)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[hsl(173_42%_26%)] active:translate-y-0 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60 disabled:shadow-none"
                >
                  <ArrowUp size={18} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </form>
          <div className="mt-3 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70" data-testid="text-ai-disclaimer">
            <span className="size-1 rounded-full bg-primary/60" />
            Gemini can make mistakes. For the important things, double-check.
          </div>
        </div>
      </footer>
    </main>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
