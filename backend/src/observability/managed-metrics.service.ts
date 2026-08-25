import { Injectable } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

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
  'stingers',
  'webrtc',
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
  'unknown',
]);
const DEPENDENCY_OPERATIONS = new Set([
  'authorize',
  'connect',
  'publish',
  'fetch',
  'read',
  'write',
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
const JOBS = new Set(['charts-refresh', 'unknown']);
const JOB_RESULTS = new Set(['success', 'failure', 'skipped', 'unknown']);

function bounded(value: string, allowed: Set<string>): string {
  return allowed.has(value) ? value : 'unknown';
}

function buildVersion(): string {
  const candidate = process.env.ALCANTARA_BUILD_VERSION ?? 'dev';
  return /^[A-Za-z0-9._-]{1,64}$/.test(candidate) ? candidate : 'unknown';
}

@Injectable()
export class ManagedMetricsService {
  readonly registry = new Registry();
  private readonly httpRequests: Counter<string>;
  private readonly httpDuration: Histogram<string>;
  private readonly dependencyOperations: Counter<string>;
  private readonly dependencyDuration: Histogram<string>;
  private readonly jobs: Counter<string>;
  private readonly jobLastSuccess: Gauge<string>;

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
    this.jobLastSuccess = new Gauge({
      name: 'alcantara_job_last_success_timestamp_seconds',
      help: 'Unix timestamp of the last successful background job run.',
      labelNames: ['job'],
      registers: [this.registry],
    });
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

  recordJob(job: string, result: string): void {
    const normalizedJob = bounded(job, JOBS);
    const normalizedResult = bounded(result, JOB_RESULTS);
    this.jobs.inc({ job: normalizedJob, result: normalizedResult });
    if (normalizedResult === 'success') {
      this.jobLastSuccess.set({ job: normalizedJob }, Date.now() / 1000);
    }
  }

  async render(radioMetrics: string): Promise<string> {
    const managed = await this.registry.metrics();
    return `${managed.trimEnd()}\n${radioMetrics.trimStart()}`;
  }
}
