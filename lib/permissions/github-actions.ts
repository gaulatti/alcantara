import { CfnOutput, Stack } from 'aws-cdk-lib';
import { CfnAccessKey, User } from 'aws-cdk-lib/aws-iam';

const createGitHubActionsPermissions = (stack: Stack) => {
  /**
   * Create an IAM user for Github Actions
   */
  const githubActionsUser = new User(stack, `${stack.stackName}GithubActionsUser`, {
    userName: `${stack.stackName.toLowerCase()}-github-actions-user`,
  });

  /**
   * Create an access key for the IAM user
   */
  const accessKey = new CfnAccessKey(stack, `${stack.stackName}GithubActionsAccessKey`, {
    userName: githubActionsUser.userName,
  });

  /**
   * Output the access key ID and secret access key
   */
  new CfnOutput(stack, `${stack.stackName}GithubActionsAccessKeyId`, { value: accessKey.ref, description: 'GithubActions/Key' });
  new CfnOutput(stack, `${stack.stackName}GithubActionsSecretAccessKey`, { value: accessKey.attrSecretAccessKey, description: 'GithubActions/Secret' });

  return { githubActionsUser };
};

export { createGitHubActionsPermissions };
