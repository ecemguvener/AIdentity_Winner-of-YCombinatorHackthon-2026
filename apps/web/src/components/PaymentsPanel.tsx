import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard, Loader2, Sparkles } from "lucide-react";
import { api, type PaymentActivity, type PaymentRequestView, type ParsedPurchase } from "../api";

function formatMoney(amount: number, currency: string): string {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

export function PaymentsPanel({ siteId, siteName }: { siteId: string; siteName: string }) {
  const [activity, setActivity] = useState<PaymentActivity | null>(null);
  const [prompt, setPrompt] = useState("");
  const [parsed, setParsed] = useState<ParsedPurchase | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setActivity(await api.getSitePaymentActivity(siteId));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Could not load payment activity");
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError("");
      try {
        await action();
        await refresh();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : "Action failed");
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  async function handleShop(event: React.FormEvent) {
    event.preventDefault();
    const instruction = prompt.trim();
    if (!instruction) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.siteRequestPurchaseFromText(siteId, instruction);
      setParsed(result.parsed);
      setPrompt("");
      await refresh();
    } catch (shopError) {
      setParsed(null);
      setError(shopError instanceof Error ? shopError.message : "Could not interpret that request");
    } finally {
      setBusy(false);
    }
  }

  const policy = activity?.policy ?? null;
  const requests = activity?.purchase_requests ?? [];
  const transactions = activity?.transactions ?? [];
  const card = activity?.payment_identity ?? null;
  const examplePrompts = useMemo(
    () => ["buy me still water from amazon", "Buy £15 of OpenAI credits", "order a USB-C charger from Amazon"],
    []
  );

  return (
    <div className="payments-panel-view">
      <header className="site-detail-page__header">
        <div>
          <h1 id="siteDetailTitle">Payments</h1>
          <p className="payments-screen__subtitle">
            {siteName} can shop in plain English — the policy engine decides what is approved.
          </p>
        </div>
        <div className="payments-card">
          <CreditCard size={18} aria-hidden="true" />
          <div>
            <span className="payments-card__brand">Visa •••• {card?.card_last4 ?? "····"}</span>
            <span className="payments-card__meta">{card ? `${card.provider} · ${card.status}` : loading ? "loading…" : "no card"}</span>
          </div>
        </div>
      </header>

      {error ? <div className="payments-alert">{error}</div> : null}

      <div className="payments-panel">
        <h2 className="payments-panel__title">
          <Sparkles size={15} aria-hidden="true" /> Shop
        </h2>
        <form className="payments-shop" onSubmit={handleShop}>
          <input
            className="payments-input"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder='e.g. "buy me still water from amazon"'
            disabled={busy || loading}
          />
          <button className="payments-btn payments-btn--primary" type="submit" disabled={busy || loading}>
            {busy ? <Loader2 size={15} className="payments-spin" aria-hidden="true" /> : "Buy"}
          </button>
        </form>
        <div className="payments-examples">
          {examplePrompts.map((example) => (
            <button key={example} type="button" className="payments-chip" onClick={() => setPrompt(example)} disabled={busy}>
              {example}
            </button>
          ))}
        </div>
        {parsed ? (
          <p className="payments-parsed">
            Parsed by <strong>{parsed.parsed_by}</strong>:{" "}
            {parsed.merchant_url ? (
              <a href={parsed.merchant_url} target="_blank" rel="noopener noreferrer">
                {parsed.merchant_name}
              </a>
            ) : (
              parsed.merchant_name
            )}{" "}
            · {formatMoney(parsed.amount, parsed.currency)}
            {parsed.price_estimated ? " (est.)" : ""}
            {parsed.item ? ` · ${parsed.item}` : ""}
          </p>
        ) : null}
      </div>

      {policy ? (
        <div className="payments-panel">
          <h2 className="payments-panel__title">Spending policy</h2>
          <dl className="payments-policy">
            <div>
              <dt>Max / transaction</dt>
              <dd>{formatMoney(policy.max_transaction_amount, "GBP")}</dd>
            </div>
            <div>
              <dt>Daily limit</dt>
              <dd>{formatMoney(policy.daily_limit, "GBP")}</dd>
            </div>
            <div>
              <dt>Monthly limit</dt>
              <dd>{formatMoney(policy.monthly_limit, "GBP")}</dd>
            </div>
            <div>
              <dt>Approval above</dt>
              <dd>{formatMoney(policy.approval_required_above, "GBP")}</dd>
            </div>
            <div>
              <dt>Blocked</dt>
              <dd>{policy.blocked_merchants.join(", ") || "—"}</dd>
            </div>
            <div>
              <dt>Recurring</dt>
              <dd>{policy.allow_recurring ? "allowed" : "blocked"}</dd>
            </div>
          </dl>
        </div>
      ) : null}

      <div className="payments-panel">
        <h2 className="payments-panel__title">Purchase requests</h2>
        {requests.length === 0 ? (
          <p className="payments-empty">No requests yet. Try the Shop box above, or ask in Chat.</p>
        ) : (
          <table className="payments-table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => (
                <PurchaseRow key={request.id} request={request} busy={busy} siteId={siteId} runAction={runAction} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="payments-panel">
        <h2 className="payments-panel__title">Transactions</h2>
        {transactions.length === 0 ? (
          <p className="payments-empty">No transactions yet.</p>
        ) : (
          <table className="payments-table">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Provider txn</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((transaction) => (
                <tr key={transaction.transaction_id}>
                  <td>{transaction.merchant_name}</td>
                  <td>{formatMoney(transaction.amount, transaction.currency)}</td>
                  <td>
                    <span className={`payments-badge payments-badge--${transaction.status}`}>{transaction.status}</span>
                  </td>
                  <td className="payments-muted">{transaction.provider_transaction_id}</td>
                  <td className="payments-muted">{new Date(transaction.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PurchaseRow({
  request,
  busy,
  siteId,
  runAction
}: {
  request: PaymentRequestView;
  busy: boolean;
  siteId: string;
  runAction: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const canDecide = request.status === "requires_approval" || request.status === "pending";
  const canExecute = request.status === "approved";

  return (
    <tr>
      <td>
        {request.merchant_url ? (
          <a href={request.merchant_url} target="_blank" rel="noopener noreferrer">
            {request.merchant_name}
          </a>
        ) : (
          request.merchant_name
        )}
        {request.item ? <span className="payments-muted"> · {request.item}</span> : null}
      </td>
      <td>
        {formatMoney(request.amount, request.currency)}
        {request.price_estimated ? <span className="payments-muted"> (est.)</span> : null}
      </td>
      <td>
        <span className={`payments-badge payments-badge--${request.status}`}>{statusLabel(request.status)}</span>
      </td>
      <td className="payments-muted">{request.decision_reason}</td>
      <td>
        <div className="payments-actions">
          {canDecide ? (
            <>
              <button
                className="payments-btn payments-btn--approve"
                type="button"
                disabled={busy}
                onClick={() => void runAction(() => api.siteApprovePurchase(siteId, request.id))}
              >
                Approve
              </button>
              <button
                className="payments-btn payments-btn--reject"
                type="button"
                disabled={busy}
                onClick={() => void runAction(() => api.siteRejectPurchase(siteId, request.id))}
              >
                Reject
              </button>
            </>
          ) : null}
          {canExecute ? (
            <button
              className="payments-btn payments-btn--primary"
              type="button"
              disabled={busy}
              onClick={() => void runAction(() => api.siteExecutePurchase(siteId, request.id))}
            >
              Execute
            </button>
          ) : null}
          {!canDecide && !canExecute ? <span className="payments-muted">—</span> : null}
        </div>
      </td>
    </tr>
  );
}
