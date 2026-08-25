import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { IngressClient, RoomServiceClient } = require("livekit-server-sdk");

const host = process.env.LIVEKIT_PROOF_URL ?? "http://localhost:17880";
const apiKey = "devkey";
const apiSecret = "devsecret-devsecret-devsecret-devsecret";
const roomName = "alcantara-ingress-proof";
const ingress = new IngressClient(host, apiKey, apiSecret);
const rooms = new RoomServiceClient(host, apiKey, apiSecret);
const [command, ...args] = process.argv.slice(2);

const inputTypes = {
  rtmp: 0,
  whip: 1,
  hls: 2,
  srt: 2,
};

function printable(value) {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? Number(item) : item),
    2,
  );
}

async function create(kind, identity, url) {
  if (!(kind in inputTypes) || !identity) {
    throw new Error("create requires rtmp|whip|hls|srt and an identity");
  }
  return ingress.createIngress(inputTypes[kind], {
    name: `Alcantara ${kind.toUpperCase()} proof`,
    roomName,
    participantIdentity: identity,
    participantName: identity,
    participantMetadata: JSON.stringify({
      sourceId: identity,
      sourceKind: "external",
      transport: kind,
    }),
    ...(url ? { url } : {}),
    ...(kind === "whip" ? { enableTranscoding: false } : {}),
  });
}

async function summary() {
  const [ingresses, participants] = await Promise.all([
    ingress.listIngress({ roomName }),
    rooms.listParticipants(roomName).catch(() => []),
  ]);
  return {
    ingresses: ingresses.map((item) => ({
      ingressId: item.ingressId,
      name: item.name,
      inputType: item.inputType,
      participantIdentity: item.participantIdentity,
      url: item.url,
      streamKey: item.streamKey ? "[redacted-present]" : "",
      state: item.state,
    })),
    participants: participants.map((participant) => ({
      identity: participant.identity,
      name: participant.name,
      state: participant.state,
      metadata: participant.metadata,
      tracks: participant.tracks.map((track) => ({
        type: track.type,
        source: track.source,
        mimeType: track.mimeType,
        width: track.width,
        height: track.height,
      })),
    })),
  };
}

if (command === "create") {
  const created = await create(args[0], args[1], args[2]);
  console.log(
    printable({
      ingressId: created.ingressId,
      url: created.url,
      streamKey: created.streamKey,
      participantIdentity: created.participantIdentity,
    }),
  );
} else if (command === "summary") {
  console.log(printable(await summary()));
} else if (command === "wait") {
  const [identity, timeoutRaw = "30000"] = args;
  const timeout = Number(timeoutRaw);
  const startedAt = Date.now();
  for (;;) {
    const current = await summary();
    const participant = current.participants.find(
      (item) =>
        item.identity === identity &&
        item.tracks.some((track) => track.type === 0) &&
        item.tracks.some((track) => track.type === 1),
    );
    if (participant) {
      console.log(
        printable({ elapsedMs: Date.now() - startedAt, participant }),
      );
      break;
    }
    if (Date.now() - startedAt >= timeout) {
      throw new Error(`Timed out waiting for ${identity}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} else if (command === "delete") {
  if (!args[0]) throw new Error("delete requires an ingress ID");
  const deleted = await ingress.deleteIngress(args[0]);
  console.log(printable({ ingressId: deleted.ingressId, deleted: true }));
} else if (command === "delete-all") {
  const current = await ingress.listIngress({ roomName });
  await Promise.all(current.map((item) => ingress.deleteIngress(item.ingressId)));
  console.log(printable({ deleted: current.length }));
} else {
  throw new Error("Use create, summary, wait, delete, or delete-all");
}
