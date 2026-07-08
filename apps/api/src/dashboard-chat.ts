import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ObjectId } from "mongodb";
import type { AgentDocument, Collections } from "./db.js";
import { requireAuth } from "./auth.js";
import { buildTrustedDashboardCorsHeaders } from "./cors.js";
import { ApiError } from "./errors.js";
import { instrumentProviderCall } from "./metrics.js";
import { EmailError, sendSiteEmailFromText } from "./email.js";
import { createEmailProvider } from "./providers/email-provider.js";
import {
  PhoneCallError,
  placeOutboundCall,
  type OutboundCallResult,
  type PhoneCallTranscriptTurn
} from "./phone-service.js";

const dashboardChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000)
});

const dashboardChatRequestSchema = z.object({
  messages: z.array(dashboardChatMessageSchema).min(1).max(24)
});

const openAIResponsesEndpoint = "https://api.openai.com/v1/responses";

const openClawDashboardInstructions = `
You are a simulated OpenClaw agent running inside the Barkan dashboard.

Identity:
- You are not the base dashboard assistant. You are the user's fake OpenClaw runtime with an Barkan real-world identity.
- Your available real-world tools include phone calls, email, and dashboard context. Payment cards are coming soon.
- Phone calls are a normal part of your tool belt. If calling someone is the most direct way to complete a task, use the phone tool.

Phone behavior:
- Test-only barber rule: if the user specifically asks to book, schedule, or change an appointment at a barber shop/barbershop/barber, do not search the web and do not ask for a number. Call +33757509222. Treat it as the only barber shop number for this demo.
- Use web search when the user names a business/place/person but does not provide a phone number.
- Prefer official or clearly authoritative public pages when selecting a phone number.
- If the user provides a phone number, use it directly after normalizing it to E.164 when possible.
- Before calling, infer a concise task brief for the voice agent: who it is calling, why, and what outcome it should achieve.
- When the user says "call X and ask/tell/propose Y", X is the person or business the voice agent must call and speak to directly. Do not interpret X as an intermediary who should be asked to call someone else unless the user explicitly says that.
- Write the call task as the message or question for the recipient, not as "ask the recipient to call/contact...".
- Do not pretend a call happened unless the place_phone_call tool result says it was queued or started.
- After a call tool result, summarize the status and the next best step. Mention when a call is simulated because ElevenLabs env vars are missing.

Style:
- Be decisive and operational, like an agent executing the user's real-world request.
- Keep answers concise.
- Format responses with GitHub-flavored Markdown.
- Use short status bullets when tools run.
`.trim();

export function registerDashboardChatRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  app.post("/api/dashboard/chat", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    if (!config.OPENAI_API_KEY) {
      throw new ApiError(503, "provider_error", "OpenAI is not configured");
    }

    const payload = dashboardChatRequestSchema.parse(request.body);
    const agents = await collections.agents
      .find({ ownerUserId: authContext.user._id, status: { $ne: "revoked" } })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    const sites: ChatAgentIdentity[] = agents.map((agent) => ({
      ...agent,
      domain: agent.runtime ?? "",
    }));

    const latestUserMessage = [...payload.messages].reverse().find((message) => message.role === "user");
    if (latestUserMessage && isPurchaseIntent(latestUserMessage.content)) {
      streamChatMessage(request, reply, config, "Card capability is coming soon.");
      return;
    }

    // If the latest message is an email instruction, drive the email tool and
    // stream a confirmation instead of a normal chat reply.
    if (latestUserMessage && isEmailIntent(latestUserMessage.content)) {
      const message = await runChatEmail(latestUserMessage.content, sites, collections, config);
      streamChatMessage(request, reply, config, message);
      return;
    }

    try {
      await streamOpenClawDashboardChat(request, reply, config, async (onCallEvent) =>
        runOpenClawDashboardChat(payload.messages, sites, collections, config, request, onCallEvent)
      );
    } catch (error) {
      request.log.error({ error }, "dashboard chat OpenClaw request failed");
      throw new ApiError(502, "provider_error", "AI response failed");
    }
  });
}

type DashboardChatMessage = z.infer<typeof dashboardChatMessageSchema>;

// Minimal identity view the chat tools need (backed by `agents` since task 010).
type ChatAgentIdentity = AgentDocument & { domain: string };

interface OpenAIResponseObject {
  id?: string;
  output?: Array<Record<string, unknown>>;
  output_text?: string;
}

interface OpenAIFunctionCall {
  callId: string;
  name: string;
  argumentsText: string;
}

interface DashboardChatCallEvent {
  type: "call_started" | "call_completed";
  call: {
    callId: string;
    toNumber: string;
    recipientName: string;
    agentIdentityName: string;
    task: string;
    status: string;
    simulated: boolean;
    durationSecs?: number | null;
    transcript?: PhoneCallTranscriptTurn[];
  };
}

async function runOpenClawDashboardChat(
  messages: DashboardChatMessage[],
  sites: ChatAgentIdentity[],
  collections: Collections,
  config: AppConfig,
  request: FastifyRequest,
  onCallEvent?: (event: DashboardChatCallEvent) => void
): Promise<string> {
  const input: Array<Record<string, unknown>> = messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
  const toolResults: Array<Record<string, unknown>> = [];

  for (let step = 0; step < 3; step++) {
    const response = await createOpenClawResponse(input, sites, config, request, step === 0);
    const functionCalls = extractFunctionCalls(response);
    if (functionCalls.length === 0) {
      const text = extractOpenAIResponseText(response);
      if (text) {
        return text;
      }

      if (toolResults.length > 0) {
        return formatToolOnlyFallback(toolResults);
      }

      return "I could not produce a response from the OpenClaw simulation.";
    }

    input.push(...(response.output ?? []));
    for (const functionCall of functionCalls) {
      const toolOutput = await runOpenClawTool(functionCall, sites, collections, config, onCallEvent);
      toolResults.push(toolOutput);
      input.push({
        type: "function_call_output",
        call_id: functionCall.callId,
        output: JSON.stringify(toolOutput)
      });
    }
  }

  return formatToolOnlyFallback(toolResults);
}

async function createOpenClawResponse(
  input: Array<Record<string, unknown>>,
  sites: ChatAgentIdentity[],
  config: AppConfig,
  request: FastifyRequest,
  includeWebSearch: boolean
): Promise<OpenAIResponseObject> {
  const body = {
    model: config.OPENAI_DASHBOARD_CHAT_MODEL,
    instructions: buildOpenClawInstructions(sites),
    input,
    tools: buildOpenClawTools(includeWebSearch),
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "none" },
    text: { verbosity: "low" },
    max_output_tokens: 1200
  };

  const response = await instrumentProviderCall("openai", "responses.dashboard_chat", () => fetch(buildOpenAIEndpointUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  }));

  if (response.ok) {
    return await response.json() as OpenAIResponseObject;
  }

  const responseText = await response.text();
  if (includeWebSearch && /web_search|web search|tool/i.test(responseText)) {
    request.log.warn({ status: response.status, body: responseText }, "dashboard chat retrying without hosted web search");
    return createOpenClawResponse(input, sites, config, request, false);
  }

  request.log.error({ status: response.status, body: responseText }, "dashboard chat OpenAI request failed");
  throw new Error("AI response failed");
}

function buildOpenClawInstructions(sites: ChatAgentIdentity[]): string {
  return `${openClawDashboardInstructions}

Dashboard identity context:
${JSON.stringify({
  agentIdentities: sites.map((site) => ({
    id: String(site._id),
    name: site.name,
    domain: site.domain,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt
  }))
})}`;
}

function buildOpenClawTools(includeWebSearch: boolean): Array<Record<string, unknown>> {
  return [
    ...(includeWebSearch ? [{ type: "web_search_preview" }] : []),
    {
      type: "function",
      name: "place_phone_call",
      description:
        "Place an outbound phone call using the agent identity phone capability. Use this when a task is best completed by calling a person, business, restaurant, office, or service.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          to_number: {
            type: "string",
            description: "Destination phone number. Prefer E.164 format like +14155550198."
          },
          task: {
            type: "string",
            description:
              "Concise call objective and requested outcome for the voice agent. Phrase it as what the agent should ask, tell, or propose to the recipient directly; do not ask the recipient to call/contact someone else unless the user explicitly requested delegation."
          },
          agent_identity_name: {
            type: "string",
            description: "Barkan agent identity name to use for the call. Use the current/default identity when unsure."
          },
          recipient_name: {
            type: "string",
            description: "Name of the person, business, or team being called."
          },
          context: {
            type: "string",
            description: "Useful details the voice agent should know before dialing."
          },
          source_url: {
            type: "string",
            description: "Public source used to find the number, when web search was needed."
          }
        },
        required: ["to_number", "task", "agent_identity_name", "recipient_name", "context", "source_url"]
      },
      strict: true
    }
  ];
}

function buildOpenAIEndpointUrl(): string {
  return openAIResponsesEndpoint;
}

async function runOpenClawTool(
  functionCall: OpenAIFunctionCall,
  sites: ChatAgentIdentity[],
  collections: Collections,
  config: AppConfig,
  onCallEvent?: (event: DashboardChatCallEvent) => void
): Promise<Record<string, unknown>> {
  if (functionCall.name !== "place_phone_call") {
    return {
      ok: false,
      error: `Unknown tool: ${functionCall.name}`
    };
  }

  const parsedArguments = parseFunctionArguments(functionCall.argumentsText);
  const agentIdentityName = readNonEmptyString(parsedArguments.agent_identity_name) || sites[0]?.name || "OpenClaw Agent";
  const recipientName = readNonEmptyString(parsedArguments.recipient_name) || "Recipient";
  const task = readNonEmptyString(parsedArguments.task) || "";
  const agent = sites.find((site) => site.name.toLowerCase() === agentIdentityName.toLowerCase()) ?? sites[0];
  if (!agent) {
    return {
      ok: false,
      tool: functionCall.name,
      error: "No agent identity is available for phone calls."
    };
  }

  try {
    const result = await placeOutboundCall(collections, config, {
      agent,
      toNumber: readNonEmptyString(parsedArguments.to_number) || "",
      task,
      recipientName,
      context: readNonEmptyString(parsedArguments.context),
      sourceUrl: readNonEmptyString(parsedArguments.source_url)
    }, { async: true });
    if ("approvalRequired" in result) {
      return {
        tool: functionCall.name,
        ok: false,
        status: "approval_required",
        approval_id: result.approval._id.toHexString(),
        approval_summary: result.approval.payloadSummary
      };
    }
    emitPhoneCallStarted(result, agent.name, task, recipientName, onCallEvent);

    return {
      tool: functionCall.name,
      ok: true,
      call_id: result.callId,
      status: result.status,
      from: result.from,
      to: result.to,
      simulated: result.simulated,
      finalStatus: result.status
    };
  } catch (error) {
    if (error instanceof PhoneCallError) {
      return {
        ok: false,
        tool: functionCall.name,
        error: error.message
      };
    }
    throw error;
  }
}

function emitPhoneCallStarted(
  result: OutboundCallResult,
  agentIdentityName: string,
  task: string,
  recipientName: string,
  onCallEvent?: (event: DashboardChatCallEvent) => void
) {
  onCallEvent?.({
    type: "call_started",
    call: {
      callId: result.callId,
      toNumber: result.to,
      recipientName,
      agentIdentityName,
      task,
      status: result.status,
      simulated: result.simulated
    }
  });
}

function extractFunctionCalls(response: OpenAIResponseObject): OpenAIFunctionCall[] {
  const calls: OpenAIFunctionCall[] = [];

  for (const item of response.output ?? []) {
    if (item.type !== "function_call") {
      continue;
    }

    const callId = readNonEmptyString(item.call_id);
    const name = readNonEmptyString(item.name);
    const argumentsText = readNonEmptyString(item.arguments) ?? readNonEmptyString(item.arguments_json) ?? "{}";
    if (callId && name) {
      calls.push({ callId, name, argumentsText });
    }
  }

  return calls;
}

function extractOpenAIResponseText(response: OpenAIResponseObject): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const contentItem of item.content as Array<Record<string, unknown>>) {
      const text = readNonEmptyString(contentItem.text);
      if (text) {
        parts.push(text);
      }
    }
  }

  return parts.join("").trim();
}

function formatToolOnlyFallback(toolResults: Array<Record<string, unknown>>): string {
  if (toolResults.length === 0) {
    return "I could not complete that task.";
  }

  return toolResults.map((toolResult) => {
    if (toolResult.ok) {
      const provider = toolResult.simulated ? "mock ElevenLabs" : "ElevenLabs";
      return `Phone call ${toolResult.status ?? "queued"} via ${provider} to ${toolResult.toNumber ?? "the target number"}.`;
    }

    return `Phone call failed: ${toolResult.error ?? "unknown error"}.`;
  }).join("\n");
}

function parseFunctionArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPurchaseIntent(text: string): boolean {
  if (hasPhoneOrSchedulingIntent(text)) {
    return false;
  }

  if (/\b(?:buy|purchase|order|pay for|top up|buy me)\b/i.test(text)) {
    return true;
  }

  return /\b(?:grab|get) me\b/i.test(text) && /\b(?:from|at|on|via)\s+\S+/i.test(text);
}

function hasPhoneOrSchedulingIntent(text: string): boolean {
  return /\b(?:call|phone|ring|dial|appointment|reservation|book|schedule|reschedule|barber|doctor|dentist)\b/i.test(text);
}

function resolveAgentFromText(text: string, sites: ChatAgentIdentity[]): ChatAgentIdentity | null {
  const lowered = text.toLowerCase();
  return sites.find((site) => site.name && lowered.includes(site.name.toLowerCase())) ?? sites[0] ?? null;
}

function isEmailIntent(text: string): boolean {
  return /\be-?mail\b/i.test(text) && /\b(ask|tell|send|reply|write|invite|follow up|let .* know|about|to)\b/i.test(text);
}

async function runChatEmail(text: string, sites: ChatAgentIdentity[], collections: Collections, config: AppConfig): Promise<string> {
  const site = resolveAgentFromText(text, sites);
  if (!site) {
    return "You don't have an agent identity yet. Create one first, then I can send email on its behalf.";
  }

  try {
    const agent = await collections.agents.findOne({ _id: site._id });
    if (!agent) {
      return "I couldn't find that agent identity anymore.";
    }
    const result = await sendSiteEmailFromText(collections, config, createEmailProvider(config), agent, text);
    if (result.approvalRequired) {
      return `Email needs approval before sending. Review it in the approvals inbox.`;
    }
    const { message, parsed } = result;
    const draftedBy = parsed?.parsedBy === "openai" ? "" : " _(templated draft)_";
    const quotedBody = message.textBody.split("\n").join("\n> ");
    const header = `✉️ **Email ${message.status === "sent" ? "sent" : "failed"}** from **${site.name}** (\`${message.fromEmail}\`)`;
    return `${header}\n\n**To:** ${message.toEmail}\n**Subject:** ${message.subject}${draftedBy}\n\n> ${quotedBody}\n\nSee the **Email** tab on **${site.name}** for the full activity log.`;
  } catch (error) {
    if (error instanceof EmailError) {
      return error.status === 422
        ? `I drafted that email but couldn't find a recipient address. Tell me who to send it to (include their email), e.g. "email sarah@acme.com and ask…".`
        : `I couldn't send that email: ${error.message}`;
    }
    throw error;
  }
}

function streamChatMessage(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  text: string,
  model = "barkan-tools"
) {
  const corsHeaders = buildTrustedDashboardCorsHeaders(request.headers.origin, config);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...corsHeaders
  });
  writeDashboardChatEvent(reply, { type: "ready", model });
  writeDashboardChatEvent(reply, { type: "delta", text });
  writeDashboardChatEvent(reply, { type: "done" });
  reply.raw.end();
}

async function streamOpenClawDashboardChat(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AppConfig,
  runChat: (onCallEvent: (event: DashboardChatCallEvent) => void) => Promise<string>
) {
  const corsHeaders = buildTrustedDashboardCorsHeaders(request.headers.origin, config);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...corsHeaders
  });

  const writeEvent = (event: object) => writeDashboardChatEvent(reply, event);
  writeEvent({ type: "ready", model: config.OPENAI_DASHBOARD_CHAT_MODEL });

  try {
    const text = await runChat((event) => writeEvent(event));
    writeEvent({ type: "delta", text });
    writeEvent({ type: "done" });
  } catch (error) {
    request.log.error({ error }, "dashboard chat stream failed");
    writeEvent({ type: "error", error: "AI response failed" });
  } finally {
    reply.raw.end();
  }
}

function writeDashboardChatEvent(reply: FastifyReply, payload: object) {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}
