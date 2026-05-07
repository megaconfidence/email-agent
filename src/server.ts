import { createWorkersAI } from "workers-ai-provider";
import {
  callable,
  routeAgentEmail,
  routeAgentRequest,
  type Schedule
} from "agents";
import {
  createCatchAllEmailResolver,
  isAutoReplyEmail,
  type AgentEmail
} from "agents/email";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UIMessage
} from "ai";
import PostalMime from "postal-mime";
import { marked } from "marked";
import EmailReplyParser from "email-reply-parser";
import { createTools } from "./tools";

// Multilingual reply parser (port of GitHub's email_reply_parser).
// Stateless — instantiated once and reused across email turns.
const emailReplyParser = new EmailReplyParser();
const MAX_REMINDER_SUBJECT_DESCRIPTION_LENGTH = 120;

export type ScheduledEmailReply = {
  to: string;
  from: string;
  subject?: string;
  inReplyTo?: string;
  references?: string;
};

export type ScheduledTaskPayload =
  | string
  | {
      description: string;
      emailReply?: ScheduledEmailReply;
    };

function getTaskDescription(payload: ScheduledTaskPayload) {
  return typeof payload === "string" ? payload : payload.description;
}

function getReplySubject(subject: string | undefined, description: string) {
  const trimmed = normalizeSubject(subject);
  const safeDescription = normalizeSubject(description).slice(
    0,
    MAX_REMINDER_SUBJECT_DESCRIPTION_LENGTH
  );
  if (!trimmed)
    return safeDescription ? `Reminder: ${safeDescription}` : "Reminder";
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

function normalizeSubject(value: string | undefined) {
  return (
    value
      ?.replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || ""
  );
}

function normalizeEmailHeader(value: string | undefined) {
  return value
    ?.replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getReferencesHeader(
  references: string | undefined,
  inReplyTo: string | undefined
) {
  const normalizedReferences = normalizeEmailHeader(references);
  const normalizedInReplyTo = normalizeEmailHeader(inReplyTo);
  if (!normalizedReferences) return normalizedInReplyTo;
  if (
    !normalizedInReplyTo ||
    normalizedReferences.includes(normalizedInReplyTo)
  ) {
    return normalizedReferences;
  }
  return `${normalizedReferences} ${normalizedInReplyTo}`;
}

function renderReminderHtml(description: string) {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;"><p><strong>Reminder:</strong> ${escapeHtml(description)}</p></body></html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findEmailReplyContextMessageId(
  messages: UIMessage[],
  contexts: Map<string, ScheduledEmailReply>
) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && contexts.has(message.id)) {
      return message.id;
    }
  }
}

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  private emailReplyContexts = new Map<string, ScheduledEmailReply>();

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });
    const emailReplyContextMessageId = findEmailReplyContextMessageId(
      this.messages,
      this.emailReplyContexts
    );
    const emailReplyContext = emailReplyContextMessageId
      ? this.emailReplyContexts.get(emailReplyContextMessageId)
      : undefined;

    if (emailReplyContextMessageId) {
      this.emailReplyContexts.delete(emailReplyContextMessageId);
    }

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are a helpful assistant that can understand images. You can check the weather, get the user's timezone, run calculations, and schedule tasks. When users share images, describe what you see and answer questions about them.

You can be reached two ways: through this real-time chat UI, or by email — anyone can write to you and you'll reply from the same address. Inbound emails appear in this conversation as a message prefixed with "[Email] Subject: <subject>". When you see that prefix, you're replying to the original sender by email, so:
- Open with a brief greeting and close with a sign-off (e.g. "— Agent Starter").
- Keep the response self-contained: the recipient cannot click buttons, approve tools, or see streamed reasoning.
- Skip tools that require user approval or browser-side execution (the calculate tool with large numbers, getUserTimezone) — there is no UI to satisfy them.
- Scheduling is supported over email. If you schedule a task from an email request, the scheduled notification will be sent later as an email reply to the original sender.
- Format with standard markdown (headings, lists, links, fenced code blocks, **bold**, *italic*). It's rendered to HTML before sending, so use it normally — but don't embed raw HTML tags or images, and avoid wide tables that won't render well in email clients.

For regular chat messages without that prefix, behave normally and use any tool you need.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,
        // Built-in tools (weather, timezone, calculate, scheduling).
        // Email reply metadata is captured per turn because saveMessages()
        // intentionally runs without getCurrentAgent().email.
        ...createTools(emailReplyContext)
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(
    payload: ScheduledTaskPayload,
    _task: Schedule<ScheduledTaskPayload>
  ) {
    const description = getTaskDescription(payload);

    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    if (typeof payload !== "string" && payload.emailReply) {
      const { emailReply } = payload;
      const references = getReferencesHeader(
        emailReply.references,
        emailReply.inReplyTo
      );
      await this.sendEmail({
        binding: this.env.EMAIL,
        to: emailReply.to,
        from: { email: emailReply.from, name: "Agent Starter" },
        subject: getReplySubject(emailReply.subject, description),
        text: `Reminder: ${description}`,
        html: renderReminderHtml(description),
        ...(emailReply.inReplyTo ? { inReplyTo: emailReply.inReplyTo } : {}),
        ...(references ? { headers: { References: references } } : {})
      });
    }

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }

  /**
   * Handle inbound email routed to this agent instance.
   *
   * Flow:
   *   1. Parse the raw RFC 822 message with postal-mime.
   *   2. Skip auto-replies (RFC 3834) to avoid mail loops.
   *   3. Append the email body as a user message via `saveMessages`,
   *      which triggers `onChatMessage` and persists the assistant
   *      response — making the exchange visible in the chat UI.
   *   4. Reply to the original sender with the assistant's text reply.
   *   5. Broadcast a notification for any connected UI clients.
   *
   * Note: tools that require approval (e.g. `calculate` on large
   * numbers) will stall here because there is no UI to approve from
   * an email context. Either guard those tools or run a separate
   * model call without them if that becomes a problem in production.
   */
  async onEmail(email: AgentEmail) {
    const raw = await email.getRaw();
    const parsed = await PostalMime.parse(raw);

    if (isAutoReplyEmail(parsed.headers)) {
      console.log(`Skipping auto-reply email from ${email.from}`);
      return;
    }

    const subject = parsed.subject?.trim() || "(no subject)";
    const rawBody =
      parsed.text?.trim() ||
      // postal-mime returns rendered HTML when no text part is present;
      // strip tags so the model sees something readable.
      parsed.html
        ?.replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim() ||
      "(empty body)";

    // For threaded replies, strip the quoted history and signatures so
    // the model only sees the sender's fresh content. Previous turns
    // are already in `this.messages`; quoting them wastes context and
    // makes the model see its own earlier replies twice. Falls back to
    // the raw body if the parser produces nothing.
    const body = emailReplyParser.parseReply(rawBody).trim() || rawBody;

    const beforeCount = this.messages.length;
    const emailMessageId = crypto.randomUUID();
    const inReplyTo =
      parsed.messageId || email.headers.get("Message-ID")?.trim();
    const references =
      parsed.references || email.headers.get("References")?.trim();
    const emailReplyContext: ScheduledEmailReply = {
      // Match replyToEmail's deferred-reply docs and live reply behavior.
      to: email.from,
      from: email.to,
      ...(subject ? { subject } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {})
    };

    // Inject the email content as a user turn. saveMessages waits for
    // the resulting assistant turn to finish before resolving, so by
    // the time it returns the reply is already in `this.messages`.
    const result = await (async () => {
      try {
        return await this.saveMessages((messages: UIMessage[]) => {
          this.emailReplyContexts.set(emailMessageId, emailReplyContext);

          return [
            ...messages,
            {
              id: emailMessageId,
              role: "user",
              parts: [
                {
                  type: "text",
                  text: `[Email]\nSubject: ${subject}\n\n${body}`
                }
              ]
            }
          ];
        });
      } finally {
        this.emailReplyContexts.delete(emailMessageId);
      }
    })();

    if (result.status !== "completed") {
      console.warn(
        `Skipping email reply: chat turn status was ${result.status}`
      );
      return;
    }

    // Concatenate text parts from every assistant message produced
    // for this turn (handles multi-step / tool-using responses).
    const replyBody = this.messages
      .slice(beforeCount + 1)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts)
      .filter(
        (p): p is { type: "text"; text: string } =>
          p.type === "text" &&
          typeof (p as { text?: unknown }).text === "string" &&
          (p as { text: string }).text.trim().length > 0
      )
      .map((p) => p.text)
      .join("\n\n");

    if (replyBody) {
      // The model writes markdown (same format the chat UI renders via
      // Streamdown). For email we convert it to HTML so mail clients
      // display headings, lists, and code blocks as intended instead of
      // showing raw asterisks and backticks. Wrap in a minimal document
      // with a system font stack so the body looks like a normal email.
      const renderedHtml = await marked.parse(replyBody, { gfm: true });
      const htmlBody = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;">${renderedHtml}</body></html>`;

      try {
        await this.replyToEmail(email, {
          fromName: "Agent Starter",
          body: htmlBody,
          contentType: "text/html"
        });
      } catch (error) {
        console.error("Failed to send email reply:", error);
      }
    } else {
      console.warn("Empty assistant reply, no email sent");
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  /**
   * Inbound Email Service handler. Cloudflare invokes this when an
   * Email Routing rule targets this Worker. The catch-all resolver
   * sends every message to the same `ChatAgent` instance, which
   * mirrors the single-agent / shared-inbox pattern.
   *
   * To shard by recipient address (e.g. support@, sales@), swap in
   * `createAddressBasedEmailResolver("ChatAgent")`. To verify signed
   * replies, combine with `createSecureReplyEmailResolver`.
   * https://developers.cloudflare.com/agents/api-reference/email/
   */
  async email(message, env) {
    await routeAgentEmail(message, env, {
      resolver: createCatchAllEmailResolver("ChatAgent", "default")
    });
  }
} satisfies ExportedHandler<Env>;
