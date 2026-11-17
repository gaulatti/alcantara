import {
  Children,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Button as BleeckerButton,
  type ButtonProps,
} from "@gaulatti/bleecker/components/button";
import {
  IconButton as BleeckerIconButton,
  type IconButtonProps,
} from "@gaulatti/bleecker/components/icon-button";
import { Tooltip } from "@gaulatti/bleecker/components/tooltip";

function labelText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      if (isValidElement<{ children?: ReactNode }>(child))
        return labelText(child.props.children);
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function buttonHelp(props: ButtonHTMLAttributes<HTMLButtonElement>): string {
  return (
    props.title?.trim() ||
    props["aria-label"]?.trim() ||
    labelText(props.children)
  );
}

function accessibleLabel(
  props: ButtonHTMLAttributes<HTMLButtonElement>,
): string | undefined {
  return (
    props["aria-label"] ??
    (!props["aria-labelledby"] && !labelText(props.children)
      ? props.title
      : undefined)
  );
}

// Disabled native buttons remain inert but can receive pointer movement to explain
// their disabled state. Tooltip uses Radix asChild, so no layout wrapper is added.
function helpStyle(
  style: CSSProperties | undefined,
  disabled: boolean | undefined,
): CSSProperties | undefined {
  return disabled ? { ...style, pointerEvents: "auto" } : style;
}

// Stopgap for gaulatti/alcantara#189. Bleecker 0.1.41 colours dark-mode
// tooltip text `dark:text-deep-sea` on `dark:bg-sand`, and its dark theme makes
// sand navy too, so the text cannot be read. Bleecker a860590 (released in
// 0.1.42) switches it to `dark:text-text-primary`; Bleecker merges classes with
// tailwind-merge, so this one replaces its dark text colour. Remove it when
// Alcantara takes Bleecker 0.1.42 or later.
const TOOLTIP_TEXT = "dark:text-text-primary";

export const Button = forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  ButtonProps
>(function Button(props, ref) {
  const content = buttonHelp(props);
  const button = (
    <BleeckerButton
      {...props}
      ref={ref}
      aria-label={accessibleLabel(props)}
      title={content ? undefined : props.title}
      style={helpStyle(props.style, props.disabled || props.loading)}
    />
  );
  return content ? <Tooltip content={content} className={TOOLTIP_TEXT}>{button}</Tooltip> : button;
});

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    const content = buttonHelp(props);
    const button = (
      <BleeckerIconButton
        {...props}
        ref={ref}
        aria-label={accessibleLabel(props)}
        title={content ? undefined : props.title}
        style={helpStyle(props.style, props.disabled)}
      />
    );
    return content ? <Tooltip content={content} className={TOOLTIP_TEXT}>{button}</Tooltip> : button;
  },
);

/** Styled native controls (broadcast actions, pads, and log rows) share the same help. */
export const TooltipButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function TooltipButton(props, ref) {
  const content = buttonHelp(props);
  const button = (
    <button
      {...props}
      ref={ref}
      aria-label={accessibleLabel(props)}
      title={content ? undefined : props.title}
      style={helpStyle(props.style, props.disabled)}
    />
  );
  return content ? <Tooltip content={content} className={TOOLTIP_TEXT}>{button}</Tooltip> : button;
});
