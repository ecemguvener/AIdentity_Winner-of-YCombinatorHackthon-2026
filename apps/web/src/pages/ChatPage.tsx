import React, { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Phone } from "lucide-react";
import { api, type DashboardChatMessageInput, type Site, type User } from "../api";
import { getErrorMessage, type DashboardChatMessage, type DashboardChatRole } from "../shared";

export function DashboardChatScreen({ user, sites }: { user: User; sites: Site[] }) {
  const [messages, setMessages] = useState<DashboardChatMessage[]>([]);
  const [expandedActivityMessageIds, setExpandedActivityMessageIds] = useState<Set<string>>(() => new Set());
  const [composerValue, setComposerValue] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [isWaitingForFirstToken, setIsWaitingForFirstToken] = useState(false);
  const [chatError, setChatError] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const greetingName = user.displayName?.trim() || getDashboardChatGreetingName(user.email);
  const canSubmitComposer = composerValue.trim().length > 0 && !isResponding;

  useEffect(() => {
    const threadElement = threadRef.current;
    if (!threadElement) {
      return;
    }

    const scrollBehavior: ScrollBehavior = messages.length > 1 && !isResponding ? "smooth" : "auto";
    const animationFrameId = window.requestAnimationFrame(() => {
      threadElement.scrollTo({
        top: threadElement.scrollHeight,
        behavior: scrollBehavior
      });
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [messages, isResponding, isWaitingForFirstToken]);

  useEffect(() => {
    resizeDashboardChatComposer(composerInputRef.current);
  }, [composerValue]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const prompt = composerValue.trim();
    if (!prompt || isResponding) {
      return;
    }

    const userMessage = createDashboardChatMessage("user", prompt);
    const assistantMessage = createDashboardChatMessage("assistant", "");
    const messagesForRequest = [...messages, userMessage];
    const nextMessages = [...messagesForRequest, assistantMessage];
    setMessages(nextMessages);
    setComposerValue("");
    setChatError("");
    setIsResponding(true);
    setIsWaitingForFirstToken(true);

    try {
      await api.sendDashboardChatMessage(toDashboardChatApiMessages(messagesForRequest), (streamEvent) => {
        if (streamEvent.type === "call_started") {
          setIsWaitingForFirstToken(false);
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, callEmbed: { ...streamEvent.call, state: "in_progress" } }
                : message
            )
          );
          return;
        }

        if (streamEvent.type === "call_completed") {
          setIsWaitingForFirstToken(false);
          setMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, callEmbed: { ...streamEvent.call, state: "completed" } }
                : message
            )
          );
          return;
        }

        if (streamEvent.type !== "delta" || !streamEvent.text) {
          return;
        }

        setIsWaitingForFirstToken(false);
        setMessages((currentMessages) =>
          currentMessages.map((message) =>
            message.id === assistantMessage.id ? { ...message, content: message.content + streamEvent.text } : message
          )
        );
      });
    } catch (error) {
      setMessages((currentMessages) =>
        currentMessages.filter((message) => message.id !== assistantMessage.id || message.content.trim().length > 0)
      );
      setChatError(getErrorMessage(error, "Barkan could not answer right now."));
    } finally {
      setIsWaitingForFirstToken(false);
      setIsResponding(false);
    }
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }

    event.preventDefault();
    if (canSubmitComposer) {
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="dashboard-page__workspace dashboard-chat" aria-labelledby="dashboardChatTitle">
      <h1 id="dashboardChatTitle" className="dashboard-chat__sr-only">
        Chat
      </h1>
      <div className="dashboard-chat__layout">
        <div className="dashboard-chat__content-column">
          <div ref={threadRef} className="dashboard-chat__thread" aria-live="polite">
            <div className="dashboard-chat__conversation-list">
              {messages.length === 0 ? (
                <div className="dashboard-chat__empty-state">
                  <h2 className="dashboard-chat__empty-state-greeting">
                    Good {getTimeOfDayLabel()}
                    <span className="dashboard-chat__empty-state-dash"> - </span>
                    <span className="dashboard-chat__empty-state-name">{greetingName}</span>
                  </h2>
                </div>
              ) : (
                messages
                  .filter((message) => message.role === "user" || message.content.length > 0 || message.callEmbed)
                  .map((message) => (
                    <div
                      key={message.id}
                      className={`dashboard-chat__conversation-item dashboard-chat__conversation-item--${message.role}`}
                    >
                      <article className={`dashboard-chat__message dashboard-chat__message--${message.role}`}>
                        {message.clarificationDetails ? (
                          <DashboardChatActivityMessage
                            message={message}
                            expanded={expandedActivityMessageIds.has(message.id)}
                            onToggle={() => {
                              setExpandedActivityMessageIds((currentIds) => {
                                const nextIds = new Set(currentIds);
                                if (nextIds.has(message.id)) {
                                  nextIds.delete(message.id);
                                } else {
                                  nextIds.add(message.id);
                                }
                                return nextIds;
                              });
                            }}
                          />
                        ) : (
                          <div className="dashboard-chat__message-content">
                            {message.callEmbed ? <DashboardChatCallEmbedCard call={message.callEmbed} /> : null}
                            <DashboardChatMessageText message={message} />
                          </div>
                        )}
                      </article>
                    </div>
                  ))
              )}

              {isResponding && isWaitingForFirstToken ? (
                <div className="dashboard-chat__conversation-item dashboard-chat__conversation-item--assistant dashboard-chat__conversation-item--thinking">
                  <article className="dashboard-chat__message dashboard-chat__message--assistant dashboard-chat__message--thinking">
                    <p className="dashboard-chat__message-content dashboard-chat__message-content--thinking">
                      Thinking...
                    </p>
                  </article>
                </div>
              ) : null}

              {chatError ? <div className="dashboard-chat__error" role="alert">{chatError}</div> : null}
            </div>
          </div>

          <div className="dashboard-chat__composer-shell">
            <form className="dashboard-chat__composer" onSubmit={handleSubmit}>
              <label className="dashboard-chat__sr-only" htmlFor="dashboardChatPrompt">
                Message Barkan
              </label>
              <div className="dashboard-chat__composer-body">
                <textarea
                  ref={composerInputRef}
                  id="dashboardChatPrompt"
                  className="dashboard-chat__composer-input"
                  name="message"
                  placeholder="Ask your agent (openclaw) anything"
                  rows={1}
                  value={composerValue}
                  onChange={(event) => {
                    setComposerValue(event.target.value);
                    resizeDashboardChatComposer(event.currentTarget);
                  }}
                  onKeyDown={handleComposerKeyDown}
                />
              </div>

              <div className="dashboard-chat__composer-footer">
                <button className="dashboard-chat__composer-attach" type="button" aria-label="Attach context">
                  <DashboardChatPlusIcon />
                </button>

                <div className="dashboard-chat__composer-actions">
                  <DashboardChatMicIcon />
                  <button
                    className="dashboard-chat__composer-submit"
                    type="submit"
                    aria-label="Send message"
                    disabled={!canSubmitComposer}
                  >
                    <DashboardChatSendIcon />
                  </button>
                </div>
              </div>
            </form>

            <div className="dashboard-chat__composer-meta" aria-hidden="true">
              <div className="dashboard-chat__composer-meta-group">
                <DashboardChatFolderIcon />
                <span className="dashboard-chat__composer-meta-text">Barkan dashboard</span>
                <DashboardChatChevronIcon />
              </div>
              <div className="dashboard-chat__composer-meta-group dashboard-chat__composer-meta-group--sites">
                <DashboardChatLoaderIcon />
                <span className="dashboard-chat__composer-meta-text">
                  {sites.length === 1 ? "1 identity" : `${sites.length} identities`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function DashboardChatActivityMessage({
  message,
  expanded,
  onToggle
}: {
  message: DashboardChatMessage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const details = message.clarificationDetails;
  const detailRegionId = `${message.id}-activity-details`;

  if (!details) {
    return null;
  }

  return (
    <>
      <button
        className="dashboard-chat__activity-toggle"
        type="button"
        aria-expanded={expanded}
        aria-controls={detailRegionId}
        onClick={onToggle}
      >
        {message.content}
      </button>
      {expanded ? (
        <div id={detailRegionId} className="dashboard-chat__activity-details">
          {details.entries.map((entry, index) => (
            <div className="dashboard-chat__activity-entry" key={`${entry.question}-${index}`}>
              <p className="dashboard-chat__activity-line">
                <span className="dashboard-chat__activity-line-label">Question:</span> {entry.question}
              </p>
              <p className="dashboard-chat__activity-line">
                <span className="dashboard-chat__activity-line-label">Answer:</span> {entry.answer}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function DashboardChatCallEmbedCard({ call }: { call: DashboardChatMessage["callEmbed"] }) {
  if (!call) {
    return null;
  }

  const transcript = call.transcript ?? [];
  const hasTranscript = transcript.length > 0;
  const isCompleted = call.state === "completed";

  return (
    <section className={`dashboard-chat__call-card dashboard-chat__call-card--${call.state}`} aria-label="Phone call">
      <div className="dashboard-chat__call-card-header">
        <div className="dashboard-chat__call-card-title">
          <span className="dashboard-chat__call-card-icon" aria-hidden="true">
            <Phone size={16} />
          </span>
          <div>
            <p>{isCompleted ? "Call completed" : "Call in progress"}</p>
            <span>{call.recipientName || call.toNumber}</span>
          </div>
        </div>
        <div className="dashboard-chat__call-card-status" aria-label={isCompleted ? "Completed" : "In progress"}>
          <span />
          {isCompleted ? formatCallDuration(call.durationSecs) : "Live"}
        </div>
      </div>

      <div className="dashboard-chat__call-card-body">
        <p className="dashboard-chat__call-card-task">{call.task}</p>
        <div className="dashboard-chat__call-card-meta">
          <span>{call.toNumber}</span>
          <span>{call.simulated ? "Mock voice provider" : "Voice provider"}</span>
        </div>
      </div>

      {isCompleted ? (
        <div className="dashboard-chat__call-transcript" aria-label="Call transcript">
          <div className="dashboard-chat__call-transcript-heading">
            <span>Transcript</span>
            <span>{call.status}</span>
          </div>
          {hasTranscript ? (
            transcript.map((turn, turnIndex) => (
              <div className="dashboard-chat__call-transcript-turn" key={`${turn.role}-${turnIndex}`}>
                <span className="dashboard-chat__call-transcript-speaker">{formatTranscriptRole(turn.role)}</span>
                <p>
                  {splitTranscriptWords(turn.message).map((word, wordIndex) => (
                    <span
                      className="dashboard-chat__call-transcript-word"
                      key={`${word}-${wordIndex}`}
                      style={{ "--word-index": wordIndex + turnIndex * 8 } as CSSProperties}
                    >
                      {word}
                    </span>
                  ))}
                </p>
              </div>
            ))
          ) : (
            <p className="dashboard-chat__call-transcript-empty">The call ended before transcript text was returned.</p>
          )}
        </div>
      ) : (
        <div className="dashboard-chat__call-progress" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
    </section>
  );
}

function DashboardChatMessageText({ message }: { message: DashboardChatMessage }) {
  if (message.role !== "assistant") {
    return <>{message.content}</>;
  }

  return (
    <div className="dashboard-chat__markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={dashboardChatMarkdownComponents}
      >
        {normalizeDashboardChatMarkdown(message.content)}
      </ReactMarkdown>
    </div>
  );
}

const dashboardChatMarkdownComponents: Components = {
  table: DashboardChatMarkdownTable,
  pre: DashboardChatMarkdownPre
};

function DashboardChatMarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="dashboard-chat__markdown-table-scroll">
      <table>{children}</table>
    </div>
  );
}

function DashboardChatMarkdownPre({ children }: { children?: ReactNode }) {
  const text = getReactNodeText(children).trim();

  if (isMarkdownTableBlock(text)) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={dashboardChatMarkdownComponents}>
        {normalizeDashboardChatMarkdown(text)}
      </ReactMarkdown>
    );
  }

  return <pre>{children}</pre>;
}

function normalizeDashboardChatMarkdown(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const normalizedLines: string[] = [];
  let isInsideFence = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      isInsideFence = !isInsideFence;
      normalizedLines.push(line);
      continue;
    }

    const nextLine = lines[index + 1] ?? "";
    if (
      !isInsideFence &&
      isMarkdownTableHeaderLine(line) &&
      isMarkdownTableSeparatorLikeLine(nextLine)
    ) {
      const cellCount = getMarkdownPipeCellCount(line);
      normalizedLines.push(line);
      normalizedLines.push(buildMarkdownTableSeparatorLine(cellCount));
      index++;
      continue;
    }

    normalizedLines.push(line);
  }

  return normalizedLines.join("\n");
}

function formatCallDuration(durationSecs: number | null | undefined): string {
  if (typeof durationSecs !== "number" || !Number.isFinite(durationSecs) || durationSecs <= 0) {
    return "Done";
  }

  const minutes = Math.floor(durationSecs / 60);
  const seconds = Math.floor(durationSecs % 60);
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function formatTranscriptRole(role: string): string {
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "agent" || normalizedRole === "assistant") {
    return "Agent";
  }
  if (normalizedRole === "user") {
    return "Recipient";
  }

  return role.trim() || "Speaker";
}

function splitTranscriptWords(value: string): string[] {
  return value.split(/(\s+)/).filter(Boolean);
}

function isMarkdownTableHeaderLine(value: string): boolean {
  return getMarkdownPipeCellCount(value) >= 2;
}

function isMarkdownTableSeparatorLikeLine(value: string): boolean {
  const trimmedValue = value.trim();
  return trimmedValue.includes("|") && /-/.test(trimmedValue) && /^[\s|:-]+$/.test(trimmedValue);
}

function getMarkdownPipeCellCount(value: string): number {
  const trimmedValue = value.trim();
  if (!trimmedValue.includes("|")) {
    return 0;
  }

  return trimmedValue
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .length;
}

function buildMarkdownTableSeparatorLine(cellCount: number): string {
  return `| ${Array.from({ length: cellCount }, () => "---").join(" | ")} |`;
}

function getReactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getReactNodeText).join("");
  }

  if (React.isValidElement<{ children?: ReactNode }>(node)) {
    return getReactNodeText(node.props.children);
  }

  return "";
}

function isMarkdownTableBlock(value: string): boolean {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2 || !lines[0].includes("|") || !lines[1].includes("|")) {
    return false;
  }

  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[1]);
}

export function getDashboardChatGreetingName(email: string): string {
  const localPart = email.split("@")[0]?.trim();
  if (!localPart) {
    return "there";
  }

  const firstSegment = localPart.split(/[._-]/).find(Boolean) ?? localPart;
  return firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1);
}

function getTimeOfDayLabel(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) {
    return "Morning";
  }

  if (hour < 18) {
    return "Afternoon";
  }

  return "Evening";
}

function createDashboardChatMessage(role: DashboardChatRole, content: string): DashboardChatMessage {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    id: `dashboard-chat-${role}-${suffix}`,
    role,
    content
  };
}

function toDashboardChatApiMessages(messages: DashboardChatMessage[]): DashboardChatMessageInput[] {
  return messages.slice(-24).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function resizeDashboardChatComposer(inputElement: HTMLTextAreaElement | null) {
  if (!inputElement) {
    return;
  }

  inputElement.style.height = "0px";
  inputElement.style.height = `${Math.min(180, Math.max(20, inputElement.scrollHeight))}px`;
}

export function DashboardSitesIcon() {
  return (
    <svg className="dashboard-page__rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M3 6a3 3 0 0 1 3-3h2.25a3 3 0 0 1 3 3v2.25a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Zm9.75 0a3 3 0 0 1 3-3H18a3 3 0 0 1 3 3v2.25a3 3 0 0 1-3 3h-2.25a3 3 0 0 1-3-3V6ZM3 15.75a3 3 0 0 1 3-3h2.25a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2.25Zm9.75 0a3 3 0 0 1 3-3H18a3 3 0 0 1 3 3V18a3 3 0 0 1-3 3h-2.25a3 3 0 0 1-3-3v-2.25Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function DashboardChatIcon() {
  return (
    <svg className="dashboard-page__rail-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5.337 21.718a6.707 6.707 0 0 1-.533-.074.75.75 0 0 1-.44-1.223 3.73 3.73 0 0 0 .814-1.686c.023-.115-.022-.317-.254-.543C3.274 16.587 2.25 14.41 2.25 12c0-5.03 4.428-9 9.75-9s9.75 3.97 9.75 9c0 5.03-4.428 9-9.75 9-.833 0-1.643-.097-2.417-.279a6.721 6.721 0 0 1-4.246.997Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DashboardChatPlusIcon() {
  return (
    <svg className="dashboard-chat__composer-icon dashboard-chat__composer-icon--plus" viewBox="0 0 21 21" aria-hidden="true">
      <path d="M16.625 9.625h-5.25v-5.25a.875.875 0 0 0-1.75 0v5.25h-5.25a.875.875 0 0 0 0 1.75h5.25v5.25a.875.875 0 0 0 1.75 0v-5.25h5.25a.875.875 0 0 0 0-1.75Z" />
    </svg>
  );
}

function DashboardChatMicIcon() {
  return (
    <svg className="dashboard-chat__composer-icon dashboard-chat__composer-icon--mic" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M9 11.25a3 3 0 0 0 3-3V4.5a3 3 0 0 0-6 0v3.75a3 3 0 0 0 3 3Zm-1.5-6.75a1.5 1.5 0 0 1 3 0v3.75a1.5 1.5 0 0 1-3 0V4.5Z" />
      <path d="M14.25 8.25a.75.75 0 0 0-1.5 0 3.75 3.75 0 0 1-7.5 0 .75.75 0 0 0-1.5 0 5.25 5.25 0 0 0 4.5 5.19V15H6.667A.667.667 0 0 0 6 15.667v.165c0 .369.299.668.667.668h4.666a.667.667 0 0 0 .667-.668v-.165a.667.667 0 0 0-.667-.667H9.75v-1.56a5.25 5.25 0 0 0 4.5-5.19Z" />
    </svg>
  );
}

function DashboardChatSendIcon() {
  return (
    <svg className="dashboard-chat__composer-send-icon" viewBox="0 0 19 19" aria-hidden="true">
      <path d="M9.5 16.5V3" />
      <path d="M3.961 8.542 9.503 3l5.542 5.542" />
    </svg>
  );
}

function DashboardChatFolderIcon() {
  return (
    <svg className="dashboard-chat__composer-meta-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 13.667H3a1.6 1.6 0 0 1-1.667-1.62V3.954A1.6 1.6 0 0 1 3 2.334h3.066c.2.001.389.092.513.247l1.733 2.12h4.667a1.6 1.6 0 0 1 1.686 1.62v5.726a1.6 1.6 0 0 1-1.666 1.62ZM2.666 9.174v2.873c.003.17.163.307.333.287h10c.17.02.33-.118.333-.287V6.32c-.003-.169-.163-.306-.333-.286H8a.667.667 0 0 1-.514-.247l-1.733-2.12H3c-.17-.02-.33.117-.333.286v5.22Z" />
    </svg>
  );
}

function DashboardChatLoaderIcon() {
  return (
    <svg className="dashboard-chat__composer-meta-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.334a.667.667 0 0 0-.667.667v1.333a.667.667 0 1 0 1.334 0V2a.667.667 0 0 0-.667-.667Zm6 6h-1.333a.667.667 0 0 0 0 1.333H14a.667.667 0 0 0 0-1.333Zm-10 0a.667.667 0 0 0-.667-.667H2a.667.667 0 0 0 0 1.333h1.333A.667.667 0 0 0 4 7.334ZM4.146 3.333a.667.667 0 1 0-.927.96l.96.947a.667.667 0 1 0 .966-.92l-1-.987Zm7.707 0-.96.947a.667.667 0 0 0 .9.96l.96-.927a.667.667 0 1 0-.9-.98ZM8 12a.667.667 0 0 0-.667.667V14a.667.667 0 1 0 1.334 0v-1.333A.667.667 0 0 0 8 12Zm3.822-1.24a.667.667 0 1 0-.927.96l.96.946a.667.667 0 1 0 .94-.946l-.973-.96Zm-7.641 0-.96.927a.667.667 0 0 0 .927.96l.96-.927a.667.667 0 1 0-.927-.96Z" />
    </svg>
  );
}

function DashboardChatChevronIcon() {
  return (
    <svg className="dashboard-chat__composer-meta-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 5.5 8 10l4.5-4.5" />
    </svg>
  );
}
