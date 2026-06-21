# Email Agent

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/megaconfidence/email-agent)

An AI agent you reach by **email**. Send a message to an address on your domain and the agent reads it, does the work — answering questions, running tools, scheduling reminders — and emails you back. The same agent is also available through a real-time web chat UI.

Built entirely on Cloudflare with the [Agents SDK](https://developers.cloudflare.com/agents/) (via `@cloudflare/think`) on [Workers AI](https://developers.cloudflare.com/workers-ai/) — no API keys.

## Why

- **Email is the interface.** Nothing to install and no account to create — anyone with the address can delegate a task. The agent behaves the same way through the web chat UI.
- **All on Cloudflare.** Workers AI runs inference (no third-party keys or bills), Durable Objects hold per-agent state and run the scheduler, and Email Service sends and receives real mail. It scales to zero and hibernates when idle.
- **Durable and stateful.** Each agent remembers its conversation in SQLite, can schedule future work (including reminders that email you back), and can connect to MCP servers to gain new tools at runtime.

## How it works

Inbound mail is routed to a single shared `MyAgent` instance (a "shared inbox"):

1. Cloudflare Email Routing delivers the message to the Worker's `email()` handler, which calls `routeAgentEmail` with a catch-all resolver.
2. `MyAgent.onEmail` parses the message (`postal-mime`), ignores auto-replies, and runs one AI turn over the conversation.
3. The reply is rendered to HTML and sent back to the original sender via the Email Service binding.

Every email turn is saved to the agent's history, so it also appears live in the web chat UI — and vice versa.

## Features

- **Email in and out** — inbound parsing, auto-reply detection, and threaded HTML replies.
- **Web chat UI** — Kumo design system, streaming responses, image/vision input, reasoning display, and a debug view.
- **Tools** — three patterns: server-side (`getWeather`), client-side answered by the browser (`getUserTimezone`), and human-in-the-loop approval (`calculate`).
- **Scheduling** — one-time, delayed, and recurring (cron) tasks; reminders can be emailed to you when they fire.
- **MCP client** — connect external tool servers at runtime (with OAuth); their tools are merged into every turn automatically.

## Run it

### Deploy

Click **Deploy to Cloudflare** above, or from a clone:

```bash
npm install
npm run deploy
```

### Local development

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) for the chat UI.

### Enable email

Sending and receiving mail needs a one-time setup in the Cloudflare dashboard:

1. **Onboard a domain** under **Compute & AI → Email Service** and add the SPF/DKIM DNS records.
2. **Add an Email Routing rule** that sends inbound mail to this Worker (**Email → Email Routing → Routing rules → Send to a Worker**).

Then email any address on your domain and watch the reply land in your inbox.

## Project structure

```
src/
  server.ts    # MyAgent: model, system prompt, email handler, scheduling, MCP
  tools.ts     # Agent tools
  utils.ts     # Email parsing/rendering and helpers
  app.tsx      # Web chat UI
  client.tsx   # React entry point
  styles.css   # Tailwind + Kumo styles
wrangler.jsonc # Worker config and bindings (AI, Email, Durable Object)
```

## Learn more

- [Agents SDK](https://developers.cloudflare.com/agents/)
- [Email for Agents](https://developers.cloudflare.com/agents/api-reference/email/)
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)

## License

MIT
