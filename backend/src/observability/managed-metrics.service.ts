import { Injectable } from '@nestjs/common';
import {
  OUTBOUND_FETCH_PATHS,
  OUTBOUND_FETCH_RESULTS,
} from '../outbound/safe-fetch';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

/** Why the authorization guard refused a request before any authorization call. */
export const AUTH_REFUSAL_REASONS = ['unsupported_credential'] as const;
/** Mirrors POMPEII_CHANNEL_RESET_REASONS in auth/pompeii.service.ts. */
export const POMPEII_CHANNEL_RESET_METRIC_REASONS = [
  'deadline_exceeded',
  'unavailable',
] as const;
/** The access screen's Pompeii calls (gaulatti/alcantara#224), one per RPC. */
export const ACCESS_METRIC_ROUTES = [
  'tokens_list',
  'token_create',
  'token_revoke',
  'token_switch_get',
  'token_switch_set',
  'roles_list',
  'grants_list',
  'grant_create',
  'grant_revoke',
  'history_list',
] as const;
/** How an access call ended; mirrors the contract's HTTP error table. */
export const ACCESS_METRIC_RESULTS = [
  'ok',
  'unauthenticated',
  'forbidden',
  'invalid_request',
  'tokens_off',
  'not_found',
  'unavailable',
  'not_configured',
] as const;
/** How a GET /metrics/palazzo passthrough scrape ended. */
export const PALAZZO_METRICS_SCRAPE_RESULTS = [
  'ok',
  'unavailable',
  'timeout',
  'too_large',
  'error',
] as const;
/** Who reported on a guest call: a guest's browser (or the API refusing it), or an operator's talkback. */
export const WEBRTC_CLIENTS = ['guest', 'operator'] as const;
/** How joining a call ended (alcantara_webrtc_joins_total). */
export const WEBRTC_JOIN_RESULTS = [
  'success',
  'permission_denied',
  'no_device',
  'ice_failed',
  'token_rejected',
  'invite_expired',
  'other',
] as const;
/** The selected ICE path: direct over UDP or TCP, or relayed by TURN. */
export const WEBRTC_ICE_PATHS = ['udp', 'tcp', 'relay'] as const;
/** Operator cues stored on guests (alcantara_webrtc_guest_cues_total). */
export const GUEST_CUES = ['standby', 'live', 'wrap'] as const;
export type GuestCue = (typeof GUEST_CUES)[number];
/** Requests a standby held for the playout lease (alcantara_playout_held_requests_total), alcantara#873. */
export const PLAYOUT_HOLD_RESULTS = ['served', 'timeout', 'rejected'] as const;
export type PlayoutHoldResult = (typeof PLAYOUT_HOLD_RESULTS)[number];
/** Return runner polls (alcantara_webrtc_return_router_polls_total). */
export const RETURN_ROUTER_POLL_RESULTS = [
  'ok',
  'rejected',
  'failure',
] as const;
export type ReturnRouterPollResult =
  (typeof RETURN_ROUTER_POLL_RESULTS)[number];
/** Program-audio grants for the return router (alcantara_webrtc_return_audio_tickets_total). */
export const RETURN_AUDIO_TICKET_RESULTS = [
  'issued',
  'rejected',
  'unavailable',
] as const;
export type ReturnAudioTicketResult =
  (typeof RETURN_AUDIO_TICKET_RESULTS)[number];
export type WebrtcClient = (typeof WEBRTC_CLIENTS)[number];
export type WebrtcJoinResult = (typeof WEBRTC_JOIN_RESULTS)[number];
export type WebrtcIcePath = (typeof WEBRTC_ICE_PATHS)[number];
/** Results of alcantara_mcp_auth_total (gaulatti/alcantara#211). */
export const MCP_AUTH_METRIC_RESULTS = [
  'ok',
  'unauthenticated',
  'forbidden',
  'unavailable',
  'rate_limited',
] as const;

/** Steps of alcantara_mcp_oauth_total (gaulatti/bastille#34). */
export const MCP_OAUTH_METRIC_STEPS = [
  'authorize',
  'callback',
  'token',
  'refresh',
] as const;
/** Results of alcantara_mcp_oauth_total (gaulatti/bastille#34). */
export const MCP_OAUTH_METRIC_RESULTS = [
  'consent',
  'cancelled',
  'proxied',
  'refused',
  'unknown_state',
  'unbound',
  'provider_error',
  'exchange_failed',
  'issued',
  'passed_through',
  'upstream_refused',
  'upstream_unavailable',
] as const;

/** Results of alcantara_mcp_requests_total (gaulatti/alcantara#212); mirrors MCP_REQUEST_RESULTS. */
export const MCP_REQUEST_METRIC_RESULTS = [
  'ok',
  'dry_run',
  'forbidden',
  'invalid',
  'not_found',
  'conflict',
  'stale_target',
  'confirm_required',
  'confirm_mismatch',
  'idempotency_reuse',
  'rate_limited',
  'on_air',
  'palazzo_unavailable',
  'unavailable',
] as const;
const MCP_REQUEST_METRIC_TIERS = new Set(['R', 'W', 'A', 'D']);

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);
const HTTP_ROUTES = new Set([
  'root',
  'metrics',
  'auth',
  'access',
  'operator-preferences',
  'program',
  'radio',
  'scenes',
  'layouts',
  'charts',
  'uploads',
  'songs',
  'instants',
  'media',
  'media-groups',
  'media-assets',
  'media-labels',
  'stingers',
  'webrtc',
  'broadcast',
  'external-sources',
  'mcp',
  'oauth',
  'probe',
  'unmatched',
  'unknown',
]);
const DEPENDENCIES = new Set([
  'pompeii',
  'palazzo',
  'now-playing',
  'earone',
  'escplus',
  'postgres',
  's3',
  'livekit',
  'alana',
  'program-template',
  'unknown',
]);
const DEPENDENCY_OPERATIONS = new Set([
  'authorize',
  'connect',
  'publish',
  'fetch',
  'read',
  'write',
  'status',
  'reload',
  'start',
  'stop',
  'profile',
  'prepare',
  'unknown',
]);
const DEPENDENCY_RESULTS = new Set([
  'success',
  'denied',
  'http-error',
  'unavailable',
  'invalid-response',
  'skipped',
  'failure',
  'unknown',
]);
const JOBS = new Set([
  'charts-refresh',
  'database-backup',
  'media-asset-reconciliation',
  'unknown',
]);
const JOB_RESULTS = new Set(['success', 'failure', 'skipped', 'unknown']);
const MEDIA_LABEL_ASSIGNMENT_RESULTS = new Set(['success', 'failure']);
const ARTIST_LABEL_WRITE_RESULTS = ['set', 'cleared', 'rejected'] as const;
/** gaulatti/alcantara#236: what an operator change record is about, and whether it was stored. */
const OPERATOR_CHANGE_TARGETS = new Set([
  'scene',
  'layout',
  'flight_sequence',
  'program',
  'instant',
  'stinger',
  'song',
  'media',
  'media_label',
  'media_label_assets',
  'media_group',
]);
const OPERATOR_CHANGE_RESULTS = new Set(['recorded', 'failed']);
/** gaulatti/alcantara#424: a recipe use previewed or built (`issues`: built, with something to fix). */
const RECIPE_EXPANSION_RESULTS = new Set(['ok', 'issues', 'rejected']);
/** gaulatti/alcantara#424: a use rebuilt after its recipe changed, left on air, or lost to a concurrent edit. */
const RECIPE_REBUILD_RESULTS = new Set(['rebuilt', 'skipped', 'conflict']);
/** gaulatti/alcantara#465: a recipe delete, or why it was refused. */
const RECIPE_DELETE_RESULTS = new Set([
  'deleted',
  'refused_on_air',
  'refused_has_uses',
  'conflict',
]);
const SCENE_HANDOFF_RESULTS = new Set(['success', 'failure']);
/** gaulatti/alcantara#122: a program another team owns, one nobody owns, or a team that could not be read. */
const PROGRAM_TEAM_CHECK_RESULTS = new Set([
  'refused',
  'unowned',
  'lookup-failed',
]);
/** gaulatti/alcantara#122: why a scene background asset read was not served by the program's team. */
export type SceneAssetScopeReason = 'no-team' | 'other-team' | 'lookup-failed';
const SCENE_ASSET_SCOPE_REASONS = new Set<string>([
  'no-team',
  'other-team',
  'lookup-failed',
]);
const PREFERENCE_ACTIONS = new Set([
  'read',
  'write',
  'reset-class',
  'reset-all',
  'publish',
  'retire',
  'load-shared',
]);
const PREFERENCE_RESULTS = new Set([
  'success',
  'default',
  'conflict',
  'failure',
]);
const SOURCE_ACTIONS = new Set([
  'create',
  'update',
  'read',
  'rotate',
  'revoke',
  'reconcile',
  'redirect',
]);
const SOURCE_RESULTS = new Set(['success', 'rejected', 'not-found', 'failure']);
const PROGRAM_SSE_SNAPSHOT_RESULTS = new Set(['success', 'failure']);
/** How a confirmed playing track's cover lookup ended (gaulatti/alcantara#179). */
export type PlayingTrackCoverLookupResult =
  | 'included'
  | 'absent'
  | 'rejected'
  | 'error';
/** How a filler version's preparation ended (gaulatti/alcantara#126). */
export type FillerPreparationResult =
  | 'ready'
  | 'failed'
  | 'unavailable'
  | 'profile-unavailable'
  // The program has no team, so no media asset may be used (gaulatti/alcantara#122).
  | 'no-team';
const FILLER_LEGS = ['television', 'radio'] as const;
const FILLER_PREPARATION_RESULTS: readonly FillerPreparationResult[] = [
  'ready',
  'failed',
  'unavailable',
  'profile-unavailable',
  'no-team',
];
/** What a television Start did with the program filler (gaulatti/alcantara#126). */
export type FillerStartBindingResult =
  | 'bound'
  | 'mismatch'
  | 'not-configured'
  | 'legacy-executor';
/**
 * A template manifest member Alcantara does not know and leaves out instead of
 * refusing the template (gaulatti/ariston#217). The label is the member kind,
 * never the unknown name.
 */
export type ProgramTemplateUnknownMember =
  | 'signal'
  | 'capability'
  | 'property'
  | 'control-property'
  | 'runtime-parameter';

const PROGRAM_TEMPLATE_UNKNOWN_MEMBERS: readonly ProgramTemplateUnknownMember[] =
  ['signal', 'capability', 'property', 'control-property', 'runtime-parameter'];

const FILLER_START_BINDING_RESULTS: readonly FillerStartBindingResult[] = [
  'bound',
  'mismatch',
  'not-configured',
  'legacy-executor',
];
const FILLER_RELEASE_RESULTS = ['released', 'failed'] as const;
const PLAYING_TRACK_COVER_LOOKUP_RESULTS: readonly PlayingTrackCoverLookupResult[] =
  ['included', 'absent', 'rejected', 'error'];
const RECORDING_ACTIONS = new Set(['start', 'stop']);
const RECORDING_STATES = new Set([
  'disabled',
  'idle',
  'requested',
  'active',
  'finalizing',
  'complete',
  'failed',
]);
const RECORDING_RESULTS = new Set([
  'success',
  'accepted',
  'complete',
  'failed',
  'disabled',
  'already-active',
  'not-active',
  'pipeline-not-ready',
  'disk-exhausted',
  'quota-exhausted',
  'capture-failed',
  'restart-exhausted',
  'manifest-corrupt',
  'segment-corrupt',
  'finalize-failed',
  'final-artifact-invalid',
  'unavailable',
  'invalid-response',
  'failure',
]);

function bounded(value: string, allowed: Set<string>): string {
  return allowed.has(value) ? value : 'unknown';
}

function buildVersion(): string {
  const candidate = process.env.ALCANTARA_BUILD_VERSION ?? 'dev';
  return /^[A-Za-z0-9._-]{1,64}$/.test(candidate) ? candidate : 'unknown';
}

const SONG_SEQUENCE_SAVE_RESULTS = [
  'versioned',
  'unversioned',
  'refused_missing',
  'refused_stale',
  'refused_emptying',
] as const;

@Injectable()
export class ManagedMetricsService {
  readonly registry = new Registry();
  private readonly httpRequests: Counter<string>;
  private readonly httpDuration: Histogram<string>;
  private readonly dependencyOperations: Counter<string>;
  private readonly dependencyDuration: Histogram<string>;
  private readonly jobs: Counter<string>;
  private readonly mediaLabelAssignments: Counter<string>;
  private readonly artistLabelWrites: Counter<string>;
  private readonly operatorChangeRecords: Counter<string>;
  private readonly recipeExpansions: Counter<string>;
  private readonly songSequenceSaves: Counter<'result'>;
  private readonly recipeRebuilds: Counter<string>;
  private readonly recipeDeletes: Counter<string>;
  private readonly sceneHandoffs: Counter<string>;
  private readonly programTeamChecks: Counter<string>;
  private readonly sceneAssetScopeRefusals: Counter<string>;
  private readonly jobLastSuccess: Gauge<string>;
  private readonly preferenceOperations: Counter<string>;
  private readonly broadcastDestinationOperations: Counter<string>;
  private readonly sourceOperations: Counter<string>;
  private readonly outboundFetches: Counter<string>;
  private readonly authRefusals: Counter<string>;
  private readonly pompeiiChannelResets: Counter<string>;
  private readonly accessRequests: Counter<string>;
  private readonly accessDuration: Histogram<string>;
  private readonly palazzoMetricsScrapes: Counter<string>;
  private readonly palazzoMetricsScrapeDuration: Histogram<string>;
  private readonly webrtcJoins: Counter<'client' | 'result'>;
  private readonly webrtcIcePaths: Counter<'client' | 'path'>;
  private readonly webrtcDrops: Counter;
  private readonly webrtcRoomAdmissionRemovals: Counter;
  private readonly returnRouterPolls: Counter;
  private readonly returnRoutersWanted: Gauge;
  private readonly returnRoutersRunning: Gauge;
  private readonly returnRunnerLastPoll: Gauge;
  private readonly returnAudioTickets: Counter;
  private readonly playoutLease: Gauge;
  private readonly playoutLeaseLost: Counter;
  private readonly playoutActivation: Histogram;
  private readonly playoutHeld: Counter;
  private readonly playoutHold: Histogram;
  private readonly guestCues: Counter;
  private readonly onAirGuests: Gauge;
  private readonly mcpAuth: Counter<string>;
  private readonly mcpOAuth: Counter<string>;
  private readonly mcpRequests: Counter<string>;
  private mcpToolNames = new Set<string>();
  private readonly sourceInventory: Gauge<string>;
  private readonly programSseConnections: Gauge<string>;
  private readonly programSseSnapshots: Counter<string>;
  private readonly playingTrackCoverLookups: Counter<string>;
  private readonly fillerPreparations: Counter<string>;
  private readonly fillerStartBindings: Counter<string>;
  private readonly fillerReleases: Counter<'leg' | 'result'>;
  private readonly alanaLiveProfileUnknownKeys: Counter<string>;
  private readonly programTemplateUnknowns: Counter<string>;
  private readonly recordingCommands: Counter<string>;
  private readonly recordingReconciliations: Counter<string>;

  constructor() {
    collectDefaultMetrics({ prefix: 'alcantara_', register: this.registry });
    // prom-client 15 exposes these as gauges despite the counter-only `_total`
    // suffix. Prometheus 3 rejects that exposition, so retain the bounded
    // per-type gauges and drop only the invalid aggregate aliases.
    for (const name of [
      'alcantara_nodejs_active_handles_total',
      'alcantara_nodejs_active_requests_total',
      'alcantara_nodejs_active_resources_total',
    ]) {
      this.registry.removeSingleMetric(name);
    }

    new Gauge({
      name: 'alcantara_service_info',
      help: 'Alcantara service, runtime, and build identity.',
      labelNames: ['service', 'runtime', 'version'],
      registers: [this.registry],
    }).set(
      { service: 'alcantara', runtime: 'nodejs', version: buildVersion() },
      1,
    );

    this.httpRequests = new Counter({
      name: 'alcantara_http_requests_total',
      help: 'HTTP requests by bounded method, route group, and status class.',
      labelNames: ['method', 'route', 'status_class'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'alcantara_http_request_duration_seconds',
      help: 'HTTP request duration by bounded method and route group.',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    this.dependencyOperations = new Counter({
      name: 'alcantara_dependency_operations_total',
      help: 'External dependency operations by bounded dependency, operation, and result.',
      labelNames: ['dependency', 'operation', 'result'],
      registers: [this.registry],
    });
    this.dependencyDuration = new Histogram({
      name: 'alcantara_dependency_duration_seconds',
      help: 'External dependency operation duration by bounded dependency and operation.',
      labelNames: ['dependency', 'operation'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    this.jobs = new Counter({
      name: 'alcantara_jobs_total',
      help: 'Background job runs by bounded job and result.',
      labelNames: ['job', 'result'],
      registers: [this.registry],
    });
    this.mediaLabelAssignments = new Counter({
      name: 'alcantara_media_label_assignments_total',
      help: 'Media asset label replacement transactions by result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.artistLabelWrites = new Counter({
      name: 'alcantara_artist_label_writes_total',
      help: 'Artist media label writes by bounded result (set, cleared or rejected).',
      labelNames: ['result'],
      registers: [this.registry],
    });
    for (const result of ARTIST_LABEL_WRITE_RESULTS)
      this.artistLabelWrites.labels(result).inc(0);
    this.operatorChangeRecords = new Counter({
      name: 'alcantara_operator_change_records_total',
      help: 'Operator change records of on-air changes by bounded target and result; a failed record never fails the change.',
      labelNames: ['target', 'result'],
      registers: [this.registry],
    });
    this.songSequenceSaves = new Counter({
      name: 'alcantara_song_sequence_saves_total',
      help: 'Operator saves of a rotation, by result: versioned, unversioned (a client that sends no version), or refused because the version was missing or stale, or the save would have emptied the rotation. Exposed from 0.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    for (const result of SONG_SEQUENCE_SAVE_RESULTS)
      this.songSequenceSaves.inc({ result }, 0);
    this.recipeExpansions = new Counter({
      name: 'alcantara_recipe_expansions_total',
      help: 'Rundown recipe uses previewed or built, by result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.recipeRebuilds = new Counter({
      name: 'alcantara_recipe_rebuilds_total',
      help: 'Recipe uses rebuilt after their recipe changed, by result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.recipeDeletes = new Counter({
      name: 'alcantara_recipe_deletes_total',
      help: 'Rundown recipe deletes by result: deleted, or refused (on air, has uses, conflict).',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.programTeamChecks = new Counter({
      name: 'alcantara_program_team_checks_total',
      help: 'Requests naming a program of another team (refused) or of no team (unowned), and team lookups that failed (lookup-failed). Exposed from 0.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    for (const result of PROGRAM_TEAM_CHECK_RESULTS)
      this.programTeamChecks.inc({ result }, 0);
    this.sceneAssetScopeRefusals = new Counter({
      name: 'alcantara_scene_asset_scope_refusals_total',
      help: 'Scene background asset reads the program team could not serve, read unscoped instead, by reason. Exposed from 0.',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    for (const reason of SCENE_ASSET_SCOPE_REASONS)
      this.sceneAssetScopeRefusals.inc({ reason }, 0);
    this.sceneHandoffs = new Counter({
      name: 'alcantara_scene_handoffs_total',
      help: 'Atomic Program and Preview scene handoff persistence outcomes.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.jobLastSuccess = new Gauge({
      name: 'alcantara_job_last_success_timestamp_seconds',
      help: 'Unix timestamp of the last successful background job run.',
      labelNames: ['job'],
      registers: [this.registry],
    });
    this.preferenceOperations = new Counter({
      name: 'alcantara_operator_preference_operations_total',
      help: 'Operator preference operations by bounded action and result.',
      labelNames: ['action', 'result'],
      registers: [this.registry],
    });
    this.broadcastDestinationOperations = new Counter({
      name: 'alcantara_broadcast_destination_operations_total',
      help: 'Versioned broadcast destination operations by bounded action and result.',
      labelNames: ['action', 'result'],
      registers: [this.registry],
    });
    this.outboundFetches = new Counter({
      name: 'alcantara_outbound_fetch_total',
      help: 'Fetches of a supplied URL under the outbound-request policy, by caller and bounded result; never the URL.',
      labelNames: ['path', 'result'],
      registers: [this.registry],
    });
    for (const path of OUTBOUND_FETCH_PATHS)
      for (const result of OUTBOUND_FETCH_RESULTS)
        this.outboundFetches.labels(path, result).inc(0);
    this.authRefusals = new Counter({
      name: 'alcantara_auth_refusals_total',
      help: 'Requests the authorization guard refused before any authorization call, by bounded reason.',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    for (const reason of AUTH_REFUSAL_REASONS)
      this.authRefusals.labels(reason).inc(0);
    this.pompeiiChannelResets = new Counter({
      name: 'alcantara_pompeii_channel_resets_total',
      help: 'Pompeii gRPC channels replaced after a timed-out or unavailable call, by bounded reason.',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    for (const reason of POMPEII_CHANNEL_RESET_METRIC_REASONS)
      this.pompeiiChannelResets.labels(reason).inc(0);
    this.accessRequests = new Counter({
      name: 'alcantara_access_requests_total',
      help: 'Calls to Pompeii application access service by bounded route and result.',
      labelNames: ['route', 'result'],
      registers: [this.registry],
    });
    this.accessDuration = new Histogram({
      name: 'alcantara_access_request_duration_seconds',
      help: 'Duration of calls to Pompeii application access service by bounded route.',
      labelNames: ['route'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
    for (const route of ACCESS_METRIC_ROUTES)
      for (const result of ACCESS_METRIC_RESULTS)
        this.accessRequests.labels(route, result).inc(0);
    this.palazzoMetricsScrapes = new Counter({
      name: 'alcantara_palazzo_metrics_scrape_total',
      help: 'Palazzo metrics passthrough scrapes by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.palazzoMetricsScrapeDuration = new Histogram({
      name: 'alcantara_palazzo_metrics_scrape_duration_seconds',
      help: 'Duration of Palazzo metrics passthrough scrapes.',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 2.5],
      registers: [this.registry],
    });
    for (const result of PALAZZO_METRICS_SCRAPE_RESULTS)
      this.palazzoMetricsScrapes.labels(result).inc(0);
    this.webrtcJoins = new Counter({
      name: 'alcantara_webrtc_joins_total',
      help: 'Guest call join outcomes by bounded client and result.',
      labelNames: ['client', 'result'],
      registers: [this.registry],
    });
    this.webrtcIcePaths = new Counter({
      name: 'alcantara_webrtc_ice_path_total',
      help: 'Calls connected, by bounded client and selected ICE path.',
      labelNames: ['client', 'path'],
      registers: [this.registry],
    });
    this.webrtcDrops = new Counter({
      name: 'alcantara_webrtc_drops_total',
      help: 'Guest calls lost after connecting, not ended by the guest or the studio.',
      registers: [this.registry],
    });
    this.webrtcRoomAdmissionRemovals = new Counter({
      name: 'alcantara_webrtc_room_admission_removals_total',
      help: 'Guests the admission check removed from a program room: no open, admitted session for them.',
      registers: [this.registry],
    });
    this.returnRouterPolls = new Counter({
      name: 'alcantara_webrtc_return_router_polls_total',
      help: 'Return runner polls for the programs that need a return router, by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.returnRoutersWanted = new Gauge({
      name: 'alcantara_webrtc_return_routers_wanted',
      help: 'Programs that need a server-run return router at the last poll: an admitted guest present, or within the linger after the last one left.',
      registers: [this.registry],
    });
    this.returnRoutersRunning = new Gauge({
      name: 'alcantara_webrtc_return_routers_running',
      help: 'Return routers the runner reported open and connected at its last poll.',
      registers: [this.registry],
    });
    this.returnRunnerLastPoll = new Gauge({
      name: 'alcantara_webrtc_return_runner_last_poll_timestamp_seconds',
      help: "Unix time of the return runner's last accepted poll; a stale value means no runner is polling.",
      registers: [this.registry],
    });
    this.returnAudioTickets = new Counter({
      name: 'alcantara_webrtc_return_audio_tickets_total',
      help: 'Program-audio grants requested by the return router, by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.guestCues = new Counter({
      name: 'alcantara_webrtc_guest_cues_total',
      help: 'Operator cues stored on call guests, by bounded cue.',
      labelNames: ['cue'],
      registers: [this.registry],
    });
    this.onAirGuests = new Gauge({
      name: 'alcantara_webrtc_on_air_guests',
      help: 'Call guests on air (cued live in their current session) at the last on-air contribution poll.',
      registers: [this.registry],
    });
    for (const cue of GUEST_CUES) this.guestCues.labels(cue).inc(0);
    this.playoutLease = new Gauge({
      name: 'alcantara_playout_lease',
      help: "This instance's playout lease state (alcantara#873): 1 for the current state, standby or active.",
      labelNames: ['state'],
      registers: [this.registry],
    });
    this.playoutLeaseLost = new Counter({
      name: 'alcantara_playout_lease_lost_total',
      help: 'Times the active instance lost its playout lease connection and stopped so no second engine could run.',
      registers: [this.registry],
    });
    this.playoutActivation = new Histogram({
      name: 'alcantara_playout_activation_seconds',
      help: 'Time from taking the playout lease to running every writer and scheduler.',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    });
    this.playoutHeld = new Counter({
      name: 'alcantara_playout_held_requests_total',
      help: 'Requests a standby held until it took the playout lease, by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.playoutHold = new Histogram({
      name: 'alcantara_playout_hold_seconds',
      help: 'How long a standby held a request before serving or refusing it.',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20],
      registers: [this.registry],
    });
    for (const result of PLAYOUT_HOLD_RESULTS)
      this.playoutHeld.labels(result).inc(0);
    for (const result of RETURN_ROUTER_POLL_RESULTS)
      this.returnRouterPolls.labels(result).inc(0);
    for (const result of RETURN_AUDIO_TICKET_RESULTS)
      this.returnAudioTickets.labels(result).inc(0);
    for (const client of WEBRTC_CLIENTS) {
      for (const result of WEBRTC_JOIN_RESULTS)
        this.webrtcJoins.labels(client, result).inc(0);
      for (const path of WEBRTC_ICE_PATHS)
        this.webrtcIcePaths.labels(client, path).inc(0);
    }
    this.mcpAuth = new Counter({
      name: 'alcantara_mcp_auth_total',
      help: 'MCP endpoint authentications by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    for (const result of MCP_AUTH_METRIC_RESULTS)
      this.mcpAuth.labels(result).inc(0);
    this.mcpOAuth = new Counter({
      name: 'alcantara_mcp_oauth_total',
      help: 'MCP sign-in steps through the API (bastille#34) by bounded step and result.',
      labelNames: ['step', 'result'],
      registers: [this.registry],
    });
    this.mcpRequests = new Counter({
      name: 'alcantara_mcp_requests_total',
      help: 'MCP tool calls by registered tool, tier and bounded result.',
      labelNames: ['tool', 'tier', 'result'],
      registers: [this.registry],
    });
    this.sourceOperations = new Counter({
      name: 'alcantara_external_source_operations_total',
      help: 'External source registry operations by bounded action and result.',
      labelNames: ['action', 'result'],
      registers: [this.registry],
    });
    this.sourceInventory = new Gauge({
      name: 'alcantara_external_source_inventory',
      help: 'Current external source inventory by bounded transport and lifecycle.',
      labelNames: ['transport', 'lifecycle'],
      registers: [this.registry],
    });
    this.programSseConnections = new Gauge({
      name: 'alcantara_program_sse_connections',
      help: 'Currently open program SSE subscriber connections.',
      registers: [this.registry],
    });
    this.programSseSnapshots = new Counter({
      name: 'alcantara_program_sse_snapshots_total',
      help: 'Initial program SSE snapshots by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.fillerPreparations = new Counter({
      name: 'alcantara_filler_preparations_total',
      help: 'Program filler version preparations by bounded leg and result.',
      labelNames: ['leg', 'result'],
      registers: [this.registry],
    });
    this.fillerReleases = new Counter({
      name: 'alcantara_filler_releases_total',
      help: 'Active filler versions released after a Stop, by leg and result. A failed release leaves the version active and never fails the Stop.',
      labelNames: ['leg', 'result'],
      registers: [this.registry],
    });
    for (const leg of FILLER_LEGS)
      for (const result of FILLER_RELEASE_RESULTS)
        this.fillerReleases.inc({ leg, result }, 0);
    this.fillerStartBindings = new Counter({
      name: 'alcantara_filler_start_bindings_total',
      help: 'Television Start filler bindings by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    for (const leg of FILLER_LEGS) {
      for (const result of FILLER_PREPARATION_RESULTS) {
        this.fillerPreparations.inc({ leg, result }, 0);
      }
    }
    for (const result of FILLER_START_BINDING_RESULTS) {
      this.fillerStartBindings.inc({ result }, 0);
    }
    this.alanaLiveProfileUnknownKeys = new Counter({
      name: 'alcantara_alana_live_profile_unknown_keys_total',
      help: 'Alana live-profile keys Alcantara does not know, accepted and forwarded unread.',
      registers: [this.registry],
    });
    this.alanaLiveProfileUnknownKeys.inc(0);
    this.programTemplateUnknowns = new Counter({
      name: 'alcantara_program_template_unknowns_ignored_total',
      help: 'Template manifest members Alcantara does not know and left out, by bounded member kind.',
      labelNames: ['member'],
      registers: [this.registry],
    });
    for (const member of PROGRAM_TEMPLATE_UNKNOWN_MEMBERS) {
      this.programTemplateUnknowns.inc({ member }, 0);
    }
    this.playingTrackCoverLookups = new Counter({
      name: 'alcantara_program_playing_track_cover_lookups_total',
      help: 'Song-record cover lookups for confirmed playing tracks by bounded result.',
      labelNames: ['result'],
      registers: [this.registry],
    });
    // Expose the whole bounded label set from the first scrape.
    for (const result of PLAYING_TRACK_COVER_LOOKUP_RESULTS) {
      this.playingTrackCoverLookups.inc({ result }, 0);
    }
    this.recordingCommands = new Counter({
      name: 'alcantara_recording_commands_total',
      help: 'Recording control commands by bounded action and result.',
      labelNames: ['action', 'result'],
      registers: [this.registry],
    });
    this.recordingReconciliations = new Counter({
      name: 'alcantara_recording_reconciliations_total',
      help: 'Alana recording status reconciliations by bounded state and result.',
      labelNames: ['state', 'result'],
      registers: [this.registry],
    });
  }

  recordSongSequenceSave(
    result: (typeof SONG_SEQUENCE_SAVE_RESULTS)[number],
  ): void {
    this.songSequenceSaves.inc({ result });
  }

  recordHttp(
    method: string,
    route: string,
    status: number,
    seconds: number,
  ): void {
    const normalizedMethod = bounded(method.toUpperCase(), HTTP_METHODS);
    const normalizedRoute = bounded(route, HTTP_ROUTES);
    const statusClass =
      status >= 100 && status <= 599
        ? `${Math.floor(status / 100)}xx`
        : 'unknown';
    this.httpRequests.inc({
      method: normalizedMethod,
      route: normalizedRoute,
      status_class: statusClass,
    });
    this.httpDuration.observe(
      { method: normalizedMethod, route: normalizedRoute },
      Math.max(0, seconds),
    );
  }

  recordDependency(
    dependency: string,
    operation: string,
    result: string,
    seconds: number,
  ): void {
    const labels = {
      dependency: bounded(dependency, DEPENDENCIES),
      operation: bounded(operation, DEPENDENCY_OPERATIONS),
    };
    this.dependencyOperations.inc({
      ...labels,
      result: bounded(result, DEPENDENCY_RESULTS),
    });
    this.dependencyDuration.observe(labels, Math.max(0, seconds));
  }

  /**
   * gaulatti/alcantara#122. The gauge exists only while there is a value, because an unlabelled gauge would
   * otherwise be scraped as 0 before anything was read.
   */
  setMediaAssetsWithoutTeam(count: number | null): void {
    const name = 'alcantara_media_assets_without_team';
    if (count === null) {
      this.registry.removeSingleMetric(name);
      return;
    }
    const gauge =
      (this.registry.getSingleMetric(name) as Gauge | undefined) ??
      new Gauge({
        name,
        help: 'Media assets with no team, at the last successful read.',
        registers: [this.registry],
      });
    gauge.set(count);
  }

  recordJob(job: string, result: string): void {
    const normalizedJob = bounded(job, JOBS);
    const normalizedResult = bounded(result, JOB_RESULTS);
    this.jobs.inc({ job: normalizedJob, result: normalizedResult });
    if (normalizedResult === 'success') {
      this.jobLastSuccess.set({ job: normalizedJob }, Date.now() / 1000);
    }
  }

  recordRecipeExpansion(result: string): void {
    this.recipeExpansions.inc({
      result: bounded(result, RECIPE_EXPANSION_RESULTS),
    });
  }

  recordRecipeDelete(result: string): void {
    this.recipeDeletes.inc({ result: bounded(result, RECIPE_DELETE_RESULTS) });
  }

  recordRecipeRebuild(result: string): void {
    this.recipeRebuilds.inc({
      result: bounded(result, RECIPE_REBUILD_RESULTS),
    });
  }

  recordMediaLabelAssignment(result: string): void {
    this.mediaLabelAssignments.inc({
      result: bounded(result, MEDIA_LABEL_ASSIGNMENT_RESULTS),
    });
  }

  recordArtistLabelWrite(result: string): void {
    this.artistLabelWrites.inc({
      result: bounded(result, new Set<string>(ARTIST_LABEL_WRITE_RESULTS)),
    });
  }

  recordOperatorChangeRecord(target: string, result: string): void {
    this.operatorChangeRecords.inc({
      target: bounded(target, OPERATOR_CHANGE_TARGETS),
      result: bounded(result, OPERATOR_CHANGE_RESULTS),
    });
  }

  recordProgramTeamCheck(
    result: 'refused' | 'unowned' | 'lookup-failed',
  ): void {
    this.programTeamChecks.inc({
      result: bounded(result, PROGRAM_TEAM_CHECK_RESULTS),
    });
  }

  recordSceneAssetScopeRefusal(reason: SceneAssetScopeReason): void {
    this.sceneAssetScopeRefusals.inc({
      reason: bounded(reason, SCENE_ASSET_SCOPE_REASONS),
    });
  }

  recordSceneHandoff(result: string): void {
    this.sceneHandoffs.inc({ result: bounded(result, SCENE_HANDOFF_RESULTS) });
  }

  recordPreference(action: string, result: string): void {
    this.preferenceOperations.inc({
      action: bounded(action, PREFERENCE_ACTIONS),
      result: bounded(result, PREFERENCE_RESULTS),
    });
  }

  recordBroadcastDestination(action: string, result: string): void {
    const actions = new Set([
      'reload',
      'start',
      'stop',
      'command',
      'ingest',
      'create',
      'replace_key',
      'retire_secret',
      'restore_secret',
      'test',
    ]);
    const results = new Set(['succeeded', 'failed', 'conflict']);
    this.broadcastDestinationOperations.inc({
      action: bounded(action, actions),
      result: bounded(result, results),
    });
  }

  recordAuthRefusal(reason: string): void {
    if (!(AUTH_REFUSAL_REASONS as readonly string[]).includes(reason)) return;
    this.authRefusals.inc({ reason });
  }

  recordPompeiiChannelReset(reason: string): void {
    if (
      !(POMPEII_CHANNEL_RESET_METRIC_REASONS as readonly string[]).includes(
        reason,
      )
    )
      return;
    this.pompeiiChannelResets.inc({ reason });
  }

  recordAccessRequest(route: string, result: string, seconds: number): void {
    if (
      !(ACCESS_METRIC_ROUTES as readonly string[]).includes(route) ||
      !(ACCESS_METRIC_RESULTS as readonly string[]).includes(result)
    )
      return;
    this.accessRequests.inc({ route, result });
    this.accessDuration.observe({ route }, Math.max(0, seconds));
  }

  recordPalazzoMetricsScrape(result: string, seconds: number): void {
    if (!(PALAZZO_METRICS_SCRAPE_RESULTS as readonly string[]).includes(result))
      return;
    this.palazzoMetricsScrapes.inc({ result });
    this.palazzoMetricsScrapeDuration.observe(Math.max(0, seconds));
  }

  /** One MCP sign-in step; any value outside the closed sets is not counted. */
  recordMcpOAuth(step: string, result: string): void {
    if (
      !(MCP_OAUTH_METRIC_STEPS as readonly string[]).includes(step) ||
      !(MCP_OAUTH_METRIC_RESULTS as readonly string[]).includes(result)
    )
      return;
    this.mcpOAuth.inc({ step, result });
  }

  recordMcpAuth(result: string): void {
    if (!(MCP_AUTH_METRIC_RESULTS as readonly string[]).includes(result))
      return;
    this.mcpAuth.inc({ result });
  }

  /** The registered MCP spec names: the only values the tool label may take. */
  registerMcpTools(names: readonly string[]): void {
    this.mcpToolNames = new Set(names);
  }

  recordMcpRequest(tool: string, tier: string, result: string): void {
    this.mcpRequests.inc({
      tool: bounded(tool, this.mcpToolNames),
      tier: bounded(tier, MCP_REQUEST_METRIC_TIERS),
      result: (MCP_REQUEST_METRIC_RESULTS as readonly string[]).includes(result)
        ? result
        : 'unavailable',
    });
  }

  recordOutboundFetch(path: string, result: string): void {
    if (
      !(OUTBOUND_FETCH_PATHS as readonly string[]).includes(path) ||
      !(OUTBOUND_FETCH_RESULTS as readonly string[]).includes(result)
    )
      return;
    this.outboundFetches.inc({ path, result });
  }

  recordExternalSource(action: string, result: string): void {
    this.sourceOperations.inc({
      action: bounded(action, SOURCE_ACTIONS),
      result: bounded(result, SOURCE_RESULTS),
    });
  }

  setExternalSourceInventory(
    rows: Array<{ transport: string; lifecycle: string; count: number }>,
  ): void {
    this.sourceInventory.reset();
    for (const row of rows) {
      this.sourceInventory.set(
        {
          transport: bounded(
            row.transport,
            new Set(['rtmp', 'whip', 'hls', 'srt']),
          ),
          lifecycle: bounded(
            row.lifecycle,
            new Set([
              'unconfigured',
              'provisioning',
              'waiting',
              'connected',
              'degraded',
              'reconnecting',
              'offline',
              'revoked',
            ]),
          ),
        },
        Math.max(0, row.count),
      );
    }
  }

  recordWebrtcJoin(client: WebrtcClient, result: WebrtcJoinResult): void {
    this.webrtcJoins.inc({ client, result });
  }

  recordWebrtcIcePath(client: WebrtcClient, path: WebrtcIcePath): void {
    this.webrtcIcePaths.inc({ client, path });
  }

  recordWebrtcDrops(count: number): void {
    this.webrtcDrops.inc(count);
  }

  recordWebrtcRoomAdmissionRemoval(): void {
    this.webrtcRoomAdmissionRemovals.inc();
  }

  recordReturnRouterPoll(result: ReturnRouterPollResult): void {
    this.returnRouterPolls.labels(result).inc();
    if (result === 'ok') this.returnRunnerLastPoll.set(Date.now() / 1000);
  }

  setReturnRouters(wanted: number, running: number): void {
    this.returnRoutersWanted.set(wanted);
    this.returnRoutersRunning.set(running);
  }

  setPlayoutLeaseState(state: 'standby' | 'active'): void {
    this.playoutLease.labels('standby').set(state === 'standby' ? 1 : 0);
    this.playoutLease.labels('active').set(state === 'active' ? 1 : 0);
  }

  recordPlayoutLeaseLost(): void {
    this.playoutLeaseLost.inc();
  }

  recordPlayoutActivation(seconds: number): void {
    this.playoutActivation.observe(seconds);
  }

  recordPlayoutHold(result: PlayoutHoldResult, seconds: number): void {
    this.playoutHeld.labels(result).inc();
    this.playoutHold.observe(seconds);
  }

  recordReturnAudioTicket(result: ReturnAudioTicketResult): void {
    this.returnAudioTickets.labels(result).inc();
  }

  recordGuestCue(cue: GuestCue): void {
    this.guestCues.labels(cue).inc();
  }

  setOnAirGuests(count: number): void {
    this.onAirGuests.set(count);
  }

  recordProgramSseConnection(delta: 1 | -1): void {
    this.programSseConnections.inc(delta);
  }

  recordProgramSseSnapshot(result: string): void {
    this.programSseSnapshots.inc({
      result: bounded(result, PROGRAM_SSE_SNAPSHOT_RESULTS),
    });
  }

  recordFillerPreparation(
    leg: (typeof FILLER_LEGS)[number],
    result: FillerPreparationResult,
  ): void {
    this.fillerPreparations.inc({ leg, result });
  }

  recordFillerRelease(
    leg: (typeof FILLER_LEGS)[number],
    result: (typeof FILLER_RELEASE_RESULTS)[number],
  ): void {
    this.fillerReleases.inc({ leg, result });
  }

  recordFillerStartBinding(result: FillerStartBindingResult): void {
    this.fillerStartBindings.inc({ result });
  }

  recordAlanaLiveProfileUnknownKey(): void {
    this.alanaLiveProfileUnknownKeys.inc();
  }

  recordProgramTemplateUnknown(member: ProgramTemplateUnknownMember): void {
    this.programTemplateUnknowns.inc({ member });
  }

  recordPlayingTrackCoverLookup(result: PlayingTrackCoverLookupResult): void {
    this.playingTrackCoverLookups.inc({ result });
  }

  recordRecordingCommand(action: string, result: string): void {
    this.recordingCommands.inc({
      action: bounded(action, RECORDING_ACTIONS),
      result: bounded(result, RECORDING_RESULTS),
    });
  }

  recordRecordingStatus(state: string, result: string): void {
    this.recordingReconciliations.inc({
      state: bounded(state, RECORDING_STATES),
      result: bounded(result, RECORDING_RESULTS),
    });
  }

  /**
   * gaulatti/alcantara#122: the two counts that gate the radio's song scoping. The gauges exist only while
   * there is a value, because an unlabelled gauge would otherwise be scraped as 0 before anything was read.
   */
  setRadioScopePreflight(
    counts: {
      radioProgramsWithoutTeam: number;
      librarySongsWithoutTeam: number;
    } | null,
  ): void {
    for (const [name, help, value] of [
      [
        'alcantara_radio_programs_without_team',
        'Radio programs with no team, at the last successful read.',
        counts?.radioProgramsWithoutTeam,
      ],
      [
        'alcantara_library_songs_without_team',
        'Library songs with no team, at the last successful read.',
        counts?.librarySongsWithoutTeam,
      ],
    ] as const) {
      if (value === undefined) {
        this.registry.removeSingleMetric(name);
        continue;
      }
      const gauge =
        (this.registry.getSingleMetric(name) as Gauge | undefined) ??
        new Gauge({ name, help, registers: [this.registry] });
      gauge.set(value);
    }
  }

  async render(radioMetrics: string): Promise<string> {
    const managed = await this.registry.metrics();
    return `${managed.trimEnd()}\n${radioMetrics.trimStart()}`;
  }
}
