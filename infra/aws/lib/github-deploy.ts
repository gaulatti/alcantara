import { Arn, ArnFormat, Stack } from 'aws-cdk-lib';
import {
  Effect,
  FederatedPrincipal,
  OpenIdConnectProvider,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export const createGitHubDeployRole = (scope: Construct): Role => {
  const stack = Stack.of(scope);
  const provider = OpenIdConnectProvider.fromOpenIdConnectProviderArn(
    scope,
    'GitHubProvider',
    `arn:${stack.partition}:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`,
  );
  const role = new Role(scope, 'GitHubDeployRole', {
    roleName: 'alcantara-github-deploy',
    assumedBy: new FederatedPrincipal(
      provider.openIdConnectProviderArn,
      {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub':
            'repo:gaulatti/alcantara:ref:refs/heads/main',
        },
      },
      'sts:AssumeRoleWithWebIdentity',
    ),
  });

  role.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: [
        Arn.format(
          {
            service: 'ssm',
            account: '',
            resource: 'document',
            resourceName: 'AWS-RunShellScript',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          },
          stack,
        ),
      ],
    }),
  );
  role.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: [
        Arn.format(
          {
            service: 'ec2',
            resource: 'instance',
            resourceName: '*',
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          },
          stack,
        ),
      ],
      conditions: {
        StringEquals: { 'ssm:resourceTag/Name': 'macondo-services' },
      },
    }),
  );
  role.addToPolicy(
    new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ec2:DescribeInstances', 'ssm:GetCommandInvocation'],
      resources: ['*'],
    }),
  );
  return role;
};
