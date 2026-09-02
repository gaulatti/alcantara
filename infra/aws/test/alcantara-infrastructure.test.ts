import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlcantaraInfrastructureStack } from '../lib/alcantara-infrastructure-stack';

const template = (): Template => {
  const app = new App();
  return Template.fromStack(
    new AlcantaraInfrastructureStack(app, 'AlcantaraInfrastructureStack', {
      config: {
        araucoSecretArn:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:arauco-example-AbCd12',
        hostedZoneId: 'Z00000000000000000000',
        mediaBucketName: 'example-alcantara-assets',
        serviceHostIp: '203.0.113.10',
        serviceHostRoleArn:
          'arn:aws:iam::123456789012:role/macondo-service-host',
      },
      env: { account: '123456789012', region: 'us-east-1' },
    }),
  );
};

test('owns Alcantara runtime permissions outside Macondo', () => {
  const policies = JSON.stringify(template().findResources('AWS::IAM::Policy'));
  expect(policies).toContain('secretsmanager:GetSecretValue');
  expect(policies).toContain('arauco-example');
  expect(policies).toContain('s3:PutObject');
  expect(policies).toContain('example-alcantara-assets');
  expect(policies).toContain('logs:PutLogEvents');
  expect(policies).toContain('/services/alcantara');
});

test('owns the API record and main-branch deployment role', () => {
  const rendered = template();
  rendered.hasResourceProperties('AWS::Route53::RecordSet', {
    Name: 'api.alcantara.gaulatti.com.',
    ResourceRecords: ['203.0.113.10'],
    TTL: '300',
    Type: 'A',
  });
  rendered.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'alcantara-github-deploy',
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:gaulatti/alcantara:ref:refs/heads/main',
            },
          },
        }),
      ]),
    },
  });
  const policies = JSON.stringify(rendered.findResources('AWS::IAM::Policy'));
  expect(policies).toContain('ssm:SendCommand');
  expect(policies).toContain('ssm:resourceTag/Name');
  expect(policies).toContain('macondo-services');
});
