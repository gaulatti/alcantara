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

/**
 * Holds a hold-to-confirm control past its hold time (the radio desk's Stop and Stop all, #298).
 * Only the animation clock is faked, so promises and fetches keep their real timing.
 */
export async function holdControl(control: HTMLElement, ms = 700) {
  const { act, fireEvent } = await import("@testing-library/react");
  const { vi } = await import("vitest");
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  });
  try {
    fireEvent.pointerDown(control);
    await act(async () => {
      vi.advanceTimersByTime(ms);
    });
    fireEvent.pointerUp(control);
  } finally {
    vi.useRealTimers();
  }
}
