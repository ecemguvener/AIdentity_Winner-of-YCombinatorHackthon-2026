import crypto from "node:crypto";
import { Resend } from "resend";
import type { AppConfig } from "../config.js";
import { instrumentProviderCall } from "../metrics.js";

export interface EmailAttachmentInput {
  filename?: string | false;
  content?: string | Buffer;
  path?: string;
  contentType?: string;
}

export interface EmailProviderSendInput {
  from: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: EmailAttachmentInput[];
  headers?: Record<string, string>;
}

export interface EmailProviderSendResult {
  providerMessageId: string;
}

export interface EmailProvider {
  sendEmail(input: EmailProviderSendInput): Promise<EmailProviderSendResult>;
}

interface InboundEmailAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  contentType: string;
}

export interface ReceivedEmailContent {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  receivedFor: string[];
  subject: string;
  text: string;
  html?: string;
  headers: Record<string, string>;
  attachments: InboundEmailAttachment[];
}

export interface EmailInboundClient {
  getReceivedEmail(emailId: string): Promise<ReceivedEmailContent>;
  getAttachment(emailId: string, attachmentId: string): Promise<{ data: ArrayBuffer; contentType: string; filename: string }>;
}

class ResendEmailProvider implements EmailProvider {
  private readonly resend: Resend;

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async sendEmail(input: EmailProviderSendInput): Promise<EmailProviderSendResult> {
    const headers = input.headers ?? {};
    const { ["Idempotency-Key"]: idempotencyKey, ["idempotency-key"]: lowercaseIdempotencyKey, ...emailHeaders } = headers;
    const response = await instrumentProviderCall("resend", "emails.send", () => this.resend.emails.send(
      {
        from: input.from,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        text: input.text,
        html: input.html,
        attachments: input.attachments,
        headers: Object.keys(emailHeaders).length ? emailHeaders : undefined,
        replyTo: readAddressFromFromHeader(input.from)
      },
      { idempotencyKey: idempotencyKey ?? lowercaseIdempotencyKey }
    ));
    if (response.error || !response.data) {
      throw new Error(response.error?.message ?? "Resend did not return a message id");
    }
    return { providerMessageId: response.data.id };
  }
}

export class MockEmailProvider implements EmailProvider {
  readonly sent: EmailProviderSendInput[] = [];

  constructor(private readonly failWith?: Error) {}

  async sendEmail(input: EmailProviderSendInput): Promise<EmailProviderSendResult> {
    return instrumentProviderCall("resend", "emails.send", async () => {
      this.sent.push(input);
      if (this.failWith) {
        throw this.failWith;
      }
      // eslint-disable-next-line no-console
      console.info(`[email:mock] ${input.from} -> ${input.to} :: ${input.subject}`);
      return { providerMessageId: `mock_${crypto.randomBytes(8).toString("hex")}` };
    });
  }
}

class ResendInboundClient implements EmailInboundClient {
  private readonly resend: Resend;

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async getReceivedEmail(emailId: string): Promise<ReceivedEmailContent> {
    const response = await instrumentProviderCall("resend", "emails.receiving.get", () => this.resend.emails.receiving.get(emailId, { html_format: "cid" }));
    if (response.error || !response.data) {
      throw new Error(response.error?.message ?? "Resend did not return inbound email content");
    }
    return {
      id: response.data.id,
      from: response.data.from,
      to: response.data.to,
      cc: response.data.cc ?? [],
      receivedFor: response.data.received_for,
      subject: response.data.subject,
      text: response.data.text ?? "",
      html: response.data.html ?? undefined,
      headers: normalizeHeaders(response.data.headers ?? {}),
      attachments: response.data.attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename ?? "attachment",
        sizeBytes: attachment.size,
        contentType: attachment.content_type
      }))
    };
  }

  async getAttachment(emailId: string, attachmentId: string): Promise<{ data: ArrayBuffer; contentType: string; filename: string }> {
    const response = await instrumentProviderCall("resend", "emails.receiving.attachments.get", () => this.resend.emails.receiving.attachments.get({ emailId, id: attachmentId }));
    if (response.error || !response.data) {
      throw new Error(response.error?.message ?? "Resend did not return attachment content");
    }
    const attachmentResponse = await fetch(response.data.download_url);
    if (!attachmentResponse.ok) {
      throw new Error(`attachment download failed: ${attachmentResponse.status}`);
    }
    return {
      data: await attachmentResponse.arrayBuffer(),
      contentType: response.data.content_type,
      filename: response.data.filename ?? "attachment"
    };
  }
}

export function createEmailProvider(config: AppConfig): EmailProvider {
  if (config.PROVIDER_MODE_EMAIL === "mock") {
    return new MockEmailProvider();
  }
  if (!config.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required when PROVIDER_MODE_EMAIL=live");
  }
  return new ResendEmailProvider(config.RESEND_API_KEY);
}

export function createEmailInboundClient(config: AppConfig): EmailInboundClient {
  if (!config.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is required for inbound email content");
  }
  return new ResendInboundClient(config.RESEND_API_KEY);
}

function readAddressFromFromHeader(value: string): string {
  return value.match(/<([^>]+)>/)?.[1]?.trim() ?? value;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
