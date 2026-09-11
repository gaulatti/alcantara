import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type BroadcastActionKind = 'cut' | 'take' | 'danger' | 'restore';

interface BroadcastActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  kind: BroadcastActionKind;
  children: ReactNode;
  fullWidth?: boolean;
}

const kindClasses: Record<BroadcastActionKind, string> = {
  cut: 'border-white/70 bg-zinc-100 text-zinc-950 hover:bg-white',
  take: 'border-sky-300 bg-sky-500 text-zinc-950 hover:bg-sky-400',
  danger: 'border-red-500 bg-black text-red-100 hover:bg-red-950',
  restore: 'border-red-300 bg-red-600 text-white hover:bg-red-500'
};

export function BroadcastAction({ kind, children, className = '', fullWidth = false, type = 'button', ...props }: BroadcastActionProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-12 items-center justify-center gap-1.5 rounded-[var(--radius-button)] border px-4 text-sm font-black tracking-wide transition-[background-color,border-color,transform,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:pointer-events-none disabled:opacity-40 active:translate-y-px ${kindClasses[kind]} ${fullWidth ? 'w-full' : ''} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
