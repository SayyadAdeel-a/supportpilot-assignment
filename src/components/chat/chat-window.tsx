"use client";

import {
  BadgeHelp,
  Box,
  FileCheck2,
  Menu,
  MessageSquareText,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ModelDefinition, ModelKey } from "@/lib/bedrock/types";
import type { ApiResponse, ChatMessage, SourceCitation, TicketSummary } from "@/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip } from "@/components/ui/tooltip";
import { ModelSelector } from "@/components/model/model-selector";
import { ChatInput } from "./chat-input";
import { ChatMessage as Message } from "./chat-message";

const prompts = [
  "What is your return policy?",
  "Where is my order ORD-1002?",
  "My order arrived damaged.",
  "Can I get a refund for my order?",
];

const starterMessage: ChatMessage = {
  id: "setup",
  role: "assistant",
  content:
    "This starter is ready for a candidate to connect Amazon Bedrock. Until the agent is implemented and a model is configured, I’ll report that honestly instead of generating a support answer.",
  createdAt: new Date(0).toISOString(),
  state: "complete",
};

export function ChatWindow({ models }: { models: Omit<ModelDefinition, "envVar">[] }) {
  const defaultKey = (models.find((model) => model.key === "claude-sonnet-5-5")?.key ?? models[0].key) as ModelKey;
  const [modelKey, setModelKey] = useState<ModelKey>(defaultKey);
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([starterMessage]);
  const [pending, setPending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const lastUserMessage = useMemo(() => [...messages].reverse().find((message) => message.role === "user")?.content, [messages]);

  function newConversation() {
    setConversationId(crypto.randomUUID());
    setMessages([starterMessage]);
    setSidebarOpen(false);
  }

  async function sendMessage(content: string) {
    if (pending) return;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      state: "complete",
    };
    const pendingId = crypto.randomUUID();
    setMessages((current) => [...current.filter((message) => message.state !== "error"), userMessage, {
      id: pendingId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      state: "pending",
    }]);
    setPending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message: content, modelKey }),
      });
      const result = (await response.json()) as ApiResponse<{
        message: string;
        citations?: SourceCitation[];
        ticket?: TicketSummary;
      }>;
      if (!result.ok) throw new Error(result.error.message);
      setMessages((current) => current.map((message) => message.id === pendingId
        ? {
            ...message,
            content: result.data.message,
            citations: result.data.citations,
            ticket: result.data.ticket,
            state: "complete",
          }
        : message));
    } catch (error) {
      setMessages((current) => current.map((message) => message.id === pendingId
        ? {
            ...message,
            content: error instanceof Error ? error.message : "Support is temporarily unavailable. Please try again.",
            state: "error",
          }
        : message));
    } finally {
      setPending(false);
    }
  }

  const sidebar = (
    <aside className="flex h-full w-72 flex-col border-r border-slate-200/80 bg-white/80 p-4 backdrop-blur-xl">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <div className="relative grid size-10 place-items-center rounded-2xl bg-slate-950 text-white shadow-lg shadow-slate-300">
            <Sparkles className="size-5 text-teal-300" />
            <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-white bg-teal-500" />
          </div>
          <div>
            <p className="font-bold tracking-tight text-slate-950">SupportPilot AI</p>
            <p className="text-xs text-slate-500">Customer care workspace</p>
          </div>
        </div>
        <Button className="lg:hidden" variant="ghost" size="icon" onClick={() => setSidebarOpen(false)} aria-label="Close conversations">
          <X className="size-5" />
        </Button>
      </div>
      <Button onClick={newConversation} variant="dark" className="mt-7 w-full justify-start">
        <Plus className="size-4" /> New conversation
      </Button>
      <div className="mt-7 flex items-center justify-between px-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">Conversations</p>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">Local</span>
      </div>
      <button className="mt-3 flex w-full items-start gap-3 rounded-xl bg-teal-50 px-3 py-3 text-left ring-1 ring-teal-100">
        <MessageSquareText className="mt-0.5 size-4 shrink-0 text-teal-700" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-slate-900">New support request</span>
          <span className="mt-0.5 block truncate text-xs text-slate-500">Starter conversation</span>
        </span>
      </button>
      <div className="mt-auto rounded-2xl border border-slate-200 bg-slate-50 p-3.5">
        <div className="flex gap-2.5">
          <ShieldCheck className="size-5 shrink-0 text-teal-700" />
          <div>
            <p className="text-xs font-bold text-slate-800">Privacy by design</p>
            <p className="mt-1 text-[11px] leading-4 text-slate-500">AWS calls remain server-side. Mock identity is for local development only.</p>
          </div>
        </div>
      </div>
    </aside>
  );

  return (
    <main className="h-dvh min-h-[620px] p-0 sm:p-3 lg:p-5">
      <div className="mx-auto flex h-full max-w-[1500px] overflow-hidden border-slate-200 bg-white/60 shadow-[0_30px_100px_rgba(15,23,42,0.12)] sm:rounded-3xl sm:border">
        <div className="hidden lg:block">{sidebar}</div>
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 flex lg:hidden">
            <button aria-label="Close conversations" onClick={() => setSidebarOpen(false)} className="absolute inset-0 bg-slate-950/30 backdrop-blur-sm" />
            <div className="relative">{sidebar}</div>
          </div>
        )}

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-20 items-center justify-between gap-4 border-b border-slate-200/80 bg-white/80 px-4 backdrop-blur-xl sm:px-6">
            <div className="flex items-center gap-3">
              <Button className="lg:hidden" variant="ghost" size="icon" onClick={() => setSidebarOpen(true)} aria-label="Open conversations">
                <Menu className="size-5" />
              </Button>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="font-bold tracking-tight text-slate-950">Support assistant</h1>
                  <span className="hidden rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-700 sm:inline">Starter</span>
                </div>
                <p className="hidden text-xs text-slate-500 sm:block">Policies, orders, and support tickets in one place</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ModelSelector models={models} value={modelKey} onChange={setModelKey} />
              <span className="hidden sm:inline-flex">
                <Tooltip label="Responses should be grounded in policy evidence">
                  <Button variant="ghost" size="icon" aria-label="Evidence-based responses"><FileCheck2 className="size-5" /></Button>
                </Tooltip>
              </span>
            </div>
          </header>

          <div className="flex min-h-0 flex-1 flex-col bg-[radial-gradient(circle_at_50%_0%,rgba(20,184,166,0.055),transparent_27rem)]">
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto flex min-h-full max-w-3xl flex-col px-4 py-8 sm:px-8">
                {messages.length === 1 && (
                  <div className="mb-8 text-center">
                    <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-teal-100 text-teal-800"><BadgeHelp className="size-6" /></div>
                    <h2 className="mt-4 text-2xl font-bold tracking-tight text-slate-950">How can we help today?</h2>
                    <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">Ask about company policies, look up a sample order, or describe an issue that needs a support ticket.</p>
                    <div className="mt-6 grid gap-2 sm:grid-cols-2">
                      {prompts.map((prompt, index) => (
                        <Card key={prompt}>
                          <button onClick={() => sendMessage(prompt)} className="flex w-full items-center gap-3 p-3.5 text-left text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-600">
                              {index === 1 ? <Box className="size-4" /> : <MessageSquareText className="size-4" />}
                            </span>
                            {prompt}
                          </button>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-auto space-y-6">
                  {messages.map((message) => (
                    <Message key={message.id} message={message} onRetry={message.state === "error" && lastUserMessage ? () => sendMessage(lastUserMessage) : undefined} />
                  ))}
                </div>
              </div>
            </div>
            <div className="border-t border-slate-200/70 bg-white/75 px-4 py-4 backdrop-blur-xl sm:px-8">
              <div className="mx-auto max-w-3xl">
                <ChatInput onSubmit={sendMessage} disabled={pending} />
                <p className="mt-2 text-center text-[11px] text-slate-400">SupportPilot AI can make mistakes. Business actions must be confirmed by backend persistence.</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
