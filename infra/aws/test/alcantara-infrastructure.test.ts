import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AlcantaraInfrastructureStack } from "../lib/alcantara-infrastructure-stack";

const template = (): Template => {
  const app = new App();
  return Template.fromStack(
    new AlcantaraInfrastructureStack(app, "AlcantaraInfrastructureStack", {
      config: {
        hostedZoneId: "Z00000000000000000000",
        mediaBucketName: "example-alcantara-assets",
        serviceHostIp: "203.0.113.10",
        serviceHostRoleArn:
          "arn:aws:iam::123456789012:role/macondo-service-host",
      },
      env: { account: "123456789012", region: "us-east-1" },
    }),
  );
};

test("owns only the Alcantara application permissions needed on Cumulus", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::IAM::Policy", {
    PolicyName: "alcantara-cumulus-host",
  });
  const policies = JSON.stringify(
    Object.values(rendered.findResources("AWS::IAM::Policy")).filter(
      (resource) =>
        resource.Properties?.PolicyName === "alcantara-cumulus-host",
    ),
  );
  // The only secrets the host may touch are the destination secrets the backend writes (#384).
  const secretStatements = Object.values(
    rendered.findResources("AWS::IAM::Policy"),
  )
    .filter(
      (resource) =>
        resource.Properties?.PolicyName === "alcantara-cumulus-host",
    )
    .flatMap((resource) => resource.Properties.PolicyDocument.Statement)
    .filter((statement) =>
      JSON.stringify(statement.Action).includes("secretsmanager:"),
    );
  expect(secretStatements).toHaveLength(1);
  expect(secretStatements[0].Action).toEqual([
    "secretsmanager:CreateSecret",
    "secretsmanager:PutSecretValue",
    "secretsmanager:GetSecretValue",
    "secretsmanager:DeleteSecret",
    "secretsmanager:DescribeSecret",
    "secretsmanager:RestoreSecret",
  ]);
  expect(JSON.stringify(secretStatements[0].Resource)).toContain(
    ":secret:alcantara/destinations/*",
  );
  expect(policies).toContain("s3:PutObject");
  expect(policies).toContain("example-alcantara-assets");
  expect(policies).not.toContain("logs:");
  expect(policies).not.toContain("/services/alcantara");
  rendered.resourceCountIs("AWS::Logs::LogGroup", 0);
});

test("points the LiveKit name at Helix", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Route53::RecordSet", {
    Name: "livekit.alcantara.gaulatti.com.",
    ResourceRecords: ["helix.gaulatti.com"],
    TTL: "300",
    Type: "CNAME",
  });
  rendered.hasResourceProperties("AWS::Route53::RecordSet", {
    Name: "turn.alcantara.gaulatti.com.",
    ResourceRecords: ["helix.gaulatti.com"],
    Type: "CNAME",
  });
  rendered.resourceCountIs("AWS::Route53::RecordSet", 3);
});

test("owns the API record and main-branch deployment role", () => {
  const rendered = template();
  rendered.hasResourceProperties("AWS::Route53::RecordSet", {
    Name: "api.alcantara.gaulatti.com.",
    ResourceRecords: ["203.0.113.10"],
    TTL: "300",
    Type: "A",
  });
  rendered.hasResourceProperties("AWS::IAM::Role", {
    RoleName: "alcantara-github-deploy",
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub":
                "repo:gaulatti/alcantara:ref:refs/heads/main",
            },
          },
        }),
      ]),
    },
  });
  const policies = JSON.stringify(rendered.findResources("AWS::IAM::Policy"));
  expect(policies).toContain("ssm:SendCommand");
  expect(policies).toContain("ssm:resourceTag/Name");
  expect(policies).toContain("macondo-services");
  expect(policies).toContain("secretsmanager:GetSecretValue");
  expect(policies).toContain(
    ":secretsmanager:us-east-1:123456789012:secret:broadcast/production/config-*",
  );
  expect(policies).not.toContain("secret:*");
});
