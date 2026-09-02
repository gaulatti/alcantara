import { CfnOutput, Duration, Stack, StackProps } from "aws-cdk-lib";
import { Policy, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
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
    const backendLogGroup = LogGroup.fromLogGroupName(
      this,
      "BackendLogGroup",
      "/services/alcantara",
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
        new PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [backendLogGroup.logGroupArn],
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

    const githubDeployRole = createGitHubDeployRole(this);
    new CfnOutput(this, "GitHubDeployRoleArn", {
      value: githubDeployRole.roleArn,
    });
  }
}
