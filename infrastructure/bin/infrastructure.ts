#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IdpApplication100320251835Stack } from '../lib/idp-application-100320251835-stack';

const app = new cdk.App();
new IdpApplication100320251835Stack(app, 'IdpApplication100320251835Stack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});