import crypto from "node:crypto";
import { Resend } from "resend";
import type { AppConfig } from "../config.js";

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

export class ResendEmailProvider implements EmailProvider {
  private readonly resend: Resend;

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async sendEmail(input: EmailProviderSendInput): Promise<EmailProviderSendResult> {
    const headers = input.headers ?? {};
    const { ["Idempotency-Key"]: idempotencyKey, ["idempotency-key"]: lowercaseIdempotencyKey, ...emailHeaders } = headers;
    const response = await this.resend.emails.send(
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
    );
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
    this.sent.push(input);
    if (this.failWith) {
      throw this.failWith;
    }
    // eslint-disable-next-line no-console
    console.info(`[email:mock] ${input.from} -> ${input.to} :: ${input.subject}`);
    return { providerMessageId: `mock_${crypto.randomBytes(8).toString("hex")}` };
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

function readAddressFromFromHeader(value: string): string {
  return value.match(/<([^>]+)>/)?.[1]?.trim() ?? value;
}
