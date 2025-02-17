import * as cdk from 'aws-cdk-lib';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { ArnPrincipal, Role } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { createCNAME, createDistribution, createHostedZone, createZoneCertificate } from './network';
import { createPermissions } from './permissions';
import { createBuckets } from './storage';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Create Hosted Zone
     */
    const { hostedZone } = createHostedZone(this);

    /**
     * Create Certificate
     */
    const { certificate } = createZoneCertificate(this);

    /**
     * Create Buckets
     */
    const { frontendBucket } = createBuckets(this);

    /**
     * Creates the permissions for the GitHub Actions autobuild.
     */
    const { githubActionsUser } = createPermissions(this);

    /**
     * Storage (S3)
     */
    frontendBucket.grantReadWrite(githubActionsUser);

    /**
     * Creates an ECR repository for the service.
     */
    const repository = new Repository(this, `${this.stackName}EcrRepository`, {
      repositoryName: `${this.stackName.toLocaleLowerCase()}`,
    });
    repository.grantPullPush(githubActionsUser);

    /**
     * Log Group
     */
    new LogGroup(this, `${this.stackName}ServiceLogGroup`, {
      logGroupName: '/services/alcantara',
      retention: RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * Creates the distribution for the frontend.
     */
    const { distribution } = createDistribution(this, frontendBucket, certificate);
    distribution.grantCreateInvalidation(githubActionsUser);

    /**
     * Creates the CNAME for the distribution.
     */
    createCNAME(this, hostedZone, distribution);

    /**
     * Service Role
     */
    const serviceRole = new Role(this, `${this.stackName}ServiceRole`, {
      assumedBy: new ArnPrincipal(process.env.SERVICE_ROLE_ARN!),
      roleName: `${this.stackName}ServiceRole`,
    });
  }
}
