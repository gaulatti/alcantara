import { LoadingSpinner } from "@gaulatti/bleecker/components/loading-spinner";

export function AppLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-dark-sand px-6 text-text-primary">
      <div role="status" aria-live="polite" className="flex items-center gap-4">
        <LoadingSpinner size="lg" />
        <div>
          <p className="text-lg font-semibold">Alcántara</p>
          <p className="text-sm text-text-secondary">Opening your workspace…</p>
        </div>
      </div>
    </main>
  );
}
