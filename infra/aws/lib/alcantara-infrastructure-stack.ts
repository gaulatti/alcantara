import {
  Arn,
  ArnFormat,
  CfnOutput,
  Duration,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import {
  ARecord,
  CnameRecord,
  HostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { AlcantaraInfrastructureConfig } from "./config";
import { createGitHubDeployRole } from "./github-deploy";

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
      "CumulusHostRole",
      config.serviceHostRoleArn,
      { mutable: true },
    );
    const mediaBucket = Bucket.fromBucketName(
      this,
      "MediaBucket",
      config.mediaBucketName,
    );
    const hostPolicy = new Policy(this, "AlcantaraCumulusHostPolicy", {
      policyName: "alcantara-cumulus-host",
      statements: [
        new PolicyStatement({
          actions: [
            "s3:Abort*",
            "s3:DeleteObject*",
            "s3:GetBucket*",
            "s3:GetObject*",
            "s3:List*",
            "s3:PutObject",
            "s3:PutObjectLegalHold",
            "s3:PutObjectRetention",
            "s3:PutObjectTagging",
            "s3:PutObjectVersionTagging",
          ],
          resources: [mediaBucket.bucketArn, `${mediaBucket.bucketArn}/*`],
        }),
        // gaulatti/alcantara#384: the destination secrets the backend writes (#376), and nothing else. RestoreSecret
        // cancels the scheduled deletion of a destination that is restored.
        new PolicyStatement({
          actions: [
            "secretsmanager:CreateSecret",
            "secretsmanager:PutSecretValue",
            "secretsmanager:GetSecretValue",
            "secretsmanager:DeleteSecret",
            "secretsmanager:DescribeSecret",
            "secretsmanager:RestoreSecret",
          ],
          resources: [
            Arn.format(
              {
                service: "secretsmanager",
                resource: "secret",
                resourceName: "alcantara/destinations/*",
                arnFormat: ArnFormat.COLON_RESOURCE_NAME,
              },
              this,
            ),
          ],
        }),
      ],
    });
    hostPolicy.attachToRole(hostRole);

    const zone = HostedZone.fromHostedZoneAttributes(this, "HostedZone", {
      hostedZoneId: config.hostedZoneId,
      zoneName: "gaulatti.com",
    });
    new ARecord(this, "ApiRecord", {
      zone,
      recordName: "api.alcantara",
      target: RecordTarget.fromIpAddresses(config.serviceHostIp),
      ttl: Duration.minutes(5),
    });
    // gaulatti/alcantara#354: production LiveKit runs on Helix. The alias follows
    // helix.gaulatti.com, so a change of Helix's address needs no change here.
    new CnameRecord(this, "LivekitRecord", {
      zone,
      recordName: "livekit.alcantara",
      domainName: "helix.gaulatti.com",
      ttl: Duration.minutes(5),
    });

    const runtimeConfigSecretArn = Arn.format(
      {
        service: "secretsmanager",
        resource: "secret",
        resourceName: "broadcast/production/config-*",
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      },
      this,
    );
    const githubDeployRole = createGitHubDeployRole(
      this,
      runtimeConfigSecretArn,
    );
    new CfnOutput(this, "GitHubDeployRoleArn", {
      value: githubDeployRole.roleArn,
    });
  }
}
