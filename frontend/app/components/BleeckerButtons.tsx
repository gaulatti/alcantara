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
  return content ? <Tooltip content={content}>{button}</Tooltip> : button;
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
    return content ? <Tooltip content={content}>{button}</Tooltip> : button;
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
  return content ? <Tooltip content={content}>{button}</Tooltip> : button;
});
