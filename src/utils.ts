import { getSchedulePrompt } from "agents/schedule";
import { isAutoReplyEmail, type AgentEmail } from "agents/email";
import PostalMime, { type Email } from "postal-mime";
import { marked } from "marked";
import EmailReplyParser from "email-reply-parser";
import type { ModelMessage, UIMessage } from "ai";
// Type-only import avoids a runtime cycle with server.ts.
import type { MyAgent } from "./server";

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

export function buildSystemPrompt() {
  return `You are a helpful assistant.

You can be reached two ways: through this real-time chat UI, or by email — anyone can write to you and you'll reply from the same address. Inbound emails appear in this conversation as a message prefixed with "[Email] Subject: <subject>". When you see that prefix, you're replying to the original sender by email, so:
- Open with a brief greeting and close with a sign-off (e.g. "— Agent Starter").
- Keep the response self-contained: the recipient cannot click buttons, approve tools, or see streamed reasoning.
- Skip tools that require user approval or browser-side execution — there is no UI to satisfy them over email.
- Scheduling is supported over email. If you schedule a task from an email request, the scheduled notification will be sent later as an email reply to the original sender.
- Format with standard markdown (headings, lists, links, fenced code blocks, **bold**, *italic*). It's rendered to HTML before sending, so use it normally — but don't embed raw HTML tags or images, and avoid wide tables that won't render well in email clients.

For regular chat messages without that prefix, behave normally and use any tool you need.

${getSchedulePrompt({ date: new Date() })}`;
}

export function getTaskDescription(payload: ScheduledTaskPayload) {
  return typeof payload === "string" ? payload : payload.description;
}

export async function sendReminderEmail(
  agent: MyAgent,
  binding: SendEmail,
  emailReply: ScheduledEmailReply,
  description: string,
) {
  const references = getReferencesHeader(
    emailReply.references,
    emailReply.inReplyTo,
  );
  await agent.sendEmail({
    binding,
    to: emailReply.to,
    from: { email: emailReply.from, name: "Agent Starter" },
    subject: getReplySubject(emailReply.subject, description),
    text: `Reminder: ${description}`,
    html: renderReminderHtml(description),
    ...(emailReply.inReplyTo ? { inReplyTo: emailReply.inReplyTo } : {}),
    ...(references ? { headers: { References: references } } : {}),
  });
}

export type InboundEmail = {
  subject: string;
  body: string;
  replyContext: ScheduledEmailReply;
};

/**
 * Parse an inbound email into the fields needed to answer it, or `null` for
 * auto-replies (RFC 3834) that must be skipped to avoid mail loops.
 * https://developers.cloudflare.com/agents/api-reference/email/
 */
export async function parseInboundEmail(
  email: AgentEmail,
): Promise<InboundEmail | null> {
  const parsed = await PostalMime.parse(await email.getRaw());
  if (isAutoReplyEmail(parsed.headers)) return null;

  const subject = parsed.subject?.trim() || "(no subject)";
  return {
    subject,
    body: extractEmailBody(parsed),
    replyContext: buildEmailReplyContext(email, parsed, subject),
  };
}

/**
 * Inject an inbound email as a user turn and run it. The reply context is
 * registered for the turn's duration so the scheduling tools can resolve it.
 */
export async function runInboundEmailTurn(
  agent: MyAgent,
  contexts: Map<string, ScheduledEmailReply>,
  inbound: InboundEmail,
) {
  const messageId = crypto.randomUUID();
  try {
    return await agent.saveMessages((messages) => {
      contexts.set(messageId, inbound.replyContext);
      return [
        ...messages,
        {
          id: messageId,
          role: "user",
          parts: [
            {
              type: "text",
              text: `[Email]\nSubject: ${inbound.subject}\n\n${inbound.body}`,
            },
          ],
        },
      ];
    });
  } finally {
    contexts.delete(messageId);
  }
}

function extractEmailBody(parsed: Email) {
  const rawBody =
    parsed.text?.trim() ||
    // postal-mime renders HTML when there is no text part; strip tags.
    parsed.html
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() ||
    "(empty body)";
  // Drop quoted history and signatures so the model only sees fresh content.
  return emailReplyParser.parseReply(rawBody).trim() || rawBody;
}

function buildEmailReplyContext(
  email: AgentEmail,
  parsed: Email,
  subject: string,
): ScheduledEmailReply {
  const inReplyTo = parsed.messageId || email.headers.get("Message-ID")?.trim();
  const references =
    parsed.references || email.headers.get("References")?.trim();
  return {
    to: email.from,
    from: email.to,
    ...(subject ? { subject } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  };
}

/** Concatenate the text parts of every assistant message in `messages`. */
export function extractAssistantText(messages: UIMessage[]) {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts)
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" &&
        typeof (p as { text?: unknown }).text === "string" &&
        (p as { text: string }).text.trim().length > 0,
    )
    .map((p) => p.text)
    .join("\n\n");
}

export function getReplySubject(
  subject: string | undefined,
  description: string,
) {
  const trimmed = normalizeSubject(subject);
  const safeDescription = normalizeSubject(description).slice(
    0,
    MAX_REMINDER_SUBJECT_DESCRIPTION_LENGTH,
  );
  if (!trimmed)
    return safeDescription ? `Reminder: ${safeDescription}` : "Reminder";
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export function getReferencesHeader(
  references: string | undefined,
  inReplyTo: string | undefined,
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

export async function renderEmailHtml(markdown: string) {
  return wrapEmailHtml(await marked.parse(markdown, { gfm: true }));
}

export function renderReminderHtml(description: string) {
  return wrapEmailHtml(
    `<p><strong>Reminder:</strong> ${escapeHtml(description)}</p>`,
  );
}

function wrapEmailHtml(inner: string) {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;">${inner}</body></html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function findEmailReplyContextMessageId(
  messages: UIMessage[],
  contexts: Map<string, ScheduledEmailReply>,
) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user" && contexts.has(message.id)) {
      return message.id;
    }
  }
}

/**
 * Decode base64 data URIs on file parts to bytes. The AI SDK otherwise runs
 * `new URL(data)` on the string and tries to HTTP-fetch the data URI, which
 * fails.
 */
export function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
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
      }),
    };
  });
}
