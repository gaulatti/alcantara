// Which ICE candidate pair a peer connection really used, from its getStats() reports. No addresses are kept: the
// candidate types, protocols and the server's port say whether media went over UDP, TCP or a relay.

/** The selected pair of one connection's reports, or null when none was selected. */
export function selectedPath(reports) {
  const byId = new Map(reports.map((report) => [report.id, report]));
  const transport = reports.find((report) => report.type === "transport" && report.selectedCandidatePairId);
  const pair =
    byId.get(transport?.selectedCandidatePairId) ??
    reports.find((report) => report.type === "candidate-pair" && report.nominated && report.state === "succeeded");
  const local = byId.get(pair?.localCandidateId);
  const remote = byId.get(pair?.remoteCandidateId);
  if (!local || !remote) return null;
  return {
    local: local.candidateType,
    protocol: local.protocol,
    ...(local.relayProtocol ? { relayProtocol: local.relayProtocol } : {}),
    remote: remote.candidateType,
    remotePort: remote.port ?? null,
  };
}

/** No plain UDP left the guest's machine: TCP to the server, or a relay reached over TCP or TLS. */
export const avoidsUdp = (path) => (path.local === "relay" ? path.relayProtocol !== "udp" && path.relayProtocol !== undefined : path.protocol === "tcp");

export function describePath(path) {
  const via = path.local === "relay" ? `relay over ${path.relayProtocol ?? "?"}` : `${path.local} ${path.protocol}`;
  return `${via} -> ${path.remote} :${path.remotePort ?? "?"}`;
}

/** A candidate line (`candidate:… <protocol> … <port> typ <type>`) without its address, or null for anything else. */
export function offeredCandidate(line) {
  const parts = String(line).replace(/^a=/, "").trim().split(/\s+/);
  if (!parts[0]?.startsWith("candidate:") || parts[6] !== "typ") return null;
  return `${parts[7]} ${parts[2].toLowerCase()} :${parts[5]}`;
}

/** Whether the pairs used meet what the run demands: "tcp" no plain UDP, "relay" a relay reached over TLS. */
export function iceSatisfied(ice, used) {
  if (!ice) return true;
  return used.length > 0 && used.every(ice === "relay" ? (path) => path.local === "relay" && path.relayProtocol === "tls" : avoidsUdp);
}

/** What a failed run says. A relay run that tried to connect and could gather no relay candidate says that, not a timeout. */
export function failureReason(ice, own, error) {
  if (ice !== "relay" || !own?.attempts || own.gathered.some((candidate) => candidate.startsWith("relay "))) return error;
  const given = own.turnServers.length ? own.turnServers.join(", ") : "none";
  return `no relay candidates offered (TURN servers given to the page: ${given}; ${error})`;
}
