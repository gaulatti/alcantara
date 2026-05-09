export function PanelColumn({
  children,
  style,
  className
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <div className={`flex h-full min-h-0 flex-col${className ? ` ${className}` : ''}`} style={style}>
      {children}
    </div>
  );
}
