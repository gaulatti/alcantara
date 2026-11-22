// Shared helpers for the route specs (gaulatti/alcantara#187). Kept outside
// app/ so they are not part of the coverage denominator.

/** A native select in place of Bleecker's Radix select, which jsdom cannot open. */
export async function nativeSelect(
  original: () => Promise<typeof import("@gaulatti/bleecker")>,
) {
  const actual = await original();
  return {
    ...actual,
    Select: ({
      options,
      onChange,
      value,
      placeholder,
      ...props
    }: {
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
      value: string;
      placeholder?: string;
    }) => (
      <select
        aria-label={placeholder}
        {...props}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.some((option) => option.value === "") ? null : (
          <option value="">{placeholder ?? "Select…"}</option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
}

/**
 * Dropdown menus that open in place, in place of Bleecker's Radix menu, whose popper runs
 * continuously in jsdom. The trigger opens the menu on a click or on Enter, Space or the down arrow,
 * and choosing an item calls its onSelect and closes the menu.
 */
export async function inlineMenus(
  original: () => Promise<typeof import("@gaulatti/bleecker")>,
) {
  const actual = await original();
  const React = await import("react");
  const Context = React.createContext<{
    open: boolean;
    setOpen: (open: boolean) => void;
  }>({ open: false, setOpen: () => undefined });
  return {
    ...actual,
    DropdownMenu: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <Context.Provider value={{ open, setOpen }}>{children}</Context.Provider>
      );
    },
    DropdownMenuTrigger: ({
      children,
    }: {
      children: React.ReactElement<Record<string, unknown>>;
    }) => {
      const { open, setOpen } = React.useContext(Context);
      return React.cloneElement(children, {
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: () => setOpen(!open),
        onKeyDown: (event: React.KeyboardEvent) => {
          if (["Enter", " ", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          }
        },
      });
    },
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => {
      const { open } = React.useContext(Context);
      return open ? <div role="menu">{children}</div> : null;
    },
    DropdownMenuItem: ({
      children,
      onSelect,
    }: {
      children: React.ReactNode;
      onSelect?: () => void;
    }) => {
      const { setOpen } = React.useContext(Context);
      return (
        <div
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onSelect?.();
            setOpen(false);
          }}
        >
          {children}
        </div>
      );
    },
  };
}

/** A fetch stub that answers each request from a route table. */
export function routeFetch(
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchMock, calls };
}
