import assert from "node:assert/strict";
import { test } from "node:test";
import { avoidsUdp, describePath, offeredCandidate, selectedPath } from "./ice-path.mjs";

const reports = (local, extra = []) => [
  { id: "L", type: "local-candidate", ...local },
  { id: "R", type: "remote-candidate", candidateType: "host", protocol: local.protocol, port: 7881, address: "203.0.113.9" },
  { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", nominated: true, state: "succeeded" },
  ...extra,
];

test("reads the pair the transport selected, without addresses", () => {
  const path = selectedPath(
    reports({ candidateType: "host", protocol: "tcp", address: "198.51.100.4" }, [{ id: "T", type: "transport", selectedCandidatePairId: "P" }]),
  );
  assert.deepEqual(path, { local: "host", protocol: "tcp", remote: "host", remotePort: 7881 });
  assert.equal(describePath(path), "host tcp -> host :7881");
  assert.equal(avoidsUdp(path), true);
});

test("falls back to the nominated pair, and says nothing when none connected", () => {
  assert.equal(selectedPath(reports({ candidateType: "host", protocol: "udp" })).protocol, "udp");
  assert.equal(selectedPath([{ id: "P", type: "candidate-pair", state: "failed" }]), null);
});

test("counts a relay only when it is reached without UDP", () => {
  assert.equal(avoidsUdp({ local: "host", protocol: "udp" }), false);
  assert.equal(avoidsUdp({ local: "relay", protocol: "udp", relayProtocol: "tls" }), true);
  assert.equal(avoidsUdp({ local: "relay", protocol: "udp", relayProtocol: "udp" }), false);
  assert.equal(avoidsUdp({ local: "relay", protocol: "udp" }), false);
  assert.equal(describePath({ local: "relay", protocol: "udp", relayProtocol: "tls", remote: "host", remotePort: 443 }), "relay over tls -> host :443");
});

test("names an offered candidate without its address", () => {
  assert.equal(offeredCandidate("candidate:1 1 TCP 1671430143 203.0.113.9 7881 typ host tcptype passive"), "host tcp :7881");
  assert.equal(offeredCandidate("a=candidate:2 1 udp 1 203.0.113.9 7882 typ host"), "host udp :7882");
  assert.equal(offeredCandidate("a=mid:0"), null);
});
