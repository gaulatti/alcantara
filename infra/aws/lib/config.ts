export interface AlcantaraInfrastructureConfig {
  readonly hostedZoneId: string;
  readonly mediaBucketName: string;
  readonly serviceHostIp: string;
  readonly serviceHostRoleArn: string;
}

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AlcantaraInfrastructureConfig => ({
  hostedZoneId: required(environment, 'HOSTED_ZONE_ID'),
  mediaBucketName: required(environment, 'MEDIA_BUCKET_NAME'),
  serviceHostIp: required(environment, 'SERVICE_HOST_IP'),
  serviceHostRoleArn: required(environment, 'SERVICE_HOST_ROLE_ARN'),
});
