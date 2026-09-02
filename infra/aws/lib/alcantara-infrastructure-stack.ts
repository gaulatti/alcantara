import { CfnOutput, Duration, Stack, StackProps } from 'aws-cdk-lib';
import { Role } from 'aws-cdk-lib/aws-iam';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { AlcantaraInfrastructureConfig } from './config';
import { createGitHubDeployRole } from './github-deploy';

export interface AlcantaraInfrastructureStackProps extends StackProps {
  readonly config: AlcantaraInfrastructureConfig;
}

export class AlcantaraInfrastructureStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: AlcantaraInfrastructureStackProps,
  ) {
    super(scope, id, props);

    const { config } = props;
    const hostRole = Role.fromRoleArn(
      this,
      'CumulusHostRole',
      config.serviceHostRoleArn,
      { mutable: true },
    );
    Bucket.fromBucketName(
      this,
      'MediaBucket',
      config.mediaBucketName,
    ).grantReadWrite(hostRole);
    LogGroup.fromLogGroupName(
      this,
      'BackendLogGroup',
      '/services/alcantara',
    ).grantWrite(hostRole);

    const zone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: 'gaulatti.com',
    });
    new ARecord(this, 'ApiRecord', {
      zone,
      recordName: 'api.alcantara',
      target: RecordTarget.fromIpAddresses(config.serviceHostIp),
      ttl: Duration.minutes(5),
    });

    const githubDeployRole = createGitHubDeployRole(this);
    new CfnOutput(this, 'GitHubDeployRoleArn', {
      value: githubDeployRole.roleArn,
    });
  }
}
