import { getApiBaseUrl } from './apiBaseUrl';

export type ProgramRealtimeRole = 'program' | 'control';

export function getProgramRealtimeSocketUrl(
  programId: string,
  role: ProgramRealtimeRole,
): string {
  const socketUrl = new URL('/program/ws', getApiBaseUrl());
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  socketUrl.searchParams.set('programId', programId);
  socketUrl.searchParams.set('role', role);
  return socketUrl.toString();
}
