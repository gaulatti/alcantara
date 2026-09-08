export interface ProgramTemplateManifest {
  kind: "alcantara.program-template";
  contractVersion: 1;
  id: string;
  name: string;
  package: string;
  bundleVersion: string;
  schemaVersion: number;
  entrypoint: string;
  entrypointUrl: string;
  capabilities: string[];
  control: {
    protocol: "alcantara.program.v1";
    transport: "server-sent-events";
    snapshotPath: string;
    eventsPath: string;
    runtimeParameters: {
      programId: string;
      apiBaseUrl: string;
    };
    signals: string[];
  };
}

export interface ProgramWithTemplate {
  programId: string;
  templateUrl?: string | null;
  templateManifest?: ProgramTemplateManifest | null;
  templateVerifiedAt?: string | null;
}

export function hasProgramCapability(
  manifest: ProgramTemplateManifest | null | undefined,
  capability: string,
): boolean {
  return manifest?.capabilities.includes(capability) === true;
}

export function resolveProgramOutputUrl(
  program: ProgramWithTemplate,
  apiBaseUrl: string,
): string {
  const manifest = program.templateManifest;
  if (!manifest?.entrypointUrl) {
    return `/program/${encodeURIComponent(program.programId)}`;
  }

  const output = new URL(manifest.entrypointUrl);
  output.searchParams.set(
    manifest.control.runtimeParameters.programId,
    program.programId,
  );
  output.searchParams.set(
    manifest.control.runtimeParameters.apiBaseUrl,
    apiBaseUrl.replace(/\/$/, ""),
  );
  return output.toString();
}
