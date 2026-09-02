#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AlcantaraInfrastructureStack } from '../lib/alcantara-infrastructure-stack';
import { loadConfig } from '../lib/config';

const app = new App();
new AlcantaraInfrastructureStack(app, 'AlcantaraInfrastructureStack', {
  config: loadConfig(),
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
