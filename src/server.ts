import { createWorkersAI } from "workers-ai-provider";
import {
  callable,
  routeAgentEmail,
  routeAgentRequest,
  type Schedule
} from "agents";
import { createCatchAllEmailResolver, type AgentEmail } from "agents/email";
import { Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import { pruneMessages, type ToolSet } from "ai";
import {
  buildSystemPrompt,
  extractAssistantText,
  findEmailReplyContextMessageId,
  getTaskDescription,
  inlineDataUrls,
  parseInboundEmail,
  renderEmailHtml,
  runInboundEmailTurn,
  sendReminderEmail,
  type ScheduledEmailReply,
  type ScheduledTaskPayload
} from "./utils";
import { createTools } from "./tools";

export class MyAgent extends Think<Env> {
  maxSteps = 5;
  private emailReplyContexts = new Map<string, ScheduledEmailReply>();

  onStart() {
    // Close the popup once an MCP server finishes its OAuth flow.
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

  getModel() {
    const workersai = createWorkersAI({ binding: this.env.AI });
    return workersai("@cf/moonshotai/kimi-k2.6", {
      sessionAffinity: this.sessionAffinity
    });
  }

  getSystemPrompt() {
    return buildSystemPrompt();
  }

  getTools(): ToolSet {
    return createTools(this.resolveEmailReplyContext());
  }

  beforeTurn(ctx: TurnContext): TurnConfig {
    return {
      messages: pruneMessages({
        messages: inlineDataUrls(ctx.messages),
        toolCalls: "before-last-2-messages"
      })
    };
  }

  // Reply metadata is keyed by the triggering message id (set in onEmail)
  // because the scheduling tools run without getCurrentAgent().email.
  private resolveEmailReplyContext(): ScheduledEmailReply | undefined {
    const messageId = findEmailReplyContextMessageId(
      this.messages,
      this.emailReplyContexts
    );
    return messageId ? this.emailReplyContexts.get(messageId) : undefined;
  }

  async executeTask(
    payload: ScheduledTaskPayload,
    _task: Schedule<ScheduledTaskPayload>
  ) {
    const description = getTaskDescription(payload);
    console.log(`Executing scheduled task: ${description}`);

    if (typeof payload !== "string" && payload.emailReply) {
      await sendReminderEmail(
        this,
        this.env.EMAIL,
        payload.emailReply,
        description
      );
    }

    // broadcast() rather than saveMessages() so the notification stays out of
    // chat history — otherwise the model could treat it as input and loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }

  async onEmail(email: AgentEmail) {
    const inbound = await parseInboundEmail(email);
    if (!inbound) {
      console.log(`Skipping auto-reply email from ${email.from}`);
      return;
    }
    const beforeCount = this.messages.length;
    const result = await runInboundEmailTurn(
      this,
      this.emailReplyContexts,
      inbound
    );

    if (result.status !== "completed") {
      console.warn(
        `Skipping email reply: chat turn status was ${result.status}`
      );
      return;
    }

    const replyBody = extractAssistantText(
      this.messages.slice(beforeCount + 1)
    );
    if (!replyBody) {
      console.warn("Empty assistant reply, no email sent");
      return;
    }

    try {
      await this.replyToEmail(email, {
        fromName: "Agent Starter",
        body: await renderEmailHtml(replyBody),
        contentType: "text/html"
      });
    } catch (error) {
      console.error("Failed to send email reply:", error);
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

  // Routes every inbound message to one shared MyAgent instance.
  // https://developers.cloudflare.com/agents/api-reference/email/
  async email(message, env) {
    await routeAgentEmail(message, env, {
      resolver: createCatchAllEmailResolver("MyAgent", "default")
    });
  }
} satisfies ExportedHandler<Env>;
