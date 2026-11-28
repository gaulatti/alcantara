import type { ReactNode } from "react";
import { Tooltip } from "@gaulatti/bleecker/components/tooltip";

/**
 * Says why a control is disabled. A disabled control gets no pointer events, so the help sits on a wrapper around it.
 * Without help the control is rendered as it is.
 */
export function DisabledHelp({ help, children }: { help?: string; children: ReactNode }) {
  if (!help) return <>{children}</>;
  return (
    <Tooltip content={help}>
      <span className="inline-flex w-full flex-col [&_*]:pointer-events-none">{children}</span>
    </Tooltip>
  );
}
