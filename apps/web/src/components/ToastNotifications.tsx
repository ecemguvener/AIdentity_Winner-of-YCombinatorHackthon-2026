import { Check, Info, X } from "lucide-react";
import type { CSSProperties } from "react";

type ToastNotificationKind = "success" | "error" | "info";

export type ToastNotification = {
  id: string;
  kind: ToastNotificationKind;
  title: string;
};

export type ToastNotificationInput = {
  kind?: ToastNotificationKind;
  title: string;
  durationMs?: number;
};

export function ToastNotifications({ notifications }: { notifications: ToastNotification[] }) {
  if (notifications.length === 0) {
    return null;
  }

  const visibleNotifications = notifications.slice(-3).reverse();

  return (
    <div className="toast-notifications" aria-live="polite" aria-label="Notifications">
      {visibleNotifications.map((notification, index) => (
        <article
          className={`toast-notification toast-notification--${notification.kind}`}
          key={notification.id}
          role={notification.kind === "error" ? "alert" : "status"}
          style={
            {
              "--toast-index": index,
              "--toast-count": visibleNotifications.length
            } as CSSProperties
          }
        >
          <span className="toast-notification__icon" aria-hidden="true">
            {notification.kind === "success" ? (
              <Check size={15} />
            ) : notification.kind === "error" ? (
              <X size={15} />
            ) : (
              <Info size={15} />
            )}
          </span>
          <div className="toast-notification__body">
            <strong>{notification.title}</strong>
          </div>
          {index === 0 && visibleNotifications.length > 1 ? (
            <span className="toast-notification__stack-count" aria-label={`${visibleNotifications.length - 1} more notifications`}>
              +{visibleNotifications.length - 1}
            </span>
          ) : null}
        </article>
      ))}
    </div>
  );
}
