import { useEffect, useRef, useId, type ReactNode } from "react";
import {
  Coffee,
  Hotel,
  MessageCircle,
  MapPin,
  Heart,
  X,
  Sprout,
  Sparkles,
} from "lucide-react";
import type { ScenarioId } from "../shared/types";
export type Mood =
  | "neutral"
  | "welcoming"
  | "listening"
  | "speaking"
  | "thinking"
  | "encouraging";
export function Mascot({
  mood = "welcoming",
  className = "",
}: {
  mood?: Mood;
  className?: string;
}) {
  const i = [
    "neutral",
    "welcoming",
    "listening",
    "speaking",
    "thinking",
    "encouraging",
  ].indexOf(mood);
  return (
    <div
      className={`mascot mascot-${mood} ${className}`}
      role="img"
      aria-label={`대화 친구 모루: ${{ neutral: "편안한 표정", welcoming: "반갑게 인사", listening: "귀 기울여 듣기", speaking: "즐겁게 말하기", thinking: "생각하기", encouraging: "따뜻한 응원" }[mood]}`}
      style={{
        backgroundPosition: `${(i % 3) * 50}% ${Math.floor(i / 3) * 100}%`,
      }}
    />
  );
}
export function ScenarioIcon({
  id,
  size = 25,
}: {
  id: ScenarioId;
  size?: number;
}) {
  const Icon = {
    free: MessageCircle,
    cafe: Coffee,
    hotel: Hotel,
    friends: Heart,
    directions: MapPin,
  }[id];
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const d = ref.current;
    const trigger = document.activeElement;
    d?.showModal();
    return () => {
      d?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      className={`modal ${wide ? "modal-wide" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const dialog = ref.current;
        if (!dialog) return;
        const targets = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
          ),
        ].filter((element) => element.getClientRects().length > 0);
        const first = targets[0];
        const last = targets.at(-1);
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2 id={headingId}>{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={onClose}>
          <X size={22} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-art">
        <Mascot mood="neutral" />
        <Sparkles className="empty-spark" size={24} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <MessageCircle size={24} strokeWidth={2.5} />
        <span>··</span>
      </span>
      <span>
        Talk<span>Simul</span>
        <small>작은 회화 아지트</small>
      </span>
    </span>
  );
}
export function LevelSprouts({ count }: { count: number }) {
  return (
    <span className="sprouts" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Sprout key={i} size={20} />
      ))}
    </span>
  );
}
